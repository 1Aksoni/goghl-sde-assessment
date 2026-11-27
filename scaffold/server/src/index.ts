import express from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import {
  beginLogin,
  endLogin,
  finishLogin,
  getRequestSession,
  isWorkspaceMember,
  type UserSession,
} from './auth.js';
import { config } from './config.js';
import { startRealtime } from './realtime.js';
import { closeDb, getDb } from './db.js';
import { startPigeonWorker } from './pigeon-worker.js';
import { closeRedis, getRedis } from './redis.js';
import {
  claimConversation,
  createReply,
  ensureStorageIndexes,
  getConversationMessages,
  getSnapshot,
  isKnownWorkspace,
  listConversations,
  processPendingInboundWebhooks,
  processPendingStatusWebhooks,
  processPendingWorkspaceEvents,
  resetApplicationData,
  setConversationClosed,
  storeInboundWebhook,
  storeStatusWebhook,
} from './state.js';

const app = express();

const jsonError = (
  res: express.Response,
  status: number,
  code: string,
  message: string,
) => res.status(status).json({ error: { code, message } });

const webhookEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  workspace: z.string().min(1),
});

const claimSchema = z.object({
  workspace: z.string().min(1),
  contact: z.string().min(1),
  agent: z.string().min(1),
});

const replySchema = z.object({
  workspace: z.string().min(1),
  contact: z.string().min(1),
  text: z.string().min(1),
  client_ref: z.string().min(1),
});

const workspaceBodySchema = z.object({ workspace: z.string().min(1) });
const userReplySchema = z.object({
  workspace: z.string().min(1),
  text: z.string().min(1),
  client_ref: z.string().min(1).optional(),
});

