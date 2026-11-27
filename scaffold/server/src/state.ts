import type { Document } from 'mongodb';
import { z } from 'zod';
import { getDb } from './db.js';
import { getRedis } from './redis.js';

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
  createdAt: Date;
  updatedAt: Date;
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
  deliveryState: 'pending' | 'sending' | 'retry' | 'done';
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
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
    $addToSet: { inbound },
    $max: { updatedAt: receipt.occurredAt },
  };

  try {
    await conversations.updateOne(filter, update, { upsert: true });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const result = await conversations.updateOne(filter, update);
    if (result.matchedCount !== 1) throw error;
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
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }

  const result = await conversations.updateOne(
    {
      workspace,
      contact,
      $or: [{ assignee: null }, { assignee: agent }],
    },
    { $set: { assignee: agent, updatedAt: now } },
  );
  return result.matchedCount === 1;
}

export async function createReply(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string,
): Promise<void> {
  const { conversations, outboundReplies } = await collections();
  const existing = await outboundReplies.findOne({ workspace, clientRef });
  if (existing) return;

  const now = new Date();
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
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  try {
    await outboundReplies.insertOne({
      workspace,
      clientRef,
      contact,
      text,
      status: 'queued',
      deliveryState: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const duplicate = await outboundReplies.findOne({ workspace, clientRef });
    if (!duplicate) throw error;
  }
}

export async function leaseNextReply(
  owner: string,
  leaseMs: number,
): Promise<OutboundReply | null> {
  const { outboundReplies } = await collections();
  const now = new Date();
  return outboundReplies.findOneAndUpdate(
    {
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
