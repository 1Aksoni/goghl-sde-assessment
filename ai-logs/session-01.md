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

---

## Initial and Core Component Plan

### Design goals

The implementation should be organized around a small set of durable components:

1. The database is the source of truth.
2. Every mutating operation is idempotent or atomic.
3. Pigeon state is never inferred from local in-memory state.
4. Redis is used only for coordination, locks, queues, rate limits, and cross-process delivery; MongoDB remains the durable record.
5. Every workspace change creates a persisted sequence event.
6. HTTP, grader, and UI flows call the same domain operations.

The first milestone is not "build every feature." It is a working vertical slice that passes Level 1, with auth and the complete UI added immediately afterward.

### Core backend modules

#### 1. Configuration and lifecycle

Responsibilities:

- Load environment variables and `.env` values.
- Keep the scaffold's `PORT`, database, Redis, Pigeon, IdP, grader, and origin settings.
- Enforce the fixed `switchboard.json` start contract.
- Expose `GET /healthz` for the grader.
- Add `GET /health` and `GET /ready` as the engineering and readiness probes.
- `/ready` should ping MongoDB and Redis and return `503` if either is unavailable.
- Add graceful SIGTERM/SIGINT handling, with a short in-flight completion window and clean MongoDB/Redis shutdown.

Key files to introduce:

- `src/config.ts` can remain the environment boundary but should gain Zod env validation.
- `src/app.ts` should own Express setup and route mounting.
- `src/lifecycle.ts` should own shutdown and dependency readiness.

#### 2. Shared storage

MongoDB collections:

- `conversations`: unique `(workspace, contact)`, fields include assignee, status/open state, created/updated timestamps, and newest activity.
- `inboundEvents`: unique event ID; optionally unique `(workspace, message_id)`.
- `outboundReplies`: unique `(workspace, client_ref)`, fields include contact, text, Pigeon message ID, and current status.
- `statusEvents`: unique event ID.
- `workspaceEvents`: one append-only document/row per workspace sequence frame.
- `outboxJobs`: durable send/retry jobs keyed by `(workspace, client_ref)`.
- `sessions`: opaque login sessions if Redis is not chosen as the session store.

Redis usage:

- Distributed locks for claim/reply transitions.
- Idempotency or in-progress markers when useful.
- Outbound sender coordination and workspace send rate coordination.
- Pub/sub or Streams for cross-process WebSocket fan-out.
- Session storage only if the implementation chooses Redis sessions.

MongoDB indexes must be created before traffic and reset must recreate application data safely.

#### 3. Pigeon webhook ingress

The webhook route must use `express.raw` or equivalent raw-byte middleware before JSON parsing. It should verify:

1. Header shape and required timestamp/signature fields.
2. HMAC-SHA256 over `timestamp + "." + rawBody`.
3. Timestamp freshness within five minutes.
4. Valid JSON only after signature verification.

Error behavior:

- Missing/malformed/non-matching/stale signature: `401`.
- Valid signature with invalid JSON: `400`.
- Unknown event type: `2xx` and ignore.
- Unknown workspace: `2xx` and ignore.
- Status event for an unknown outbound: `2xx` and ignore.
- Known event: atomically store/deduplicate first, then update domain state and return `2xx`.

The module should separate:

- signature verification;
- payload validation;
- event deduplication;
- inbound/status domain handlers.

Crash rule: return success only after the event has been committed to MongoDB. It is acceptable to persist and later deliver real-time frames rather than hold a live socket in the request path.

#### 4. Conversation and inbox domain

Operations:

- upsert a conversation by `(workspace, contact)`;
- append an inbound message without losing duplicates;
- atomically claim;
- atomically re-claim by the same assignee;
- return conflict for a different assignee;
- close/reopen;
- list conversations newest activity first;
- return conversation messages in oldest-first order.

Claims and inbound updates must use atomic Mongo operations or transactions. Do not read and then write assignee state. Concurrent claims can use `findOneAndUpdate` with conditions or an atomic Mongo operation.

The inbox API can be intentionally small before the UI:

- `GET /api/conversations?workspace=<id>`
- `GET /api/conversations/:contact/messages?workspace=<id>`
- `POST /api/conversations/:contact/claim`
- `POST /api/conversations/:contact/close`
- `POST /api/conversations/:contact/reopen`

The grader claim endpoint must call the same claim domain operation.

#### 5. Outbound reply and sender

For every reply:

1. Validate the workspace.
2. Upsert/create the conversation.
3. Atomically insert or find the `(workspace, client_ref)` outbound record.
4. Insert a durable send job only if the reply was newly created.
5. Return `202` only after records are committed.

