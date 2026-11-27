import type { Document } from 'mongodb';
import { getDb } from './db.js';
import { getRedis } from './redis.js';

export interface Conversation {
  workspace: string;
  contact: string;
  assignee: string | null;
  closed: boolean;
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
}

export interface OutboundReply {
  workspace: string;
  clientRef: string;
  contact: string;
  text: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  pigeonMessageId?: string;
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
}

export interface WorkspaceEvent {
  workspace: string;
  seq: number;
  type: string;
  payload: Document;
  createdAt: Date;
}

export interface OutboxJob {
  workspace: string;
  clientRef: string;
  contact: string;
  text: string;
  state: 'pending' | 'sending' | 'retry';
  attempt: number;
  nextAttemptAt: Date;
  updatedAt: Date;
}

export const KNOWN_WORKSPACES = ['ws_acme', 'ws_globex'] as const;

export async function collections() {
  const db = await getDb();
  return {
    conversations: db.collection<Conversation>('conversations'),
    inboundEvents: db.collection<InboundEvent>('inboundEvents'),
    outboundReplies: db.collection<OutboundReply>('outboundReplies'),
    statusEvents: db.collection<StatusEvent>('statusEvents'),
    workspaceEvents: db.collection<WorkspaceEvent>('workspaceEvents'),
    outboxJobs: db.collection<OutboxJob>('outboxJobs'),
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
    db.collection<StatusEvent>('statusEvents').createIndex(
      { eventId: 1 },
      { unique: true },
    ),
    db.collection<WorkspaceEvent>('workspaceEvents').createIndex(
      { workspace: 1, seq: 1 },
      { unique: true },
    ),
    db.collection<OutboxJob>('outboxJobs').createIndex(
      { workspace: 1, clientRef: 1 },
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

export async function getSnapshot(): Promise<Document> {
  await ensureStorageIndexes();
  const {
    conversations,
    inboundEvents,
    outboundReplies,
  } = await collections();

  const workspaces: Record<string, Document> = {};

  for (const workspace of KNOWN_WORKSPACES) {
    const workspaceConversations = await conversations
      .find({ workspace })
      .toArray();
    const workspaceInbound = await inboundEvents
      .find({ workspace })
      .sort({ occurredAt: 1, receivedAt: 1 })
      .toArray();
    const workspaceOutbound = await outboundReplies
      .find({ workspace })
      .toArray();

    const contacts: Record<string, Document> = {};

    for (const conversation of workspaceConversations) {
      contacts[conversation.contact] = {
        inbound: [],
        assignee: conversation.assignee ?? null,
      };
    }

    for (const inbound of workspaceInbound) {
      const contact = contacts[inbound.from] ?? {
        inbound: [] as string[],
        assignee: null,
      };
      contact.inbound.push(inbound.messageId);
      contacts[inbound.from] = contact;
    }

    const outbound: Record<string, string> = {};
    for (const reply of workspaceOutbound) {
      outbound[reply.clientRef] = reply.status;
    }

    workspaces[workspace] = { contacts, outbound };
  }

  return { workspaces };
}
