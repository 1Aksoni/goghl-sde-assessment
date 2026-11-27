import type { Document } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendWorkspaceEvent } from './events.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';

interface PendingWorkspaceEvent {
  sourceKey: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface InboundMessage {
  messageId: string;
  text: string;
  occurredAt: Date;
  receivedAt: Date;
}

export interface Conversation {
  workspace: string;
  contact: string;
  assignee: string | null;
  closed: boolean;
  inbound: InboundMessage[];
  pendingEvents?: PendingWorkspaceEvent[];
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt?: Date;
}

export interface InboundEvent {
  eventId: string;
  workspace: string;
  messageId: string;
  from: string;
  text: string;
  occurredAt: Date;
  receivedAt: Date;
  state: 'pending' | 'applied';
}

export interface OutboundReply {
  workspace: string;
  clientRef: string;
  contact: string;
  text: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  pigeonMessageId?: string;
  readyToSend?: boolean;
  deliveryState: 'pending' | 'sending' | 'retry' | 'done';
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
  pendingEvents?: PendingWorkspaceEvent[];
  createdAt: Date;
  updatedAt: Date;
}

export interface StatusEvent {
  eventId: string;
  workspace: string;
  clientRef: string;
  status: 'sent' | 'delivered' | 'failed';
  pigeonMessageId?: string;
  receivedAt: Date;
  state: 'pending' | 'applied';
}

export interface WorkspaceEvent {
  workspace: string;
  seq: number;
  type: string;
  payload: Document;
  createdAt: Date;
}

export const KNOWN_WORKSPACES = ['ws_acme', 'ws_globex'] as const;

export function isKnownWorkspace(
  workspace: string,
): workspace is (typeof KNOWN_WORKSPACES)[number] {
  return KNOWN_WORKSPACES.includes(workspace as (typeof KNOWN_WORKSPACES)[number]);
}

const inboundWebhookSchema = z.object({
  id: z.string().min(1),
  type: z.literal('message.inbound'),
  workspace: z.string().min(1),
  occurred_at: z.string().datetime({ offset: true }),
  data: z.object({
    message_id: z.string().min(1),
    from: z.string().min(1),
    text: z.string(),
  }),
});

const statusWebhookSchema = z.object({
  id: z.string().min(1),
  type: z.literal('message.status'),
  workspace: z.string().min(1),
  data: z.object({
    message_id: z.string().min(1),
    client_ref: z.string().min(1),
    status: z.enum(['sent', 'delivered', 'failed']),
  }),
});

export async function collections() {
  const db = await getDb();
  return {
    conversations: db.collection<Conversation>('conversations'),
    inboundEvents: db.collection<InboundEvent>('inboundEvents'),
    outboundReplies: db.collection<OutboundReply>('outboundReplies'),
    statusEvents: db.collection<StatusEvent>('statusEvents'),
    workspaceEvents: db.collection<WorkspaceEvent>('workspaceEvents'),
  };
}

export async function ensureStorageIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection<Conversation>('conversations').createIndex(
      { workspace: 1, contact: 1 },
      { unique: true },
    ),
    db.collection<Conversation>('conversations').createIndex({
      workspace: 1,
      lastActivityAt: -1,
      contact: 1,
    }),
    db.collection<InboundEvent>('inboundEvents').createIndex(
      { eventId: 1 },
      { unique: true },
    ),
    db.collection<InboundEvent>('inboundEvents').createIndex(
      { workspace: 1, messageId: 1 },
      { unique: true },
    ),
    db.collection<OutboundReply>('outboundReplies').createIndex(
      { workspace: 1, clientRef: 1 },
      { unique: true },
    ),
    db.collection<OutboundReply>('outboundReplies').createIndex({
      readyToSend: 1,
      deliveryState: 1,
      nextAttemptAt: 1,
      leaseUntil: 1,
      createdAt: 1,
    }),
    db.collection<StatusEvent>('statusEvents').createIndex(
      { eventId: 1 },
      { unique: true },
    ),
    db.collection<WorkspaceEvent>('workspaceEvents').createIndex(
      { workspace: 1, seq: 1 },
      { unique: true },
    ),
  ]);
  await db.collection<Conversation>('conversations').updateMany(
    { lastActivityAt: { $exists: false } },
    [{ $set: { lastActivityAt: '$updatedAt' } }],
  );
}

