import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { startPigeonWorker } from './pigeon-worker.js';
import { closeRedis, getRedis } from './redis.js';
import {
  claimConversation,
  createReply,
  ensureStorageIndexes,
  getSnapshot,
  isKnownWorkspace,
  processPendingInboundWebhooks,
  processPendingStatusWebhooks,
  resetApplicationData,
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

    const envelope = webhookEnvelopeSchema.safeParse(payload);
    const workspace = z.object({ workspace: z.string().min(1) }).safeParse(payload);
    if (workspace.success && !isKnownWorkspace(workspace.data.workspace)) {
      res.sendStatus(204);
      return;
    }
    if (!envelope.success) {
      jsonError(res, 400, 'INVALID_EVENT', 'Webhook event is missing required fields');
      return;
    }

    if (
      envelope.data.type !== 'message.inbound' &&
      envelope.data.type !== 'message.status'
    ) {
      res.sendStatus(204);
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

const start = async () => {
  await ensureStorageIndexes();
  await processPendingInboundWebhooks();
  await processPendingStatusWebhooks();
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

  server.close(async () => {
    await Promise.allSettled([
      stopWorker?.(),
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
