# AI Session 03

## Prompt

```text
okay so now Implement `POST /__grader/reply` (idempotent on `client_ref`, returning `202` after Mongo save), a lease-based retry worker sending to Pigeon with `Idempotency-Key` + Redis per-workspace rate-limit backoff, and monotonic status webhook updates (`queued` -> `sent` -> `delivered`/`failed`). Run `npm run check` to verify Level 1 passes, and log this session in `ai-logs/session-03.md`.
```

## Response

Implemented the durable reply and status path.

### Changes

- Added `POST /__grader/reply`, protected by `x-grader-token`.
- Validates workspace/contact/text/client_ref and rejects unknown workspaces with `400`.
- Persists a reply record in MongoDB before returning `202`. `(workspace, client_ref)` is uniquely indexed, so duplicate or concurrent requests create one logical reply.
- A reply document also serves as its durable outbox job. This avoids an unsafe multi-document transaction gap on the configured standalone MongoDB.
- Added a MongoDB lease-based worker:
  - claims pending/retry jobs atomically;
  - reclaims jobs after lease expiry on process restart;
  - retries transient HTTP and transport failures with backoff;
  - sends `Idempotency-Key: <client_ref>` on every Pigeon request;
  - treats permanent Pigeon client errors as terminal failed sends.
- Added Redis Lua scripts for an atomic shared workspace token bucket (capacity 8, refill 4/sec) and shared cooldown. Pigeon `429 Retry-After` updates the workspace cooldown before retry.
- Added status webhook persistence and recovery. Atomic status transitions prevent `sent` from regressing `delivered` or `failed`, including when the terminal status arrives first.

### Verification

`npm --prefix scaffold/server run typecheck` passed.

`npm run check` passed Level 1 with **24/24 points**:

- Inbound completeness: 168/168.
- Duplicate and ordering checks: 0 duplicates, 0 inversions.
- Forged/stale webhook rejection and isolation: all passed.
- Webhook acknowledgement p95: 22 ms; no first attempts failed.
- Outbound: 12/12 reached Pigeon, zero duplicates, all requests had idempotency keys.
- Retry-After: zero sends during cooldown.
- Status lifecycle: 12/12 final statuses matched Pigeon.
- Atomic claims: all five conversations had exactly one winner.
- Outage recovery: all 6/6 replies delivered after the 8-second outage, zero duplicates.

The checker stopped Pigeon's normal inbound trickle; ran `npm run drizzle` afterward to restore it.

### Remaining

This verifies Level 1 only. Authentication, workspace-authorized product APIs, React inbox, and WebSockets remain. Restart/multi-instance levels 2 and 3 still need to be run and hardened, especially longer lease/failover timing and shared event delivery.
