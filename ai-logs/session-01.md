# AI Session 01

## Prompt

```text
Read START_HERE.md, BRIEF.md, PIGEON.md, and package.json, and check scaffold/ and harness/ (don't touch harness/ or read SUBMISSION.md/bonus docs yet).

Don't write app code yet just summarize the core requirements, Pigeon's failure/idempotency rules, auth/workspaces, and the fastest vertical slice for Level 1 of npm run check, and log our prompt and your response to ai-logs/session-01.md.
```

## Response

### Core requirements

Switchboard is a shared team inbox for two simulated tenant workspaces:

- Agents log in through the mock IdP and receive conversations and replies in real time.
- Pigeon sends customer webhook events to `POST /webhooks/pigeon`.
- Agents can claim conversations, with one holder only, and close/reopen them.
- Replies are outbound Pigeon messages with visible `queued`, `sent`, `delivered`, or `failed` status.
- The inbox is paginated and ordered by newest activity; a contact belongs to a workspace.
- The browser uses React, and the server is Express/TypeScript in the optional scaffold.

The contract is environment-driven and fixed in key places:

- `switchboard.json` must expose `install`, `start`, and `health`; the start command must honor `PORT`.
- `/healthz` must return `200` when ready.
- Grader endpoints require `x-grader-token == GRADER_TOKEN` and must use the application paths:
  - `POST /__grader/reset`
  - `GET /__grader/snapshot`
  - `POST /__grader/reply`
  - `POST /__grader/claim`
- Unknown API behavior is otherwise flexible, but the brief-defined login, conversation, webhook, snapshot, and WebSocket behaviors must match exactly.
- MongoDB and Redis are available and application data must be resettable.

### Pigeon failure and idempotency rules

The webhook must verify raw-body HMAC-SHA256:

- Header: `x-pigeon-signature: t=<unix seconds>,v1=<hex>`.
- Secret: `PIGEON_WEBHOOK_SECRET`.
- Reject missing/malformed/non-matching signatures and timestamps older than five minutes with `401`, never `5xx`.
- Parse failures after a valid signature return `400`.
- Unknown event types and unknown workspaces return `2xx` and are ignored.
- Status events for messages never sent return `2xx` and are ignored.
- A genuinely handled event is acknowledged `2xx` only after it is safely stored or found to be already stored.

Pigeon uses at-least-once delivery, can reorder events, and retries for roughly 22 seconds if it receives no `2xx` within five seconds. Therefore, webhook processing must deduplicate on `event.id` or another durable event identity, with a unique Mongo/Redis-backed write. Storing events before returning is essential. Bursts, forged replay, and out-of-order status events require durable state and monotonic handling.

Outbound sending must also be durable and idempotent:

- Store reply intent and `client_ref` first; return `202` only after that succeeds.
- Send to Pigeon with `Idempotency-Key: <client_ref>`.
- Repeated calls with the same `client_ref` must return the original reply and must not create another send.
- Pigeon may return `429` with `Retry-After`, `503`, connection timeouts after accepting the message, or a 12-second response. Calls must be retried with backoff and the original idempotency key.
- Never assume a timeout or lost HTTP response means Pigeon did not send; only status webhooks and the durable send record establish the result.
- A retry worker or queue must keep pending replies and status updates after crashes. Rate limiting is per workspace and must be honored.

### Auth and workspace isolation

- The mock IdP uses OIDC authorization code flow with PKCE S256.
- The workspace/role answer comes from the IdP session's `workspaces` claim. Example roles are `admin` and `agent`.
- `GET /auth/login` starts login; `GET /auth/callback` establishes a secure session cookie.
- `GET /api/me` requires a session and returns `sub` plus workspace IDs and roles.
- Workspace-scoped APIs return `401` without a session and `403` to signed-in non-members.
- Pigeon sends include workspace; every stored object must be keyed or validated by workspace.
- Grader claim agents are opaque IDs and must not be looked up in the IdP.
- WebSocket `GET /ws?workspace=<id>` uses the same session cookie. Reject unauthenticated or non-member upgrades.
- Frames must carry monotonically increasing integer `seq` values within a workspace. `after=<seq>` replays missed persisted frames, then continues live.
- Multiple server copies must share state and broadcasts, and no copy may read or expose another workspace's data.

### Fastest vertical slice for Level 1

Stop the dev server, then implement only this critical path before expanding the UI:

1. Keep the scaffold start/health contract working on the environment `PORT`.
2. Add Mongo collections with unique indexes for conversations, inbound events, outbound replies, and a workspace sequence.
3. Implement the raw-body Pigeon webhook with signature/timestamp validation and durable event deduplication.
4. Inbound handling:
   - validate/ignore unknown workspace,
   - find or create the workspace/contact conversation,
   - append a unique inbound message,
   - safely persist it,
   - emit or persist a workspace sequence frame.
5. Implement grader reset and snapshot.
6. Implement an atomic claim operation for `POST /__grader/claim`; holder repeats return `200`, a different holder returns `409`.
7. Implement `POST /__grader/reply`:
   - validate the workspace,
   - find or create the conversation,
   - atomically insert an outbound record keyed by `client_ref`,
   - return `202`,
   - enqueue a Pigeon send with the same `Idempotency-Key`.
8. Process status webhooks and update outbound status in the database.
9. Add a basic worker that retries `429`, `503`, timeout/transport failures, and downtime without duplicate sends.
10. Run `npm run check` early and keep fixing the exact Level 1 failures before building auth, richer frontend, or WebSockets.

The shortest useful UI after Level 1 is a login-free/grader-visible inbox only if needed for local confidence; Level 1 primarily exercises webhook persistence, duplicate/out-of-order handling, rate-limited/failed sends, concurrent claims, reset, and snapshot.

## Files checked

- `START_HERE.md`
- `BRIEF.md`
- `PIGEON.md`
- `package.json`
- `scaffold/README.md`
- `scaffold/server/src/config.ts`
- `scaffold/server/src/db.ts`
- `scaffold/server/src/redis.ts`
- `scaffold/server/src/index.ts`
- `scaffold/server/package.json`
- `scaffold/web/src/App.tsx`
- `scaffold/web/src/main.tsx`
- `scaffold/web/vite.config.ts`
- `scaffold/web/package.json`
- `switchboard.json`
- `.env.example`
- `README.md`

I did not modify app code or inspect `harness/`, `SUBMISSION.md`, or bonus documentation.

---

## Follow-up Prompt

```text
okay, read and understand both BRIEF.md and PIGEON.md (plus check scaffold/ and .env.example), and tell me the core modules we should implement first and also dependencies. Don't write code yet, and append our prompt and your response to ai-logs/session-01.md.
```

## Follow-up Response

### Implementation order: first modules

1. **Configuration and process startup**
   - Keep environment loading and `PORT` support.
   - Start the health server and ensure `switchboard.json` remains valid.
   - Dependencies: none beyond the scaffold's Node/TypeScript/Express setup.

2. **Storage and reset/snapshot module**
   - MongoDB collections/unique indexes for:
     - workspaces and conversations
     - inbound event deduplication
     - outbound reply state keyed by `(workspace, client_ref)`
     - status event deduplication
     - workspace event frames/sequence numbers
   - Redis-backed coordination where useful: nonces, locks, job state, replay/event state.
   - Implement `POST /__grader/reset` and `GET /__grader/snapshot`.
   - This module is the source of truth; routes should not maintain independent state.

3. **Pigeon webhook module**
   - Express raw-body parsing must retain the exact bytes for HMAC verification.
   - Verify signature format, HMAC-SHA256, five-minute timestamp window, and JSON separately.
   - Ack semantics:
     - malformed signature or stale timestamp: `401`
     - valid signature plus malformed body: `400`
     - unknown event type/workspace/status for unknown outbound: `2xx`, ignore
     - known event: store atomically first, then `2xx`
   - Deduplicate by Pigeon event ID and inbound message ID.

4. **Inbox/domain module**
   - Conversations keyed by `(workspace, contact)`.
   - Durable inbound message append and newest-activity ordering.
   - Atomic claim/release/close/reopen operations.
   - `POST /__grader/claim` must create a conversation if needed:
     - same holder = `200`
     - no holder = set atomically and `200`
     - another holder = `409`

5. **Outbound reply and sender worker module**
   - Implement `POST /__grader/reply` only after storing the reply intent and reply record.
   - Key by `(workspace, client_ref)` and return `202` once safely stored.
   - Use Pigeon `POST /v1/messages` with:
     - workspace API key
     - `Idempotency-Key: client_ref`
     - a durable record for queued/sending/sent/delivered/failed state
   - Retry `429`, `503`, transport errors, and timeouts using the same idempotency key.
   - Process status webhooks independently and tolerate reordered/out-of-order statuses.
   - Do not infer "not sent" from an HTTP timeout; status or Pigeon's idempotency response is authoritative.