The sender should:

- send `POST /v1/messages`;
- use the workspace API key;
- send `Idempotency-Key: client_ref`;
- use explicit HTTP/socket timeouts;
- retry `429`, `503`, and transport/timeout failures;
- back off for 429 using `Retry-After`;
- keep the retry job durable across restarts;
- never remove a job until Pigeon has accepted or the implementation reaches a documented terminal policy.

Status handling must tolerate out-of-order webhooks. Use a status rank or terminal-state rules instead of unconditional last-write-wins:

- unknown outbound: ignore;
- `sent` may move queued to sent;
- `delivered` supersedes sent;
- `failed` is terminal;
- duplicates and lower-rank late events must not regress state.

#### 6. Workspace sequence and real-time module

Persist a monotonic sequence per workspace. Each meaningful change should append:

- `message.inbound`
- `message.status`
- `conversation.assigned`
- optionally close/reopen events

The sequence increment and domain mutation should have a clear commit strategy. MongoDB transactions are preferred where available; an atomic workspace counter plus event append is the fallback. If a crash happens between mutation and event append, Level 5 replay can be wrong, so this should be one atomic domain transaction or a durable outbox document.

WebSocket behavior:

- Authenticate and authorize the workspace on upgrade.
- Read missed persisted events for `after=<seq>`.
- Send frames after replay.
- Subscribe using Redis for live cross-copy fan-out.
- Send JSON text frames only.

A dropped browser reconnects with `after=<lastSeq>` and receives missed events first.

#### 7. Authentication and authorization

Use OIDC authorization code flow with PKCE S256. The complete flow:

1. `GET /auth/login` creates a state and PKCE verifier.
2. Redirect to the IdP with the authorization code challenge.
3. `GET /auth/callback` validates state and exchanges the code.
4. Store a secure opaque session cookie or signed cookie.
5. `/api/me` returns `sub` and workspaces/roles.
6. Every workspace route verifies membership.
7. WebSocket upgrades verify the same session and membership.

Keep the IdP `workspaces` claim as the workspace/role source. Do not use it to reinterpret opaque grader claim agent IDs.

#### 8. Grader contract adapter

This module should be a thin protected route layer over domain services:

- `POST /__grader/reset`
- `GET /__grader/snapshot`
- `POST /__grader/reply`
- `POST /__grader/claim`

All routes verify `x-grader-token`. They must call the same conversation/reply services used by normal application APIs.

Reset must:

- stop jobs that could recreate data;
- delete application Mongo collections;
- flush/reset Redis application keys;
- preserve login sessions only if the brief permits;
- return `200`.

The reset implementation must prevent an old worker from recreating cleared data.

#### 9. React frontend

Build after backend Level 1 works:

- authentication redirect/login state;
- workspace switcher;
- inbox list ordered by newest activity;
- conversation thread with inbound and outbound messages;
- reply composer and status display;
- claim/close/reopen controls;
- loading/error/retry states;
- WebSocket reconnection and replay.

The UI can remain intentionally small. A working, clear core inbox is better than an unstable feature-rich dashboard.

### Data flow summaries

#### Inbound

Pigeon -> verify signature -> validate -> deduplicate event -> atomic conversation/message update -> append workspace event -> Redis fan-out -> `2xx`.

#### Reply

grader/UI -> auth/workspace validation -> atomic reply record + conversation -> durable outbox job -> return `202` -> sender worker -> Pigeon with idempotency key -> status webhook -> ordered status update -> persisted workspace event -> Redis fan-out.

#### Claim

grader/UI -> shared claim service -> atomic Mongo update -> persisted assignment event -> Redis fan-out -> `200/409`.

#### Crash window

- Before Mongo reply/job commit: no reply is stored, but returning `202` would not happen.
- After Mongo commit before Pigeon send: durable job survives restart and sends later.
- After Pigeon accepts before HTTP response: job retries with the same key, and Pigeon deduplicates.
- After Pigeon sends before status webhook: status remains unknown/queued until the status arrives.
- Before event append: domain mutation and event publication must use transaction/outbox discipline.

### Build phases

#### Phase 1: Level 1 foundation

1. Add strict TypeScript and Zod.
2. Add Mongo/Redis readiness and lifecycle.
3. Implement reset/snapshot.
4. Implement Pigeon webhook verification and deduplication.
5. Implement inbound/upsert and atomic claim.
6. Implement stored outbound reply and sender retries.
7. Implement status update handling.
8. Add a minimal persisted sequence and WebSocket.
9. Run `npm run check` and fix only Level 1 failures.

