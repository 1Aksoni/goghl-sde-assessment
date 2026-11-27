import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // The defaults in the server config are sufficient when no .env exists.
}

const mongoUrl = new URL(
  process.env.MONGO_URL ?? 'mongodb://localhost:27017/switchboard',
);
mongoUrl.pathname = `/switchboard_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
process.env.MONGO_URL = mongoUrl.toString();

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const configuredRedisDb = Number(redisUrl.pathname.slice(1) || '0');
redisUrl.pathname = `/${configuredRedisDb === 15 ? 14 : 15}`;
process.env.REDIS_URL = redisUrl.toString();

const { closeDb, getDb } = await import('../src/db.js');
const { closeRedis, getRedis } = await import('../src/redis.js');
const {
  claimConversation,
  collections,
  createReply,
  ensureStorageIndexes,
  getConversationMessages,
  storeInboundWebhook,
  storeStatusWebhook,
} = await import('../src/state.js');

const testEventKeys = [
  'switchboard:{ws_acme}:events',
  'switchboard:{ws_acme}:event-dedupe',
  'switchboard:{ws_acme}:event-seq',
];

before(async () => {
  await ensureStorageIndexes();
  await getRedis().ping();
  await getRedis().del(...testEventKeys);
});

after(async () => {
  try {
    await (await getDb()).dropDatabase();
    await getRedis().del(...testEventKeys);
  } finally {
    await closeDb();
    await closeRedis();
  }
});

test('only one concurrent agent claim wins', async () => {
  const contact = `claim-${randomUUID()}`;
  const agents = [`agent-${randomUUID()}`, `agent-${randomUUID()}`];
  const outcomes = await Promise.all(
    agents.map((agent) => claimConversation('ws_acme', contact, agent)),
  );

  assert.deepEqual(outcomes.map((won) => won ? 200 : 409).sort(), [200, 409]);
  const winnerIndex = outcomes.findIndex(Boolean);
  const { conversations } = await collections();
  const conversation = await conversations.findOne({ workspace: 'ws_acme', contact });
  assert.equal(conversation?.assignee, agents[winnerIndex]);
  assert.equal(await claimConversation('ws_acme', contact, agents[winnerIndex]), true);
});

test('duplicate inbound events apply once and messages read oldest first', async () => {
  const contact = `inbound-${randomUUID()}`;
  const earlierId = `pmsg-${randomUUID()}`;
  const laterId = `pmsg-${randomUUID()}`;
  const laterEvent = {
    id: `evt-${randomUUID()}`,
    type: 'message.inbound',
    workspace: 'ws_acme',
    occurred_at: '2026-01-02T10:00:00.000Z',
    data: { message_id: laterId, from: contact, text: 'later' },
  };
  const earlierEvent = {
    id: `evt-${randomUUID()}`,
    type: 'message.inbound',
    workspace: 'ws_acme',
    occurred_at: '2026-01-01T10:00:00.000Z',
    data: { message_id: earlierId, from: contact, text: 'earlier' },
  };

  await storeInboundWebhook(laterEvent.id, laterEvent);
  await storeInboundWebhook(laterEvent.id, laterEvent);
  await storeInboundWebhook(`retry-${randomUUID()}`, laterEvent);
  await storeInboundWebhook(earlierEvent.id, earlierEvent);

  const result = await getConversationMessages('ws_acme', contact);
  assert.ok(result);
  assert.deepEqual(
    result.messages
      .filter((message) => message.direction === 'inbound')
      .map((message) => message.id),
    [earlierId, laterId],
  );

  const { inboundEvents } = await collections();
  assert.equal(
    await inboundEvents.countDocuments({ workspace: 'ws_acme', from: contact }),
    2,
  );
});

test('client_ref creates one reply and terminal status cannot regress', async () => {
  const contact = `reply-${randomUUID()}`;
  const clientRef = `client-${randomUUID()}`;
  const reply = () => createReply('ws_acme', contact, 'hello', clientRef);
  await Promise.all(Array.from({ length: 8 }, reply));

  const { outboundReplies } = await collections();
  assert.equal(
    await outboundReplies.countDocuments({ workspace: 'ws_acme', clientRef }),
    1,
  );
  assert.equal(
    (await outboundReplies.findOne({ workspace: 'ws_acme', clientRef }))?.status,
    'queued',
  );

  const statusEvent = (id: string, status: 'sent' | 'delivered' | 'failed') => ({
    id,
    type: 'message.status',
    workspace: 'ws_acme',
    data: { message_id: `pm-${clientRef}`, client_ref: clientRef, status },
  });
  await storeStatusWebhook(`evt-${randomUUID()}`, statusEvent(`status-${randomUUID()}`, 'sent'));
  assert.equal(
    (await outboundReplies.findOne({ workspace: 'ws_acme', clientRef }))?.status,
    'sent',
  );
  await storeStatusWebhook(`evt-${randomUUID()}`, statusEvent(`status-${randomUUID()}`, 'delivered'));
  await storeStatusWebhook(`evt-${randomUUID()}`, statusEvent(`status-${randomUUID()}`, 'sent'));
  await storeStatusWebhook(`evt-${randomUUID()}`, statusEvent(`status-${randomUUID()}`, 'failed'));

  assert.equal(
    (await outboundReplies.findOne({ workspace: 'ws_acme', clientRef }))?.status,
    'delivered',
  );

  const outOfOrderRef = `client-${randomUUID()}`;
  await createReply('ws_acme', contact, 'out of order', outOfOrderRef);
  const outOfOrder = (status: 'sent' | 'delivered') => ({
    id: `status-${randomUUID()}`,
    type: 'message.status',
    workspace: 'ws_acme',
    data: {
      message_id: `pm-${outOfOrderRef}`,
      client_ref: outOfOrderRef,
      status,
    },
  });
  await storeStatusWebhook(`evt-${randomUUID()}`, outOfOrder('delivered'));
  await storeStatusWebhook(`evt-${randomUUID()}`, outOfOrder('sent'));
  assert.equal(
    (await outboundReplies.findOne({ workspace: 'ws_acme', clientRef: outOfOrderRef }))?.status,
    'delivered',
  );

  const failedRef = `client-${randomUUID()}`;
  await createReply('ws_acme', contact, 'failure case', failedRef);
  const failedStatus = (status: 'sent' | 'failed') => ({
    id: `status-${randomUUID()}`,
    type: 'message.status',
    workspace: 'ws_acme',
    data: {
      message_id: `pm-${failedRef}`,
      client_ref: failedRef,
      status,
    },
  });
  await storeStatusWebhook(`evt-${randomUUID()}`, failedStatus('sent'));
  await storeStatusWebhook(`evt-${randomUUID()}`, failedStatus('failed'));
  await storeStatusWebhook(`evt-${randomUUID()}`, failedStatus('sent'));
  assert.equal(
    (await outboundReplies.findOne({ workspace: 'ws_acme', clientRef: failedRef }))?.status,
    'failed',
  );
});
