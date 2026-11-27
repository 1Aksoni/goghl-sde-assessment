import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  getSessionFromCookieHeader,
  isWorkspaceMember,
} from './auth.js';
import { readWorkspaceEvents, workspaceEventChannel, type WorkspaceFrame } from './events.js';
import { getRedis } from './redis.js';
import { isKnownWorkspace, KNOWN_WORKSPACES } from './state.js';

interface SocketClient {
  socket: WebSocket;
  workspace: string;
  lastSent: number;
  replaying: boolean;
  pending: WorkspaceFrame[];
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request';
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
  socket.destroy();
}

export async function startRealtime(server: Server): Promise<() => Promise<void>> {
  const websocketServer = new WebSocketServer({ noServer: true });
  const clients = new Map<string, Set<SocketClient>>();
  const workspaceByChannel = new Map(
    KNOWN_WORKSPACES.map((workspace) => [workspaceEventChannel(workspace), workspace]),
  );
  const subscriber = getRedis().duplicate();

  subscriber.on('error', (error) => {
    console.error('Workspace event subscriber error', error);
  });
  subscriber.on('message', (channel, rawFrame) => {
    const workspace = workspaceByChannel.get(channel);
    if (!workspace) return;
    let frame: WorkspaceFrame;
    try {
      frame = JSON.parse(rawFrame) as WorkspaceFrame;
    } catch (error) {
      console.error('Ignoring malformed workspace event frame', error);
      return;
    }

    for (const client of clients.get(workspace) ?? []) {
      if (client.replaying) {
        client.pending.push(frame);
      } else {
        sendFrame(client, frame);
      }
    }
  });
  await subscriber.subscribe(...workspaceByChannel.keys());

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        rejectUpgrade(socket, 400, 'Invalid WebSocket URL');
        return;
      }
      if (url.pathname !== '/ws') {
        rejectUpgrade(socket, 400, 'Unknown WebSocket path');
        return;
      }

      const workspace = url.searchParams.get('workspace');
      if (!workspace || !isKnownWorkspace(workspace)) {
        rejectUpgrade(socket, 403, 'Workspace access denied');
        return;
      }
      const afterValue = url.searchParams.get('after');
      const after = afterValue === null ? 0 : Number(afterValue);
      if (!Number.isSafeInteger(after) || after < 0) {
        rejectUpgrade(socket, 400, 'Invalid event sequence');
        return;
      }

      let session;
      try {
        session = await getSessionFromCookieHeader(req.headers.cookie);
      } catch (error) {
        console.error('Could not read WebSocket session', error);
        rejectUpgrade(socket, 503, 'Session service unavailable');
        return;
      }
      if (!session) {
        rejectUpgrade(socket, 401, 'Login required');
        return;
      }
      if (!isWorkspaceMember(session, workspace)) {
        rejectUpgrade(socket, 403, 'Workspace access denied');
        return;
      }

      websocketServer.handleUpgrade(req, socket, head, (websocket) => {
        const client: SocketClient = {
          socket: websocket,
          workspace,
          lastSent: after,
          replaying: true,
          pending: [],
        };
        const workspaceClients = clients.get(workspace) ?? new Set<SocketClient>();
        workspaceClients.add(client);
        clients.set(workspace, workspaceClients);
        websocket.on('close', () => {
          workspaceClients.delete(client);
          if (workspaceClients.size === 0) clients.delete(workspace);
        });
        void replayMissedEvents(client);
      });
    })().catch((error: unknown) => {
      console.error('WebSocket upgrade failed', error);
      if (!socket.destroyed) rejectUpgrade(socket, 503, 'WebSocket service unavailable');
    });
  };

  server.on('upgrade', onUpgrade);

  return async () => {
    server.off('upgrade', onUpgrade);
    for (const workspaceClients of clients.values()) {
      for (const client of workspaceClients) client.socket.close(1001, 'Server shutting down');
    }
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    subscriber.disconnect();
  };
}

function sendFrame(client: SocketClient, frame: WorkspaceFrame): void {
  if (frame.seq <= client.lastSent || client.socket.readyState !== WebSocket.OPEN) return;
  client.socket.send(JSON.stringify(frame));
  client.lastSent = frame.seq;
}

async function replayMissedEvents(client: SocketClient): Promise<void> {
  try {
    const replay = await readWorkspaceEvents(client.workspace, client.lastSent);
    for (const frame of replay) sendFrame(client, frame);
    client.replaying = false;
    client.pending.sort((left, right) => left.seq - right.seq);
    for (const frame of client.pending) sendFrame(client, frame);
    client.pending = [];
  } catch (error) {
    console.error('Could not replay workspace events', error);
    client.socket.close(1011, 'Could not replay events');
  }
}