Expected result: the grader can store and deduplicate webhooks, snapshot state, claim concurrently, accept duplicate replies, send despite Pigeon failures, and observe status updates.

#### Phase 2: Authentication and real product

1. Add OIDC/PKCE login and sessions.
2. Add workspace membership guards.
3. Add inbox/list/thread APIs.
4. Add the React login/inbox/thread/reply UI.
5. Make WebSocket reconnection replay missed frames.
6. Run `npm run check -- --levels 5`.

#### Phase 3: Restart and multiple processes

1. Make sender workers restart-safe and distributed.
2. Add durable outbox/retry leases.
3. Add shared Redis rate limiting per workspace.
4. Make claim, reset, and sequence operations multi-copy safe.
5. Add Redis cross-copy event fan-out.
6. Run levels 2 and 3.

#### Phase 4: Quality and optional work

1. Add focused tests for claim races, webhook deduplication, status ordering, and reply idempotency.
2. Add searchable Elasticsearch integration if time remains.
3. Add private notes and `PROTOCOL.md` only after core levels work.
4. Add billing only as the final bonus.

### Recommended dependencies

Backend additions:

- `zod`
- `ws`
- `@types/ws`
- `openid-client`
- A cookie/session approach such as `cookie-parser`; Redis-backed session storage can replace `express-session`
- `@types/cookie-parser` if middleware is used
- `vitest` or Node test runner
- `supertest` and `@types/supertest`

No additional HTTP client is needed because Node.js 22 provides `fetch`.

Existing scaffold dependencies should remain:

- Express
- TypeScript/tsx
- MongoDB official driver
- ioredis
- React/Vite

### Core tests

Add only high-value tests:

1. Duplicate and out-of-order Pigeon events are applied once.
2. Different simultaneous claims return only one success.
3. Repeated grader reply calls return `202` and create one outbound send.
4. Delivered-before-sent cannot regress delivered state.
5. Stale/forged/missing webhook signatures return `401`.
6. Reconnect replay returns frames after `after` and does not repeat older frames.

### .gitignore and repository hygiene

The current `.gitignore` does not hide `ai-logs/`, `DECISIONS.md`, or checker reports. Keep it that way. Do not add those paths to `.gitignore`.

---

## How to Proceed

### What "done" means

Build this in visible, measurable milestones rather than attempting all five levels at once:

1. The server starts under `PORT`, passes `/healthz`, and has reset/snapshot working.
2. A Pigeon webhook is verified and stored once.
3. A reply is stored once and sent once through Pigeon.
4. `npm run check` passes Level 1.
5. Login and workspace isolation work.
6. WebSocket replay and cross-process updates work.
7. Restart and multicopy checks pass.
8. The final full check is run and the repository is submitted.

Do not read `SUBMISSION.md` or bonus documentation until the designated final phase. Do not start implementing bonus billing or encrypted notes until the core check is stable.

### Phase A: Set up once

Run:

```bash
npm run up
npm run doctor
npm run scaffold:install
```

Initialize the repository and make regular commits. Stop the development server before running any grader command because `npm run check` starts and owns the server process.

### Phase B: Make the first vertical slice

The exact first implementation order is:

1. Add structured environment validation and graceful lifecycle handling.
2. Create MongoDB collections and unique indexes.
3. Implement `POST /__grader/reset` and `GET /__grader/snapshot`.
4. Implement signed Pigeon webhook ingestion.
5. Implement one inbound conversation with deduplication.
6. Implement atomic claim.
7. Implement `POST /__grader/reply` with a durable `(workspace, client_ref)` record.
8. Implement the Pigeon sender and status processing.
9. Run `npm run check`.

The goal at this point is only enough correctness for Level 1. Do not spend time first on auth, WebSockets, the polished UI, search, or notes.

### Phase C: Expand the product

After Level 1 works:

1. Add OIDC login and a session cookie.
2. Add `/api/me` and workspace membership authorization.
3. Add conversation list/thread APIs.
4. Add a minimal React workspace inbox.
5. Add WebSocket authentication, replay, and live updates.
6. Run `npm run check -- --levels 5`.

### Phase D: Survive restarts and multicopy behavior

After Level 5 works:

1. Make outbound jobs durable and restart-safe.
2. Add Redis/Mongo distributed locking and leases.
3. Add per-workspace Pigeon rate-limit coordination.
4. Make event sequences and missed-event replay shared.
5. Add Redis fan-out or Streams so one copy receives work from another.
6. Run `npm run check -- --levels 2` and `npm run check -- --levels 3`.