export async function resetApplicationData(): Promise<void> {
  const db = await getDb();
  await db.dropDatabase();
  await ensureStorageIndexes();
  await getRedis().flushdb();
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 11000
  );
}

async function flushConversationEvents(
  workspace: string,
  contact: string,
  events: PendingWorkspaceEvent[] | undefined,
): Promise<void> {
  if (!events?.length) return;
  const { conversations } = await collections();
  for (const event of events) {
    await appendWorkspaceEvent(workspace, event.type, event.payload, event.sourceKey);
    await conversations.updateOne(
      { workspace, contact, 'pendingEvents.sourceKey': event.sourceKey },
      { $pull: { pendingEvents: { sourceKey: event.sourceKey } } },
    );
  }
}

async function flushReplyEvents(
  workspace: string,
  clientRef: string,
  events: PendingWorkspaceEvent[] | undefined,
): Promise<void> {
  const { outboundReplies } = await collections();
  if (events?.length) {
    for (const event of events) {
      await appendWorkspaceEvent(workspace, event.type, event.payload, event.sourceKey);
      await outboundReplies.updateOne(
        { workspace, clientRef, 'pendingEvents.sourceKey': event.sourceKey },
        { $pull: { pendingEvents: { sourceKey: event.sourceKey } } },
      );
    }
  }
  await outboundReplies.updateOne(
    {
      workspace,
      clientRef,
      $or: [
        { pendingEvents: { $size: 0 } },
        { pendingEvents: { $exists: false } },
      ],
    },
    { $set: { readyToSend: true } },
    );
}

export async function processPendingWorkspaceEvents(): Promise<void> {
  const { conversations, outboundReplies } = await collections();
  const pendingConversations = await conversations
    .find({ 'pendingEvents.0': { $exists: true } })
    .toArray();
  for (const conversation of pendingConversations) {
    await flushConversationEvents(
      conversation.workspace,
      conversation.contact,
      conversation.pendingEvents,
    );
  }

  const pendingReplies = await outboundReplies
    .find({ 'pendingEvents.0': { $exists: true } })
    .toArray();
  for (const reply of pendingReplies) {
    await flushReplyEvents(reply.workspace, reply.clientRef, reply.pendingEvents);
  }
}

export async function storeInboundWebhook(
  eventId: string,
  payload: unknown,
): Promise<void> {
  const event = inboundWebhookSchema.parse(payload);
  if (!isKnownWorkspace(event.workspace)) {
    return;
  }

  const { inboundEvents } = await collections();
  const now = new Date();
  let receipt: InboundEvent;
  try {
    receipt = {
      eventId,
      workspace: event.workspace,
      messageId: event.data.message_id,
      from: event.data.from,
      text: event.data.text,
      occurredAt: new Date(event.occurred_at),
      receivedAt: now,
      state: 'pending',
    };
    await inboundEvents.insertOne(receipt);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;

    const existingEvent = await inboundEvents.findOne({ eventId });
    if (existingEvent) {
      if (existingEvent.state === 'applied') return;
      receipt = existingEvent;
    } else {
      const existingMessage = await inboundEvents.findOne({
        workspace: event.workspace,
        messageId: event.data.message_id,
      });
      if (existingMessage) {
        if (existingMessage.state === 'pending') {
          await applyInboundReceipt(existingMessage);
        }
        return;
      }
      throw error;
    }
  }

  await applyInboundReceipt(receipt);
}

