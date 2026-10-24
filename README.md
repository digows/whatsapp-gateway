# WhatsApp Gateway for AI Agents

A multi-account WhatsApp gateway for **AI agents and agent frameworks**, written in TypeScript
and built on a pinned
[custom Baileys release](https://github.com/digows/baileys/releases/tag/digows-7.0.0-rc14-interactive.1).
It manages multiple accounts, durable send operations, paced delivery, rich interactive messages
and media fetched on demand. SQLite local mode or PostgreSQL shared storage keeps authentication and technical state.
PostgreSQL enforces workspace isolation with Row Level Security; SQLite enforces workspace/account
isolation in application queries and runs under one exclusive local runtime.

**Current delivery:** an embeddable core, portable contracts and a partial Chat SDK mapping.
There is no standalone HTTP server, broker consumer or published ready-to-use Chat SDK Adapter yet.

## Built for agent integrations

Connect your agent application to WhatsApp through one technical boundary. The gateway owns
account sessions, native message identity, send pacing and media normalization. Your application
supplies the agent, model and conversation policy.

- **Stable send identity:** retain an operation key across agent jobs and caller retries; ambiguous
  sends remain `UNKNOWN` instead of becoming automatic duplicate replies.
- **Typing while processing:** incoming direct text can start a finite heartbeat without an Agent
  signal. Its TTL bounds the wait even when the agent never produces a reply.
- **Rich interactions:** preserve button/list selection IDs, quote targets and media metadata so
  an agent can act on structured input rather than reconstructing it from display text.
- **Media on demand:** fetch attachment bytes only when the agent application requests them.
- **Account isolation:** keep workspace/account scope separate from the WhatsApp chat and sender.

The core does not bundle a model runtime. The application-side Chat SDK package is currently a
partial mapping; a complete ready-to-use Adapter remains a target.

## Implemented capabilities

| Area | Available now |
| --- | --- |
| Accounts and sessions | Multiple accounts per workspace, QR pairing, saved-auth restoration, restart-required handling, logout cleanup and bounded reconnects |
| Session safety | Exclusive ownership per account, generation checks, stale-callback rejection and shutdown cleanup |
| Durable commands | Versioned scoped requests, explicit grants, per-account SQL ingress ordering and generation-fenced recovery |
| Durable sends | Per-account ordering, stable caller keys, payload-conflict detection, reserved native IDs and explicit `UNKNOWN` outcomes |
| Contact lookup | Account-scoped registered/unregistered/indeterminate results and authoritative native IDs; no country-specific number rewriting |
| Pacing | Randomized spacing, a rolling rate limit, progressive daily limits, a daily ceiling and inactivity reset |
| Typing | Bounded pre-send presence and a finite incoming-message heartbeat; reply, handset activity and shutdown stop it |
| Rich content | Text, explicit link previews, images, video/GIF/video notes, audio/voice notes, files, stickers, contacts, locations, polls, events and albums |
| Interactions | Reply buttons, image cards, URL buttons, lists, carousels, selection callbacks, reactions, text edits and deletions |
| Message context | Native WhatsApp IDs, quote correlation, mentions and forwarding where supported by the selected format |
| Media | Lazy bounded download/decryption without an object store, plus optional S3-compatible materialization |
| Chat SDK mapping | Real `chat@4.43.0` Message/Attachment projection, lazy attachments and an explicit stable-key text-send helper |

The [gateway use case](docs/use-cases/gateway-core.md) owns the precise behavior, failure modes and
format restrictions. Submission, delivery and read receipts are separate observations. An
`ACCEPTED` send is not proof that the recipient received or read it.

### Custom Baileys interactive messages

The runtime pins `digows-7.0.0-rc14-interactive.1`, rather than a floating Git branch. Its custom
`replyButtons`, `urlButton`, `list` and `carousel` builders are mapped to the gateway's portable
content contracts. Captured native selection responses are retained as regression fixtures.

Client support has limits: the selected carousel profile has disabled reply selection on observed
iOS clients, and horizontal navigation there remains unconfirmed. Image cards/carousels require
JPEG media; some interactive profiles reject quotes, expiration, mentions or forwarding. The core
reports unsupported combinations instead of silently changing the format. Controlled tests do not
establish rendering on every WhatsApp client or current server acceptance.

### Pacing and anti-ban controls

The implemented controls commonly described as **anti-ban** are pacing and session-safety controls:
randomized 1.5–5 second spacing, eight attempts per rolling 60 seconds, a first-day limit of 60
that grows during seven warm-up days, a 1,500 daily ceiling and a reset after 168 hours of inactivity.
These are configurable gateway defaults, not WhatsApp-approved quotas. Typing is bounded and
cleaned up; send retries never invent a fresh operation after an ambiguous outcome.

These controls do not guarantee protection from account restrictions or bans. The project uses
Baileys to connect to WhatsApp Web; it is not Meta's official WhatsApp Business Platform.

## Get started from source

Requirements: Node.js 24 or newer and pnpm 12.9.1. Choose a local SQLite file or PostgreSQL 18.
Shared multi-runtime storage requires PostgreSQL; SQLite is restricted to one runtime on local disk.
Incoming attachments work on demand without object storage. Select S3-compatible materialization
when shared stored-media access is needed. Permanent application archives belong to the consumer.

```sh
git clone https://github.com/digows/whatsapp-gateway.git
cd whatsapp-gateway
pnpm install --frozen-lockfile
```

Migrations are explicit. Use `migrateGatewayStorage(configuration)` once with administrative access,
then `openGatewayStorage(configuration)` for startup. PostgreSQL applies the
[baseline](runtime/migrations/001_gateway_core.sql) and [storage-version migration](runtime/migrations/002_storage_version.sql) plus [command ingress](runtime/migrations/003_command_ingress.sql);
SQLite has its own [baseline](runtime/migrations/sqlite/001_gateway_core.sql) and [command ingress](runtime/migrations/sqlite/002_command_ingress.sql). These do not convert
legacy deployments or copy data when switching backends. Unsupported engines, incompatible schema
versions and invalid storage/topology combinations fail at startup.

For PostgreSQL, give a separate runtime role `USAGE` on schema `gateway` and `SELECT`, `INSERT`,
`UPDATE`, `DELETE` on its tables. It must have neither superuser privileges nor `BYPASSRLS`.
All tenant tables have forced RLS. SQLite provides local application isolation, not RLS equivalence.
The application establishes the trusted workspace; the core does not authenticate remote callers.

### Compose the core

Packages currently export TypeScript source and are private workspace packages. Run TypeScript
through your host tooling, such as `tsx`; there is no `start` script or packaged service binary.
This example provisions an account without opening a WhatsApp connection:

```ts
import { randomUUID } from "node:crypto";
import { BaileysConnection, Gateway, migrateGatewayStorage, openGatewayStorage } from "./runtime/src/index.ts";

const configuration = { engine: "sqlite", filename: "./gateway.sqlite", mode: "local" } as const;
// Explicit setup step; PostgreSQL migrations require an administrative connection.
await migrateGatewayStorage(configuration);
const storage = await openGatewayStorage(configuration);

// Supply the workspace from your application's authenticated context.
const workspaceId = randomUUID();
const store = storage.workspace(workspaceId);
const gateway = new Gateway(store, (_account, lease) => new BaileysConnection(store, lease));

try
{
  const account = await store.createAccount();
  console.log(account.accountId, account.state);
}
finally
{
  await gateway.close();
  await storage.close();
}
```

Retain the workspace/account IDs in your application. Explicit `gateway.start(accountId)` begins
connection or pairing; inspect `store.account(accountId)` for state and the private QR PNG data URL.
Starting returns before the session necessarily becomes `CONNECTED`. `gateway.restore()` makes a
single pass over saved paired accounts. Close the gateway before closing shared storage.
For PostgreSQL, select `{ engine: "postgresql", url, mode: "cluster" }` with the restricted runtime URL.
Cluster storage currently supplies exclusive ownership; automatic placement is still pending.

For outbound operations, use the [portable schemas](packages/contracts/src/index.ts) and retain the
caller-owned `idempotencyKey`. Retry/status lookup must use the same workspace, account and key.
A changed payload under the same key is a conflict. An `UNKNOWN` outcome must be inspected through
`gateway.operation(accountId, key)`; it must not trigger a fresh automatic send. Database ownership
cannot fence an effect already dispatched to WhatsApp.

Use `gateway.lookupContactAddress(accountId, address)` to resolve a phone address. A `REGISTERED`
result contains `resolvedAddress`; retain that native address in durable send jobs. Explicit
negatives remain distinct from incomplete responses, timeout, unavailable sessions and unsupported
identities. Lookup does not send a message. Operation results carry workspace/account, and UUID
case aliases normalize to the same account identity in the core, locks, SQL and SDK context.

The [Chat SDK mapping](packages/chat-adapter/src/index.ts) exposes `postWithKey()` for durable caller
identity. A new ordinary `postMessage()` call allocates a new key. Full Adapter initialization,
event intake/dispatch, history and standard card/action/formatting translation remain incomplete.

## Media delivery modes

The default core path reads incoming source media directly, without S3. Normalization exposes an
opaque scoped handle; the lazy attachment fetch downloads/decrypts only when requested. Reads have
byte/time limits and explicit expiry/integrity failures. Downloaded media bytes are not stored in SQL.

For optional materialization, `createMediaStorage()` accepts `mode: "s3"`, `endpoint`, `region`,
`bucket`, `forcePathStyle` and credentials. Pass its repository to both `BaileysConnection` and
`Gateway`, and destroy its client on shutdown. `mode: "direct"` creates no S3 client. Configure
`maximumMediaBytes` (default 32 MiB) and `mediaTimeoutMs` (default 60 seconds) on the gateway.
Pass matching `maximumBytes`/`timeoutMs` as the factory's second argument for S3 transfers.

Cloudflare R2 uses the same S3 adapter with its endpoint, region `auto` and R2 credentials; a public
bucket is not required. See the [official AWS SDK configuration example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).
R2 live access has not been tested. Outbound stored-media sends still require a media repository;
direct incoming access does not provide an implicit outbound upload/archive service.

## Development and validation

```sh
pnpm format:check
pnpm typecheck
GATEWAY_TEST_DATABASE_URL="$DISPOSABLE_RUNTIME_DATABASE_URL" \
GATEWAY_TEST_ADMIN_DATABASE_URL="$DISPOSABLE_ADMIN_DATABASE_URL" pnpm test
```

`pnpm check` runs all three checks. Use an owned disposable PostgreSQL database with both migrations
and the restricted runtime role described above. Storage compatibility tests additionally require
an explicit disposable admin URL to create/drop isolated verification databases. Set `TMPDIR` to an
owned disposable directory for SQLite files and child-process checks. Tests require explicit fixture URLs;
they do not load `.env` or fall back to another database. Native socket I/O is controlled, so these
tests do not require QR pairing or live WhatsApp sends. There is no separate lint script.

## Next, not implemented yet

- Independently configurable HTTP commands/queries, webhook events and Redis Streams messaging.
- A complete, ready-to-use Chat SDK Adapter.
- Automatic account placement, balancing and failover across peer runtimes.
- Durable webhook retries with explicit delivery and retention policies.

These are design targets, not current setup options. NATS is a future compatibility target.
There is no full WhatsApp history service. Live client/S3 parity, application replay qualification,
release packaging and deployment remain separate validation work.
