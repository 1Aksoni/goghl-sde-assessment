import { getRedis } from './redis.js';

export interface WorkspaceFrame {
  seq: number;
  workspace: string;
  type: string;
  [key: string]: unknown;
}

const APPEND_EVENT_SCRIPT = `
local prior = redis.call('HGET', KEYS[3], ARGV[1])
if prior then
  return prior
end
local seq = redis.call('INCR', KEYS[4])
local frame = cjson.decode(ARGV[2])
frame.seq = seq
local encoded = cjson.encode(frame)
redis.call('XADD', KEYS[1], tostring(seq) .. '-0', 'frame', encoded)
redis.call('HSET', KEYS[3], ARGV[1], encoded)
redis.call('PUBLISH', KEYS[2], encoded)
return encoded
`;

function eventKeys(workspace: string): string[] {
  const prefix = `switchboard:{${workspace}}`;
  return [
    `${prefix}:events`,
    `${prefix}:event-channel`,
    `${prefix}:event-dedupe`,
    `${prefix}:event-seq`,
  ];
}

export async function appendWorkspaceEvent(
  workspace: string,
  type: string,
  payload: Record<string, unknown>,
  sourceKey: string,
): Promise<WorkspaceFrame> {
  const [stream, channel, dedupe, sequence] = eventKeys(workspace);
  const encoded = await getRedis().eval(
    APPEND_EVENT_SCRIPT,
    4,
    stream,
    channel,
    dedupe,
    sequence,
    sourceKey,
    JSON.stringify({ ...payload, workspace, type }),
  );
  if (typeof encoded !== 'string') {
    throw new Error('Redis did not return the appended workspace event');
  }
  return JSON.parse(encoded) as WorkspaceFrame;
}

export async function readWorkspaceEvents(
  workspace: string,
  after: number,
): Promise<WorkspaceFrame[]> {
  const redis = getRedis();
  const [stream] = eventKeys(workspace);
  const entries = await redis.xrange(
    stream,
    after > 0 ? `(${after}-0` : '-',
    '+',
  );
  return entries.flatMap(([, fields]) => {
    const index = fields.indexOf('frame');
    if (index < 0 || typeof fields[index + 1] !== 'string') return [];
    return [JSON.parse(fields[index + 1]) as WorkspaceFrame];
  });
}

export function workspaceEventChannel(workspace: string): string {
  return eventKeys(workspace)[1];
}