async function applyInboundReceipt(receipt: InboundEvent): Promise<void> {
  const { conversations, inboundEvents } = await collections();
  const inbound = {
    messageId: receipt.messageId,
    text: receipt.text,
    occurredAt: receipt.occurredAt,
    receivedAt: receipt.receivedAt,
  };
  const filter = { workspace: receipt.workspace, contact: receipt.from };
  const update = {
    $setOnInsert: {
      workspace: receipt.workspace,
      contact: receipt.from,
      assignee: null,
      closed: false,
      createdAt: receipt.receivedAt,
    },
    $addToSet: {
      inbound,
      pendingEvents: {
        sourceKey: `inbound:${receipt.eventId}`,
        type: 'message.inbound',
        payload: { contact: receipt.from, message_id: receipt.messageId },
      },
    },
    $max: {
      updatedAt: receipt.occurredAt,
      lastActivityAt: receipt.occurredAt,
    },
  };

  try {
    await conversations.updateOne(filter, update, { upsert: true });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const result = await conversations.updateOne(filter, update);
    if (result.matchedCount !== 1) throw error;
  }

  const conversation = await conversations.findOne(filter);
  if (conversation) {
    await flushConversationEvents(
      receipt.workspace,
      receipt.from,
      conversation.pendingEvents,
    );
  }
  await inboundEvents.updateOne(
    { eventId: receipt.eventId, state: 'pending' },
    { $set: { state: 'applied' } },
  );
}

export async function processPendingInboundWebhooks(): Promise<void> {
  const { inboundEvents } = await collections();
  const pending = await inboundEvents.find({ state: 'pending' }).toArray();
  for (const receipt of pending) {
    await applyInboundReceipt(receipt);
  }
}

