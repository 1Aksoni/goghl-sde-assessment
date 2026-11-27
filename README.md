# Switchboard

Switchboard is a shared, multi-workspace support inbox. Agents sign in through
the mock OIDC provider, view incoming conversations, claim or close them, and
send replies through Pigeon. MongoDB stores durable conversation and reply
state; Redis coordinates sessions, rate limits, and replayable live events.

## Run locally

Requirements: Node.js 22+ and Docker.

```sh
cp .env.example .env
npm run up
npm run scaffold:install
```

In separate terminals, start the API and React app:

```sh
npm run scaffold:server
npm run scaffold:web
```

Open <http://localhost:5173>. The API runs on port 4000 by default. Local test
users and workspace memberships are provided by the mock identity provider.
Set service URLs, credentials, and ports in `.env`; the defaults in
`.env.example` are for the provided local services only.

## Checks

```sh
npm run doctor
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
npm run check
npm run check -- --levels 5
npm run check:full
```

The automated checks reset application data and stop Pigeon's background
inbound traffic. Restore the normal traffic after a check with:

```sh
npm run drizzle
```

`npm run check:full` writes `CHECK_REPORT.json`. For deployment/start-command
details, see [switchboard.json](./switchboard.json); implementation tradeoffs
and known limitations are in [DECISIONS.md](./DECISIONS.md).
