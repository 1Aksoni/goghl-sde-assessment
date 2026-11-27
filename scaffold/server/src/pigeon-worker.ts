import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getRedis } from './redis.js';
import {
  completeReply,
  failReply,
  leaseNextReply,
  retryReply,
  type OutboundReply,
} from './state.js';

const LEASE_MS = 30_000;
const SEND_TIMEOUT_MS = 15_000;
const WORKSPACE_CAPACITY = 8;
const WORKSPACE_REFILL_PER_SECOND = 4;

const ACQUIRE_SLOT_SCRIPT = `
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill = tonumber(ARGV[3])
local cooldownUntil = tonumber(redis.call('GET', KEYS[2]) or '0')
if cooldownUntil > now then
  return {0, cooldownUntil - now}
end
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(values[1]) or capacity
local updatedAt = tonumber(values[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - updatedAt) * refill / 1000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
  return {0, math.ceil((1 - tokens) * 1000 / refill)}
end
tokens = tokens - 1
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAt', now)
return {1, 0}
`;

const SET_COOLDOWN_SCRIPT = `
local untilAt = tonumber(ARGV[1]) + tonumber(ARGV[2])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if untilAt > current then
  redis.call('SET', KEYS[1], untilAt, 'PX', tonumber(ARGV[2]) + 10000)
end
return 1
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireWorkspaceSlot(workspace: string): Promise<number> {
  const redis = getRedis();
  const keys = [
    `switchboard:pigeon:bucket:${workspace}`,
    `switchboard:pigeon:cooldown:${workspace}`,
  ];
  const result = await redis.eval(
    ACQUIRE_SLOT_SCRIPT,
    keys.length,
    ...keys,
    Date.now(),
    WORKSPACE_CAPACITY,
    WORKSPACE_REFILL_PER_SECOND,
  );
  if (!Array.isArray(result)) throw new Error('Invalid Pigeon rate limiter response');
  const [allowed, waitMs] = result.map(Number);
  return allowed === 1 ? 0 : Math.max(1, waitMs);
}

async function setWorkspaceCooldown(workspace: string, delayMs: number): Promise<void> {
  await getRedis().eval(
    SET_COOLDOWN_SCRIPT,
    1,
    `switchboard:pigeon:cooldown:${workspace}`,
    Date.now(),
    delayMs,
  );
}

function retryDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.min(attempt - 1, 5), 10_000);
}

async function deferReply(
  reply: OutboundReply,
  owner: string,
  delayMs: number,
  reason: string,
): Promise<void> {
  await retryReply(reply, owner, delayMs, reason);
}

async function sendReply(reply: OutboundReply, owner: string): Promise<void> {
  const apiKey = config.pigeon.apiKeys[reply.workspace];
  if (!apiKey) {
    await failReply(reply, owner, `No Pigeon API key configured for ${reply.workspace}`);
    return;
  }

  const response = await fetch(`${config.pigeon.url}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': reply.clientRef,
    },
    body: JSON.stringify({
      to: reply.contact,
      text: reply.text,
      client_ref: reply.clientRef,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.ceil(retryAfter * 1000)
      : 1000;
    await setWorkspaceCooldown(reply.workspace, delayMs);
    await deferReply(reply, owner, delayMs, 'Pigeon rate limited the send');
    return;
  }

  if (response.status >= 500) {
    await deferReply(reply, owner, retryDelay(reply.attempts), `Pigeon returned ${response.status}`);
    return;
  }

  if (!response.ok) {
    await failReply(reply, owner, `Pigeon rejected the send with ${response.status}`);
    return;
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    await deferReply(reply, owner, retryDelay(reply.attempts), 'Pigeon returned an invalid success response');
    return;
  }

  if (
    typeof result !== 'object' ||
    result === null ||
    !('id' in result) ||
    typeof result.id !== 'string'
  ) {
    await deferReply(reply, owner, retryDelay(reply.attempts), 'Pigeon success response did not include a message id');
    return;
  }
  await completeReply(reply, result.id);
}

async function workOnce(owner: string): Promise<boolean> {
  const reply = await leaseNextReply(owner, LEASE_MS);
  if (!reply) return false;

  const waitMs = await acquireWorkspaceSlot(reply.workspace);
  if (waitMs > 0) {
    await deferReply(reply, owner, waitMs, 'Waiting for the workspace send-rate limit');
    return true;
  }

  try {
    await sendReply(reply, owner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deferReply(reply, owner, retryDelay(reply.attempts), message);
    console.error(`Pigeon send will be retried for ${reply.workspace}/${reply.clientRef}`, error);
  }
  return true;
}

export function startPigeonWorker(): () => Promise<void> {
  const owner = randomUUID();
  let running = true;
  const loop = async () => {
    while (running) {
      try {
        const foundWork = await workOnce(owner);
        if (!foundWork) await sleep(100);
      } catch (error) {
        console.error('Pigeon worker iteration failed', error);
        await sleep(500);
      }
    }
  };
  const task = loop();
  return async () => {
    running = false;
    await task;
  };
}