### Phase E: Focused quality and final submission

1. Add tests for claim races, webhook deduplication, status ordering, and reply idempotency.
2. Add `/health` and `/ready`.
3. Add `DECISIONS.md` with assumptions, cuts, trade-offs, and known weaknesses.
4. Run `npm run check:full`.
5. Follow `SUBMISSION.md` only at the final ten-minute stage.

### How we should work together

For each build step:

1. I inspect the relevant files and existing code.
2. I implement only the selected module.
3. We run strict TypeScript checks and the smallest relevant tests/check.
4. We review any crash window or concurrency edge.
5. We commit the working slice or checkpoint.
6. We proceed to the next module only after the slice is verified.

---

## Step 1 Verification

### Prompt

```text
okay i have complete my step 1 manually and you can verify it also
```

### Verification performed

- Ran `npm run doctor`.
- Verified Node.js 24.22.1, Git, Docker 29.9.3, Pigeon on port 4010, Mock IdP on 4020, Paybox on 4030, MongoDB on 27017, and Redis on 6379.
- Elasticsearch on 9200 is optional and was not reported as running; search can wait until later.
- Port 4000 had no application listener, which is expected because Step 1 is environment setup and the product server has not been implemented yet.
- Ran `npm run scaffold:install`.
- Both scaffold packages reported dependencies as up to date and 0 vulnerabilities.
- Checked `.env.example`; it contains the harness values and all required URL, secret, database, Pigeon, OIDC, and Paybox settings.
- Checked the scaffold environment loader; it loads `.env` and provides harness defaults.
- Checked Git status: the branch is `main`, tracking `origin/main`, and is one commit ahead; only `ai-logs/session-01.md` is currently modified.

### Result

Step 1 is verified complete: Docker-backed dependencies and mock providers are reachable, the scaffold dependencies are installed, and the environment contract is present.

### Next step

Proceed to the first backend vertical slice:

1. Storage and unique indexes.
2. `/healthz` and readiness behavior.
3. `POST /__grader/reset`.
4. `GET /__grader/snapshot`.
5. Signed Pigeon webhook ingestion.
6. Inbound deduplication and atomic claims.
7. Durable outbound reply and sender status processing.
8. Run `npm run check`.

---

## Next Step Explanation

### Prompt

```text
okay now we can go ahead for the furture steps , please tell me what is the next step and what we will do it and why and what is the importance and role of that implementation
```

### Next implementation step

Build the shared storage foundation first, followed by reset/snapshot.

### What we will implement

1. MongoDB collections and indexes for:
   - conversations keyed by `(workspace, contact)`
   - inbound event deduplication keyed by event ID
   - outbound replies keyed by `(workspace, client_ref)`
   - status event deduplication
   - workspace sequence events
   - durable outbound send jobs
2. MongoDB and Redis connection/readiness helpers.
3. `GET /healthz`, `GET /health`, and `GET /ready`.
4. `POST /__grader/reset` to clear application MongoDB data and Redis application state.
5. `GET /__grader/snapshot` with the exact workspace/contact/inbound/assignee/outbound shape.
6. Small domain services so grader and later UI routes call the same operations.

### Why this comes first

Every later feature depends on durable state. Inbound events, replies, claims, WebSocket replay, crash recovery, and multicopy operation all need the database or Redis to be the source of truth. Without this foundation, routes would use in-memory state that disappears on restart or differs between server copies.

### Its role

- MongoDB stores the application record and survives process restarts.
- Redis provides shared coordination and fast state, not a replacement for durable MongoDB records.
- Unique indexes make duplicate webhook/reply handling safe.
- Atomic updates prevent two claims or repeated operations from corrupting state.
- Reset allows the checker to start every level from a clean state.
- Snapshot lets the checker verify the system's complete current state.
- Readiness endpoints keep the server from accepting traffic before dependencies are usable.

### Importance

This is the highest-priority foundation because Pigeon retries duplicate/out-of-order events, sends may be accepted but return no response, replies may arrive repeatedly, and processes may restart or run in parallel. Durable storage and atomic transitions are what make all those behaviors safe.

### Definition of completion

This step is complete when:

- the server starts on `PORT`;
- `/healthz` returns `200`;
- `/ready` reports readiness only after MongoDB and Redis are reachable;
- reset clears application state;
- snapshot returns the documented shape;
- duplicate or concurrent state operations are safe at the database boundary;
- strict TypeScript compilation passes.

---

## Durable Storage Foundation Implemented

### Prompt

```text
ok understood , implement it
```

### Implemented