export async function claimConversation(
  workspace: string,
  contact: string,
  agent: string,
): Promise<boolean> {
  const { conversations } = await collections();
  const now = new Date();

  try {
    await conversations.insertOne({
      workspace,
      contact,
      assignee: null,
      closed: false,
      inbound: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }

  const sourceKey = `assignment:${randomUUID()}`;
  const result = await conversations.updateOne(
    {
      workspace,
      contact,
      assignee: null,
    },
    {
      $set: { assignee: agent, updatedAt: now },
      $addToSet: {
        pendingEvents: {
          sourceKey,
          type: 'conversation.assigned',
          payload: { contact, assignee: agent },
        },
      },
    },
  );
  const conversation = await conversations.findOne({ workspace, contact });
  if (!conversation) return false;
  if (result.matchedCount === 1 || conversation.assignee === agent) {
    await flushConversationEvents(
      workspace,
      contact,
      conversation.pendingEvents,
    );
    return true;
  }
  return false;
}

export async function setConversationClosed(
  workspace: string,
  contact: string,
  closed: boolean,
): Promise<boolean> {
  const { conversations } = await collections();
  const sourceKey = `conversation-state:${randomUUID()}`;
  const now = new Date();
  const result = await conversations.updateOne(
    { workspace, contact, closed: { $ne: closed } },
    {
      $set: { closed, updatedAt: now },
      $addToSet: {
        pendingEvents: {
          sourceKey,
          type: closed ? 'conversation.closed' : 'conversation.reopened',
          payload: { contact },
        },
      },
    },
  );
  const conversation = await conversations.findOne({ workspace, contact });
  if (!conversation) return false;
  if (result.matchedCount === 1) {
    await flushConversationEvents(
      workspace,
      contact,
      conversation.pendingEvents,
    );
  }
  return true;
}

export async function createReply(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string,
): Promise<void> {
  const { conversations, outboundReplies } = await collections();
  const existing = await outboundReplies.findOne({ workspace, clientRef });
  if (existing) {
    await flushReplyEvents(workspace, clientRef, existing.pendingEvents);
    return;
  }

  const now = new Date();
  try {
    await conversations.updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          closed: false,
          inbound: [],
          createdAt: now,
        },
        $set: { updatedAt: now },
        $max: { lastActivityAt: now },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    if (!(await conversations.findOne({ workspace, contact }))) throw error;
  }

  const pendingEvent: PendingWorkspaceEvent = {
    sourceKey: `reply:${clientRef}`,
    type: 'message.status',
    payload: { contact, client_ref: clientRef, status: 'queued' },
  };
  let inserted = false;
  try {
    await outboundReplies.insertOne({
      workspace,
      clientRef,
      contact,
      text,
      status: 'queued',
      readyToSend: false,
      deliveryState: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      pendingEvents: [pendingEvent],
      createdAt: now,
      updatedAt: now,
    });
    inserted = true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const duplicate = await outboundReplies.findOne({ workspace, clientRef });
    if (!duplicate) throw error;
    await flushReplyEvents(workspace, clientRef, duplicate.pendingEvents);
  }
  if (inserted) await flushReplyEvents(workspace, clientRef, [pendingEvent]);
}

export async function listConversations(
  workspace: string,
  limit: number,
  before?: { lastActivityAt: Date; contact: string },
): Promise<Conversation[]> {
  const { conversations } = await collections();
  const filter: Document = { workspace };
  if (before) {
    filter.$or = [
      { lastActivityAt: { $lt: before.lastActivityAt } },
      { lastActivityAt: before.lastActivityAt, contact: { $gt: before.contact } },
    ];
  }
  return conversations
    .find(filter)
    .sort({ lastActivityAt: -1, contact: 1 })
    .limit(limit)
    .toArray();
}

export async function getConversationMessages(
  workspace: string,
  contact: string,
): Promise<{ conversation: Conversation; messages: Document[] } | null> {
  const { conversations, outboundReplies } = await collections();
  const conversation = await conversations.findOne({ workspace, contact });
  if (!conversation) return null;

  const outbound = await outboundReplies
    .find({ workspace, contact })
    .toArray();
  const messages: Document[] = [
    ...conversation.inbound.map((message) => ({
      id: message.messageId,
      direction: 'inbound',
      text: message.text,
      status: 'received',
      createdAt: message.occurredAt,
    })),
    ...outbound.map((reply) => ({
      id: reply.clientRef,
      client_ref: reply.clientRef,
      direction: 'outbound',
      text: reply.text,
      status: reply.status,
      createdAt: reply.createdAt,
    })),
  ];
  messages.sort(
    (left, right) =>
      new Date(left.createdAt as Date).getTime() -
      new Date(right.createdAt as Date).getTime(),
  );
  return { conversation, messages };
}

export async function leaseNextReply(
  owner: string,
  leaseMs: number,
): Promise<OutboundReply | null> {
  const { outboundReplies } = await collections();
  const now = new Date();
  return outboundReplies.findOneAndUpdate(
    {
      readyToSend: true,
      $or: [
        {
          deliveryState: { $in: ['pending', 'retry'] },
          nextAttemptAt: { $lte: now },
        },
        { deliveryState: 'sending', leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        deliveryState: 'sending',
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' },
  );
}

export async function retryReply(
  reply: OutboundReply,
  owner: string,
  delayMs: number,
  error: string,
): Promise<void> {
  const { outboundReplies } = await collections();
  await outboundReplies.updateOne(
    { workspace: reply.workspace, clientRef: reply.clientRef, leaseOwner: owner },
    {
      $set: {
        deliveryState: 'retry',
        nextAttemptAt: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
        lastError: error.slice(0, 500),
      },
      $unset: { leaseOwner: '', leaseUntil: '' },
    },
  );
}

export async function completeReply(
  reply: OutboundReply,
  pigeonMessageId: string,
): Promise<void> {
  const { outboundReplies } = await collections();
  await outboundReplies.updateOne(
    { workspace: reply.workspace, clientRef: reply.clientRef },
    {
      $set: {
        deliveryState: 'done',
        pigeonMessageId,
        updatedAt: new Date(),
      },
      $unset: { leaseOwner: '', leaseUntil: '', lastError: '' },
    },
  );
}

export async function failReply(
  reply: OutboundReply,
  owner: string,
  error: string,
): Promise<void> {
  const { outboundReplies } = await collections();
  await outboundReplies.updateOne(
    { workspace: reply.workspace, clientRef: reply.clientRef, leaseOwner: owner },
    [
      {
        $set: {
          status: {
            $cond: [
              { $in: ['$status', ['queued', 'sent']] },
              'failed',
              '$status',
            ],
          },
          deliveryState: 'done',
          lastError: error.slice(0, 500),
          updatedAt: new Date(),
        },
      },
      { $unset: ['leaseOwner', 'leaseUntil'] },
    ],
  );
}

async function applyStatusReceipt(receipt: StatusEvent): Promise<void> {
  const { outboundReplies, statusEvents } = await collections();
  await outboundReplies.updateOne(
    { workspace: receipt.workspace, clientRef: receipt.clientRef },
    [
      {
        $set: {
          status: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'queued'] }, then: receipt.status },
                {
                  case: { $eq: ['$status', 'sent'] },
                  then:
                    receipt.status === 'sent' ? '$status' : receipt.status,
                },
              ],
              default: '$status',
            },
          },
          pigeonMessageId: { $ifNull: ['$pigeonMessageId', receipt.pigeonMessageId] },
          updatedAt: receipt.receivedAt,
        },
      },
    ],
  );
  const reply = await outboundReplies.findOne({
    workspace: receipt.workspace,
    clientRef: receipt.clientRef,
  });
  if (reply) {
    await appendWorkspaceEvent(
      receipt.workspace,
      'message.status',
      {
        contact: reply.contact,
        client_ref: reply.clientRef,
        status: reply.status,
      },
      `status:${receipt.eventId}`,
    );
  }
  await statusEvents.updateOne(
    { eventId: receipt.eventId, state: 'pending' },
    { $set: { state: 'applied' } },
  );
}