6. **Real-time event module**
   - Persist a workspace event stream/sequence.
   - Emit `message.inbound`, `message.status`, and `conversation.assigned` frames.
   - Implement replay via `after=<seq>`, then live delivery.
   - For several server copies, Redis pub/sub or Redis Streams must fan out events and all instances must read shared Mongo state.

7. **Authentication/session module**
   - OIDC authorization code + PKCE S256.
   - `/auth/login`, `/auth/callback`, and `/api/me`.
   - Session cookie plus server-side or signed session state.
   - `/api/conversations` workspace membership checks.
   - Tenant authorization must occur in every workspace API and WebSocket path.

8. **React inbox**
   - Implement after the contract-level backend slice is working.
   - Login, workspace switcher, conversation list, message thread, reply, notes if time permits.
   - WebSocket reconnection with `after=<lastSeq>`.

### Core dependencies to add

Already present in the scaffold:

- `express` for HTTP routes.
- `tsx` for running/start tooling.
- `typescript` and Node type packages.
- `mongodb` for durable application state.
- `ioredis` for coordination/pub-sub/job support.
- React, React DOM, Vite, and the React Vite plugin for the web app.

Likely dependencies:

- `ws` plus `@types/ws` for WebSockets.
- `openid-client` for standards-based OIDC authorization code and PKCE handling.
- `cookie-parser` plus `@types/cookie-parser` for cookie parsing, if a cookie-parser middleware is used.
- `express-session` plus `@types/express-session` only if using session middleware with a Redis/Mongo store; could instead implement a small HMAC-signed/opaque server-side session.
- `fetch` is built into Node 22, so no HTTP client package is required.
- `zod` or another runtime schema validator for webhook and API payload validation.
- `nanoid` or `uuid` for internal events, jobs, and sessions if needed.
- Testing: Vitest or Node's built-in test runner, plus `supertest` for route tests. The smallest useful tests are claim races, webhook deduplication/status ordering, and reply idempotency.

Optional later:

- `@elastic/elasticsearch` for workspace-scoped search.
- Encrypted-notes protocol dependencies such as Web Crypto support in modern browsers; do not add a server-readable key design.

### Fastest vertical slice before auth/UI

The critical Level 1 sequence is:

1. Add Mongo models and indexes plus reset/snapshot.
2. Implement signed Pigeon webhook storage/deduplication.
3. Implement atomic inbound conversation updates and claim.
4. Implement stored-and-queued grader replies with Pigeon `client_ref` idempotency.
5. Add a retry worker and status-webhook processing.
6. Add only the minimal WebSocket stream needed for live change delivery.
7. Implement auth/workspace APIs and React surfaces.
8. Run `npm run check` repeatedly before adding level 2/3/multicopy work.

---

## Agent Instructions Prompt

```text
read that agen.md file also for better instructions
```

## Agent Instructions Response

I read [agent.md](/Users/akshatsoni/Desktop/starter/agent.md). It adds the following engineering constraints:

- Prioritize correctness under Pigeon/provider/network failures over feature count.
- Use Node.js 22, strict TypeScript, Express/Fastify, Zod, MongoDB 7, Redis 7, React, and Vite.
- Use npm or pnpm consistently; npm remains the appropriate choice while package scripts require it.
- All retryable mutations need deterministic idempotency or an idempotency key backed by Mongo unique indexes or atomic updates.
- Avoid read-modify-write state transitions in application memory.
- Keep processes stateless for multi-instance/restart safety; share locks, queues, and coordination through Redis or MongoDB.
- Implement graceful SIGTERM/SIGINT shutdown: stop HTTP intake, finish in-flight work briefly, then close MongoDB/Redis.
- Add explicit Mongo/Redis timeouts and retry/backoff for dependencies.
- Use accurate JSON error responses shaped as `{ error: { code, message } }`.
- Add `GET /health` and `GET /ready`; `/ready` must ping MongoDB and Redis and return `503` if either is unavailable.
- Keep diffs small and verify strict TypeScript compilation plus targeted tests/check commands after code changes.
- Do not ignore git/log hygiene: never add `ai-logs/`, `DECISIONS.md`, or checker reports to `.gitignore`.
- Explain crash windows, assumptions, and failure trade-offs in designs and fixes.

These instructions are now part of the implementation guardrails. They should guide, but not replace, the fixed HTTP contract and Pigeon behaviors in `BRIEF.md` and `PIGEON.md`.
