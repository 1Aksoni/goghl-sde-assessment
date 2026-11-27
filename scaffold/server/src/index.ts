import express from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { closeRedis, getRedis } from './redis.js';
import {
  ensureStorageIndexes,
  getSnapshot,
  resetApplicationData,
} from './state.js';

const app = express();
app.use(express.json());

const jsonError = (
  res: express.Response,
  status: number,
  code: string,
  message: string,
) => res.status(status).json({ error: { code, message } });

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

// A plain http server, so you can attach WebSockets to it.
const server = createServer(app);

const start = async () => {
  await ensureStorageIndexes();
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
    await Promise.allSettled([closeDb(), closeRedis()]);
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