export async function storeStatusWebhook(
  eventId: string,
  payload: unknown,
): Promise<void> {
  const event = statusWebhookSchema.parse(payload);
  if (!isKnownWorkspace(event.workspace)) return;

  const { outboundReplies, statusEvents } = await collections();
  const reply = await outboundReplies.findOne({
    workspace: event.workspace,
    clientRef: event.data.client_ref,
  });
  if (!reply) return;

  let receipt: StatusEvent;
  try {
    receipt = {
      eventId,
      workspace: event.workspace,
      clientRef: event.data.client_ref,
      pigeonMessageId: event.data.message_id,
      status: event.data.status,
      receivedAt: new Date(),
      state: 'pending',
    };
    await statusEvents.insertOne(receipt);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await statusEvents.findOne({ eventId });
    if (!existing) throw error;
    if (existing.state === 'applied') return;
    receipt = existing;
  }

  await applyStatusReceipt(receipt);
}

export async function processPendingStatusWebhooks(): Promise<void> {
  const { statusEvents } = await collections();
  const pending = await statusEvents.find({ state: 'pending' }).toArray();
  for (const receipt of pending) {
    await applyStatusReceipt(receipt);
  }
}

export async function getSnapshot(): Promise<Document> {
  await ensureStorageIndexes();
  const { conversations, outboundReplies } = await collections();

  const workspaces: Record<string, Document> = {};

  for (const workspace of KNOWN_WORKSPACES) {
    const workspaceConversations = await conversations
      .find({ workspace })
      .toArray();
    const workspaceOutbound = await outboundReplies
      .find({ workspace })
      .toArray();

    const contacts: Record<string, Document> = {};

    for (const conversation of workspaceConversations) {
      contacts[conversation.contact] = {
        inbound: conversation.inbound
          .slice()
          .sort(
            (left, right) =>
              left.occurredAt.getTime() - right.occurredAt.getTime() ||
              left.receivedAt.getTime() - right.receivedAt.getTime(),
          )
          .map((message) => message.messageId),
        assignee: conversation.assignee ?? null,
      };
    }

    const outbound: Record<string, string> = {};
    for (const reply of workspaceOutbound) {
      outbound[reply.clientRef] = reply.status;
    }

    workspaces[workspace] = { contacts, outbound };
  }

  return { workspaces };
}