- Added Zod validation for environment variables in `scaffold/server/src/config.ts`.
- Added MongoDB connection timeout settings and clean database shutdown support.
- Added Redis clean shutdown support.
- Added shared storage models and collections in `scaffold/server/src/state.ts`:
  - conversations
  - inbound events
  - outbound replies
  - status events
  - workspace event sequences
  - outbound jobs
- Added unique MongoDB indexes for workspace/contact, Pigeon event/message identity, client refs, status events, sequence events, and outbox jobs.
- Added `POST /__grader/reset`, protected by `x-grader-token`.
- Added `GET /__grader/snapshot`, protected by `x-grader-token`.
- Added `GET /healthz`, `GET /health`, and `GET /ready`.
- `/ready` checks both MongoDB and Redis.
- Added graceful SIGTERM/SIGINT handling with a five-second forced shutdown fallback.

### Verification

- Server strict TypeScript compilation passed.
- Web strict TypeScript compilation passed.
- Started the server and verified:
  - `/healthz` returned `200`.
  - `/ready` returned `200` while MongoDB and Redis were reachable.
  - `/__grader/snapshot` without the grader token returned `401`.
  - `POST /__grader/reset` with the grader token returned `200`.
  - Empty snapshot returned both known workspaces with empty `contacts` and `outbound` maps.
- The server was stopped after smoke testing.

### Not implemented yet

This step intentionally does not yet include Pigeon webhook parsing, outbound sending, claim/reply handlers, authentication, or WebSockets. Those will be added in later vertical slices.

---

## Next Vertical Slice: Pigeon Inbound and Atomic Claims

### Prompt

```text
now what will be the next steps and tell me same as previous
```

### Next implementation step

Implement Pigeon webhook verification and inbound message storage before adding replies or UI.

### What we will implement

1. Raw-body webhook parsing for `POST /webhooks/pigeon`.
2. Pigeon signature parsing and verification:
   - Header must contain `t=<unix seconds>,v1=<hex>`.
   - Compute HMAC-SHA256 over `<timestamp>.<raw request body>` with `PIGEON_WEBHOOK_SECRET`.
   - Reject missing, malformed, mismatched, or stale signatures with `401`.
   - Return `400` for invalid JSON only when the valid-signature body cannot be parsed.
3. Unknown workspaces and unknown event types return `2xx` and are ignored.
4. Durable event deduplication using Pigeon event IDs and inbound message IDs.
5. Atomic upsert of `(workspace, contact)` conversations.
6. Append-only inbound message storage with oldest-first retrieval.
7. Atomic `POST /__grader/claim`:
   - validate the workspace,
   - create the conversation if needed,
   - return `200` for no holder or the same holder,
   - return `409` for a different holder.
8. Focused tests or smoke checks for signature validation and duplicate/claim behavior.

### Why this comes next

Pigeon is the only source of simulated customer activity. The server must prove that it can ingest unreliable, duplicate, forged, replayed, and out-of-order events before adding reply sending.

Claims are also a core concurrency test. They must be handled with MongoDB atomic operations, not by reading an assignee in memory and writing it back.

### Its role

- The webhook module is the secure ingress boundary.
- Raw-body verification prevents forged webhooks and ensures the signature is checked against the exact bytes Pigeon sent.
- Event deduplication prevents duplicate inbound messages and duplicate effects.
- Conversation upserts create a durable inbox record.
- Atomic claim operations ensure six simultaneous agents cannot assign two holders.
- This slice supplies the main inbound behavior Level 1 checks.

### Importance

This step establishes the correct ingestion semantics:

- Pigeon may retry the same event.
- Events may arrive out of order.
- Bursts may arrive close together.
- Forged or stale requests must be rejected.
- Valid events must be stored before `2xx` is returned.

Without durable deduplication and atomic state changes, Level 1 duplicate and concurrency checks would fail.

### Definition of completion

This next step is complete when:

- valid Pigeon inbound events create/update one conversation and one inbound message;
- duplicate event IDs and duplicate message IDs do not add duplicate inbound entries;
- forged, malformed, and stale webhook requests return `401`;
- valid-signature invalid JSON returns `400`;
- unknown workspaces/event types receive `2xx` and are ignored;
- simultaneous and repeated grader claims return the documented `200/409` outcomes;
- strict TypeScript compilation passes.

### What comes after it

Only after inbound and claim behavior are verified should we implement:

1. Durable outbound reply records.
2. `POST /__grader/reply`.
3. Pigeon send requests with `Idempotency-Key`.
4. `429`, `503`, timeout, and outage retries.
5. Status webhook processing.
6. `npm run check`.
