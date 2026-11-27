# AI Session 05

## Prompt

```text
Audit `PIGEON.md` ("How your endpoint must answer") and `BRIEF.md` contract rules against `scaffold/server` to make sure we haven't missed any Level 4 edge case, and add focused automated tests (`npm test` in `scaffold/server`) covering: (1) concurrent claim race (`200` vs `409`), (2) duplicate/out-of-order inbound webhook deduplication and oldest-first ordering, and (3) `client_ref` reply idempotency + monotonic status transitions. Run the tests and `npm run check:full` if server code changed, update `DECISIONS.md` if needed, and log this in `ai-logs/session-05.md`.
```

## Response

Audited the Pigeon endpoint-answer rules and the BRIEF's server contracts
against the webhook, persistence, reply worker, auth/API, and realtime paths.
No other missed Level 4 response behavior was identified. The written Level 4
requirements still do not have a local grader.

### Fix

The audit found a concurrent `client_ref` race in `createReply`: concurrent
requests could both try to upsert the same conversation, and the losing
conversation insert could raise Mongo's duplicate-key error before the
idempotent unique outbox insert was reached. The code now confirms the
conversation exists after that collision and continues to the reply's unique
`(workspace, clientRef)` insert.

### Tests

Added `npm test` for `scaffold/server` using isolated MongoDB and Redis
databases. The focused tests cover:

- Two simultaneous claims produce one winner (`200`) and one conflict
  (`409`); the winner can claim again.
- Duplicate webhook event/message IDs apply once, and thread messages are
  returned oldest first despite out-of-order arrival.
- Eight concurrent reply creations with one `client_ref` persist one reply;
  `queued -> sent -> delivered` remains terminal against late `sent`/`failed`
  events, and `delivered` can arrive before `sent`; the `failed` terminal path
  is also checked against a late `sent`.

### Verification

- `cd scaffold/server && npm test`: **3/3 passed**.
- `npm --prefix scaffold/server run typecheck`: passed.
- `npm run check:full`: **75/75** across Levels 1, 2, 3, and 5; refreshed
  `CHECK_REPORT.json`.
- Restored Pigeon's normal inbound trickle with `npm run drizzle`.