function isValidPigeonSignature(
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const match = /^t=(\d+),v1=([a-fA-F0-9]{64})$/.exec(signature);
  if (!match) return false;

  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Date.now() / 1000 - timestamp > 300) {
    return false;
  }

  const expected = createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${match[1]}.`)
    .update(rawBody)
    .digest();
  const received = Buffer.from(match[2], 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

app.post(
  '/webhooks/pigeon',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      jsonError(res, 400, 'INVALID_BODY', 'Expected a raw request body');
      return;
    }

    if (!isValidPigeonSignature(rawBody, req.header('x-pigeon-signature'))) {
      jsonError(res, 401, 'INVALID_SIGNATURE', 'Invalid or expired Pigeon signature');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      jsonError(res, 400, 'INVALID_JSON', 'Webhook body is not valid JSON');
      return;
    }

    const eventType = z.object({ type: z.string() }).safeParse(payload);
    if (
      eventType.success &&
      eventType.data.type !== 'message.inbound' &&
      eventType.data.type !== 'message.status'
    ) {
      res.sendStatus(204);
      return;
    }

    const workspace = z.object({ workspace: z.string().min(1) }).safeParse(payload);
    if (workspace.success && !isKnownWorkspace(workspace.data.workspace)) {
      res.sendStatus(204);
      return;
    }
    const envelope = webhookEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      jsonError(res, 400, 'INVALID_EVENT', 'Webhook event is missing required fields');
      return;
    }

    const eventId = req.header('x-pigeon-event-id') || envelope.data.id;
    try {
      if (envelope.data.type === 'message.inbound') {
        await storeInboundWebhook(eventId, payload);
      } else {
        await storeStatusWebhook(eventId, payload);
      }
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof z.ZodError) {
        jsonError(res, 400, 'INVALID_EVENT', 'Inbound event payload is invalid');
        return;
      }
      console.error('Failed to store Pigeon webhook', error);
      jsonError(res, 503, 'WEBHOOK_STORAGE_FAILED', 'Could not safely store webhook');
    }
    },
);

app.use(express.json());

async function requireWorkspaceSession(
  req: express.Request,
  res: express.Response,
  workspace: string | undefined,
): Promise<UserSession | null> {
  let session: UserSession | null;
  try {
    session = await getRequestSession(req);
  } catch (error) {
    console.error('Could not read login session', error);
    jsonError(res, 503, 'SESSION_UNAVAILABLE', 'Login session service is unavailable');
    return null;
  }
  if (!session) {
    jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
    return null;
  }
  if (!workspace) {
    jsonError(res, 400, 'WORKSPACE_REQUIRED', 'workspace is required');
    return null;
  }
  if (!isWorkspaceMember(session, workspace)) {
    jsonError(res, 403, 'FORBIDDEN', 'You are not a member of this workspace');
    return null;
  }
  return session;
}

app.get('/auth/login', async (req, res) => {
  try {
    await beginLogin(req, res);
  } catch (error) {
    console.error('Could not start OIDC login', error);
    jsonError(res, 503, 'OIDC_UNAVAILABLE', 'Identity provider is unavailable');
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    await finishLogin(req, res);
  } catch (error) {
    console.error('OIDC callback failed', error);
    jsonError(res, 502, 'OIDC_CALLBACK_FAILED', 'Could not complete login');
  }
});

app.post('/auth/logout', async (req, res) => {
  try {
    await endLogin(req, res);
  } catch (error) {
    console.error('Could not end login session', error);
    jsonError(res, 503, 'SESSION_UNAVAILABLE', 'Could not end login session');
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const session = await getRequestSession(req);
    if (!session) {
      jsonError(res, 401, 'UNAUTHORIZED', 'Login required');
      return;
    }
    res.json({
      sub: session.sub,
      workspaces: session.workspaces,
    });
  } catch (error) {
    console.error('Could not read login session', error);
    jsonError(res, 503, 'SESSION_UNAVAILABLE', 'Login session service is unavailable');
  }
});

app.get('/api/conversations', async (req, res) => {
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : undefined;
  if (!(await requireWorkspaceSession(req, res, workspace))) return;
  const parsedLimit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    jsonError(res, 400, 'INVALID_LIMIT', 'limit must be a positive integer');
    return;
  }

  let before: { lastActivityAt: Date; contact: string } | undefined;
  if (typeof req.query.before === 'string') {
    try {
      const cursor = z.object({
        lastActivityAt: z.string().datetime({ offset: true }),
        contact: z.string().min(1),
      }).parse(JSON.parse(Buffer.from(req.query.before, 'base64url').toString('utf8')));
      before = { lastActivityAt: new Date(cursor.lastActivityAt), contact: cursor.contact };
    } catch {
      jsonError(res, 400, 'INVALID_CURSOR', 'before cursor is invalid');
      return;
    }
  }

  try {
    const limit = Math.min(parsedLimit, 100);
    const records = await listConversations(workspace!, limit + 1, before);
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;
    const last = page.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({
          lastActivityAt: (last.lastActivityAt ?? last.updatedAt).toISOString(),
          contact: last.contact,
        })).toString('base64url')
      : null;
    res.json({
      conversations: page.map((conversation) => ({
        contact: conversation.contact,
        assignee: conversation.assignee ?? null,
        closed: conversation.closed,
        lastActivityAt: (conversation.lastActivityAt ?? conversation.updatedAt).toISOString(),
        inboundCount: conversation.inbound.length,
      })),
      nextCursor,
    });
  } catch (error) {
    console.error('Could not list conversations', error);
    jsonError(res, 503, 'CONVERSATIONS_UNAVAILABLE', 'Could not load conversations');
  }
});

app.get('/api/conversations/:contact/messages', async (req, res) => {
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : undefined;
  if (!(await requireWorkspaceSession(req, res, workspace))) return;
  try {
    const result = await getConversationMessages(workspace!, req.params.contact);
    if (!result) {
      jsonError(res, 404, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist');
      return;
    }
    res.json({
      contact: result.conversation.contact,
      assignee: result.conversation.assignee ?? null,
      closed: result.conversation.closed,
      messages: result.messages,
    });
  } catch (error) {
    console.error('Could not load conversation messages', error);
    jsonError(res, 503, 'MESSAGES_UNAVAILABLE', 'Could not load conversation messages');
  }
});

app.post('/api/conversations/:contact/claim', async (req, res) => {
  const body = workspaceBodySchema.safeParse(req.body);
  if (!body.success) {
    jsonError(res, 400, 'INVALID_REQUEST', 'workspace is required');
    return;
  }
  const session = await requireWorkspaceSession(req, res, body.data.workspace);
  if (!session) return;
  try {
    if (!(await claimConversation(body.data.workspace, req.params.contact, session.sub))) {
      jsonError(res, 409, 'CONVERSATION_CLAIMED', 'Conversation is held by another agent');
      return;
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Could not claim conversation', error);
    jsonError(res, 503, 'CLAIM_FAILED', 'Could not claim conversation');
  }
});

app.post('/api/conversations/:contact/reply', async (req, res) => {
  const body = userReplySchema.safeParse(req.body);
  if (!body.success) {
    jsonError(res, 400, 'INVALID_REQUEST', 'workspace and text are required');
    return;
  }
  if (!(await requireWorkspaceSession(req, res, body.data.workspace))) return;
  const clientRef = req.header('idempotency-key') ?? body.data.client_ref ?? randomUUID();
  try {
    await createReply(body.data.workspace, req.params.contact, body.data.text, clientRef);
    res.status(202).json({ client_ref: clientRef, status: 'queued' });
  } catch (error) {
    console.error('Could not store conversation reply', error);
    jsonError(res, 503, 'REPLY_STORAGE_FAILED', 'Could not safely store reply');
  }
});

for (const [path, closed] of [['close', true], ['reopen', false]] as const) {
  app.post(`/api/conversations/:contact/${path}`, async (req, res) => {
    const body = workspaceBodySchema.safeParse(req.body);
    if (!body.success) {
      jsonError(res, 400, 'INVALID_REQUEST', 'workspace is required');
      return;
    }
    if (!(await requireWorkspaceSession(req, res, body.data.workspace))) return;
    try {
      if (!(await setConversationClosed(body.data.workspace, req.params.contact, closed))) {
        jsonError(res, 404, 'CONVERSATION_NOT_FOUND', 'Conversation does not exist');
        return;
      }
      res.sendStatus(200);
    } catch (error) {
      console.error(`Could not ${path} conversation`, error);
      jsonError(res, 503, 'CONVERSATION_UPDATE_FAILED', 'Could not update conversation');
    }
  });
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/ready', async (_req, res) => {
  try {
    await Promise.all([
      getDb().then((db) => db.command({ ping: 1 })),
      getRedis().ping(),
    ]);
    res.json({ ok: true });
  } catch (error) {
    jsonError(res, 503, 'NOT_READY', 'MongoDB or Redis is unavailable');
  }
});

const requireGraderToken = (
  req: express.Request,
  res: express.Response,
): boolean => {
  if (req.header('x-grader-token') !== config.graderToken) {
    jsonError(res, 401, 'UNAUTHORIZED', 'Invalid grader token');
    return false;
  }
  return true;
};

app.post('/__grader/reset', async (_req, res) => {
  if (!requireGraderToken(_req, res)) return;
  try {
    await resetApplicationData();
    res.json({ ok: true });
  } catch (error) {
    jsonError(res, 503, 'RESET_FAILED', 'Could not reset application data');
  }
});

app.get('/__grader/snapshot', async (req, res) => {
  if (!requireGraderToken(req, res)) return;
  try {
    res.json(await getSnapshot());
  } catch (error) {
    jsonError(res, 503, 'SNAPSHOT_FAILED', 'Could not read application state');
  }
});

app.post('/__grader/claim', async (req, res) => {
  if (!requireGraderToken(req, res)) return;
  const input = claimSchema.safeParse(req.body);
  if (!input.success) {
    jsonError(res, 400, 'INVALID_REQUEST', 'workspace, contact, and agent are required');
    return;
  }
  if (!isKnownWorkspace(input.data.workspace)) {
    jsonError(res, 400, 'UNKNOWN_WORKSPACE', 'Workspace does not exist');
    return;
  }

  try {
    const claimed = await claimConversation(
      input.data.workspace,
      input.data.contact,
      input.data.agent,
    );
    if (claimed) {
      res.sendStatus(200);
    } else {
      jsonError(res, 409, 'CONVERSATION_CLAIMED', 'Conversation is held by another agent');
    }
  } catch (error) {
    console.error('Failed to claim conversation', error);
    jsonError(res, 503, 'CLAIM_FAILED', 'Could not claim conversation');
  }
});

app.post('/__grader/reply', async (req, res) => {
  if (!requireGraderToken(req, res)) return;
  const input = replySchema.safeParse(req.body);
  if (!input.success) {
    jsonError(
      res,
      400,
      'INVALID_REQUEST',
      'workspace, contact, text, and client_ref are required',
    );
    return;
  }
  if (!isKnownWorkspace(input.data.workspace)) {
    jsonError(res, 400, 'UNKNOWN_WORKSPACE', 'Workspace does not exist');
    return;
  }

  try {
    await createReply(
      input.data.workspace,
      input.data.contact,
      input.data.text,
      input.data.client_ref,
    );
    res.sendStatus(202);
  } catch (error) {
    console.error('Failed to store grader reply', error);
    jsonError(res, 503, 'REPLY_STORAGE_FAILED', 'Could not safely store reply');
  }
});

// A plain http server, so you can attach WebSockets to it.
const server = createServer(app);
let stopWorker: (() => Promise<void>) | undefined;
let stopRealtime: (() => Promise<void>) | undefined;

const start = async () => {
  await ensureStorageIndexes();
  await processPendingInboundWebhooks();
  await processPendingStatusWebhooks();
  await processPendingWorkspaceEvents();
  stopRealtime = await startRealtime(server);
  stopWorker = startPigeonWorker();
  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });
};

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);

  const realtimeShutdown = stopRealtime?.();
  server.close(async () => {
    await Promise.allSettled([
      stopWorker?.(),
      realtimeShutdown,
      closeDb(),
      closeRedis(),
    ]);
    process.exit(0);
  });

  setTimeout(() => {
    void Promise.allSettled([closeDb(), closeRedis()]);
    process.exit(1);
  }, 5_000).unref();
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

void start().catch((error) => {
  console.error(error);
  process.exit(1);
});
