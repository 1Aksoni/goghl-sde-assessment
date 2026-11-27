# Decisions

The first version prioritizes the durable inbox path: raw-body Pigeon
verification, recoverable webhook receipts, Mongo-backed conversations and
reply outbox, lease-based retries with provider idempotency, and Redis
workspace rate limiting. OIDC uses PKCE and Redis sessions. Workspace event
sequences are persisted in Redis Streams and broadcast across instances. The
React app covers sign-in, workspace selection, inbox/thread viewing, replies,
claim/close/reopen, delivery status, and reconnecting live updates.

The reply record doubles as its outbox job because the configured MongoDB is
standalone; this avoids depending on multi-document transactions. Provider
status updates are monotonic, and unknown event types/workspaces and statuses
for unknown replies are acknowledged and ignored as required by Pigeon.
Concurrent same-reference replies tolerate a conversation upsert collision
before the unique outbox record is created.
Focused server integration tests cover claim races, inbound deduplication and
ordering, and concurrent reply idempotency with terminal status handling.

Private notes, Elasticsearch search, and billing were cut to keep the core
inbox and failure handling first. No encryption protocol is claimed. The UI
shows the IdP subject rather than a display name and has no search or private
notes yet. Sessions expire after eight hours without refresh. The contract's
Level 4 cases are written requirements rather than a locally runnable check,
so those edge cases have been implemented from the contract but cannot receive
the same automated verification as Levels 1, 2, 3, and 5.
