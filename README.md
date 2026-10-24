# WhatsApp Gateway for AI Agents

A multi-account WhatsApp gateway for **AI agents and agent frameworks**, written in TypeScript
and built on a pinned
[custom Baileys release](https://github.com/digows/baileys/releases/tag/digows-7.0.0-rc14-interactive.1).
It manages multiple accounts, durable send operations, paced delivery, rich interactive messages
and media fetched on demand. SQLite local mode or PostgreSQL shared storage keeps authentication and technical state.
PostgreSQL enforces workspace isolation with Row Level Security; SQLite enforces workspace/account
isolation in application queries and runs under one exclusive local runtime.

**Current delivery:** an embeddable gateway with authenticated HTTP, Redis Streams, signed webhooks,
embedded fleet coordination and a real remote Chat SDK Adapter. Native Mastra channels are qualified
against the released versions below. Standalone packaging/container delivery is still in progress.

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

The gateway does not bundle a model runtime. Use the application-side Chat SDK Adapter with Mastra
or another agent framework; the gateway runtime has no framework dependency.

## Implemented capabilities

| Area | Available now |
| --- | --- |
| Accounts and sessions | Multiple accounts per workspace, QR pairing, saved-auth restoration, restart-required handling, logout cleanup and bounded reconnects |
| Fleet | Embedded elected placement, per-workspace capacity, sticky/least-load assignment, revisioned desired state and fenced recovery |
| Session safety | Exclusive ownership per account, generation checks, stale-callback rejection and shutdown cleanup |
| HTTP | Authenticated commands/queries, scoped lazy media and generated OpenAPI with local interactive docs |
| Redis Streams | Scoped durable command intake/ACK/reclaim, result/event publication after local AOF acknowledgement and generated AsyncAPI |
| Events | Transactional account-scoped CloudEvents with stable identity and ordered SQL replay; signed webhook delivery with bounded retries |
| Webhooks | SQL per-destination retry queues, HMAC signatures, expiry and separate retention; success work retention defaults to zero |
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
[baseline](runtime/migrations/001_gateway_core.sql) and [storage-version migration](runtime/migrations/002_storage_version.sql) plus [command ingress](runtime/migrations/003_command_ingress.sql) and [runtime placement](runtime/migrations/004_runtime_placement.sql) plus [public events](runtime/migrations/005_public_events.sql) and [webhooks](runtime/migrations/006_webhook_outbox.sql) plus [Redis cursors](runtime/migrations/007_redis_streams.sql);
SQLite has its own [baseline](runtime/migrations/sqlite/001_gateway_core.sql) and [command ingress](runtime/migrations/sqlite/002_command_ingress.sql) and [runtime placement](runtime/migrations/sqlite/003_runtime_placement.sql) plus [public events](runtime/migrations/sqlite/004_public_events.sql) and [webhooks](runtime/migrations/sqlite/005_webhook_outbox.sql) plus [Redis cursors](runtime/migrations/sqlite/006_redis_streams.sql). These do not convert
legacy deployments or copy data when switching backends. Unsupported engines, incompatible schema
versions and invalid storage/topology combinations fail at startup.

For PostgreSQL, give a separate runtime role `USAGE` on schema `gateway` and `SELECT`, `INSERT`,
`UPDATE`, `DELETE` on its tables. It must have neither superuser privileges nor `BYPASSRLS`.
All tenant tables have forced RLS. SQLite provides local application isolation, not RLS equivalence.
The HTTP transport authenticates configured bearer credentials and checks workspace/account grants.
In-process embedders establish their own trusted workspace context.

### Compose HTTP

Create workspace-specific command ingress alongside the gateway, then enable the HTTP listener.
The token must come from a private configuration source; the example does not create a credential.

```ts
import {
  GatewayCommandIngress,
  GatewayHttpTransport,
  GatewayPrincipal,
  SqlCommandInbox,
  SqlFleetStore,
} from "@digows/whatsapp-gateway-runtime";

const commands = new GatewayCommandIngress(new SqlCommandInbox(store));
const principal = new GatewayPrincipal("agent-application", [{
  workspaceId: store.workspaceId,
  accountIds: [account.accountId],
}]);
const http = new GatewayHttpTransport(
  { enabled: true, host: "127.0.0.1", port: 8080 },
  [{ store, commands, gateway, fleet: new SqlFleetStore(store) }],
  [{ token: process.env["GATEWAY_HTTP_TOKEN"]!, principal }],
);
await http.start();
```

`/docs` provides local interactive OpenAPI. `POST /v1/commands` returns 202 after durable SQL
intake; poll the account-scoped command endpoint for the outcome. A `GatewayFleetParticipant` automatically drives
`GatewayCommandWorker.runOne(lease)` on the exclusive account owner. HTTP intake can run on a
separate PostgreSQL instance of the gateway without a local socket. An accepted command can remain
queued until an owner executes it. Selecting `{ enabled: false }` opens no HTTP listener.
Redis read-only query handling remains a separate unfinished increment.

### Deliver signed webhooks

Configure each trusted receiver against its account before events are created, then drive the dispatcher
loop independently of HTTP. The destination secret comes from private operator configuration.

```ts
import { GatewayWebhookDispatcher, SqlWebhookOutbox } from "@digows/whatsapp-gateway-runtime";

const outbox = new SqlWebhookOutbox(store);
await outbox.configure({
  workspaceId: store.workspaceId,
  accountId: account.accountId,
  id: destinationId,
  url: receiverUrl,
  secret: webhookSecret,
  enabled: true,
});
const dispatcher = new GatewayWebhookDispatcher(outbox, { enabled: true });
await dispatcher.runOnce(); // The embedder repeats this; a call processes at most one attempt.
```

Receivers verify the raw body with `verifyGatewayWebhook` from the contracts package, validate the
CloudEvent and configured workspace/account, then deduplicate its ID. Delivery is at least once.
Retries preserve the exact event bytes. The [owning use case](docs/use-cases/gateway-core.md) defines
header/transcript details and timeout/backoff/attempt/expiry/retention defaults. Success work retention
is zero by default; source event/message history and send-idempotency are preserved. A disabled
dispatcher opens no request. Shutdown aborts active requests and leaves retryable work.

### Use Redis Streams independently

Redis mode requires Redis 8.2 with AOF and `noeviction`. HTTP can be disabled. The embedder supplies
trusted account principals and drives consume/publication/retention separately from the session owner.

```ts
import { GatewayRedisTransport, SqlRedisStreamStore } from "@digows/whatsapp-gateway-runtime";

const redis = new GatewayRedisTransport(
  new SqlRedisStreamStore(store),
  { enabled: true, url: redisUrl, prefix: "gateway:v1" },
  [{ accountId: account.accountId, principal }],
);
await redis.start();
await redis.consumeOnce();
await redis.publishOnce();
```

`gatewayStreamNames(prefix, scope)` from contracts computes per-account command/result/event keys.
XADD a single `payload` field containing the same versioned command used by HTTP. Use account-specific
Redis ACL keys; never derive a producer identity from command fields. `/asyncapi.json` describes the
actual bindings and the common payloads. Runtime ACL permissions include INFO, XGROUP CREATE,
XAUTOCLAIM, XREADGROUP, XACK, XADD, WAITAOF, XTRIM and TIME (plus connection handshake).

ACK follows durable SQL intake/receipt. Publications can duplicate stable CloudEvent IDs on recovery;
consumers deduplicate. Results distinguish intake from terminal command evaluation and native delivery.
Age-based `trimOnce()` uses `ACKED`, preserving pending/unread entries. A new binding starts with future
SQL events; retained Redis history can be replayed with another group. The same stream also accepts
scoped queries and bounded private media uploads. Query/upload replies are confirmed in local AOF
before ACK; they may be re-evaluated on replay and carry no SQL account sequence. Media bytes never
enter SQL history or webhook outboxes.

### Run a fleet participant

Create accounts through the scoped store, record desired state and start one participant per configured
workspace. Reuse the same gateway instance in the HTTP workspace above.

```ts
import { GatewayFleetParticipant, SqlFleetStore } from "@digows/whatsapp-gateway-runtime";

const participant = new GatewayFleetParticipant(new SqlFleetStore(store), gateway, { capacity: 100 });
await participant.setDesired(principal, {
  apiVersion: "1",
  workspaceId: store.workspaceId,
  accountId: account.accountId,
  expectedRevision: 0,
  enabled: true,
});
await participant.start();
// On shutdown: close HTTP, then participant, then shared storage.
```

Desired state is also available through the scoped HTTP `/desired` GET/PUT endpoint. Read its revision
before a new decision; recording intent is asynchronous. A new enabled revision authorizes a restart
or fresh pairing attempt. Interrupted unpaired attempts need a new revision; paired sessions can
recover from saved credentials. PostgreSQL peers keep healthy assignments, place remaining accounts
within per-workspace capacity and obey actual exclusive account locks during handoff. SQLite runs
one local participant. See the [owning use case](docs/use-cases/gateway-core.md) for exact recovery limits.

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
Use the embedded participant above for automatic placement and recovery; the core can also be driven manually.

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

The [Chat SDK Adapter](packages/chat-adapter/src/index.ts) exposes `postWithKey()` and
`executeWithKey()` for caller-owned identity. A new ordinary `postMessage()` call allocates a new key.

### Chat SDK and Mastra interoperability

Qualified versions: **Chat SDK 4.43.0** and **Mastra core 1.79.0**. The
[generic Mastra composition](packages/chat-adapter/examples/mastra.ts) uses native Agent channels,
with the gateway Adapter configured on the consumer side. Actual integration scenarios exercise
inbound handling, model-generated replies over HTTP and Redis, history, callbacks, lazy media,
restart/deduplication with shared Chat state, conflicts and UNKNOWN. Models and WhatsApp sockets
are controlled at their outer boundaries; framework, transport and persistence are real.

Use `GatewayHttpClient` or `GatewayRedisClient` with `GatewayRemoteClient`, then construct
`WhatsAppGatewayAdapter` with the same workspace/account and the authoritative native account JID.
Pass it to Chat or native Mastra channels. Select Chat `concurrency:"concurrent"` for the qualified
handler-completion/ACK profile. Verify signed webhooks with the configured account secret, or pass
`adapter.processGatewayEvent` to `GatewayRedisEvents.consumeOnce`. Use distinct application-owned
Redis consumer groups, keep the worker running and retain shared Chat state for restart deduplication.
Unsupported controls fail explicitly; gateway-native rich formats use `executeWithKey`.

Native framework posting is not exactly-once application replay. A measured failure after an
accepted `thread.post` can produce a second send on replay because the native method supplies no
stable caller key. The explicit-key extension covers that same failure boundary with one native
effect. Retain send intent and inspect UNKNOWN under its original key. Mastra's native channel
error handler can catch a run failure, so a successful webhook also does not prove model/run success.
These limits are documented in the [owning use case](docs/use-cases/gateway-core.md#chat-sdk-and-mastra-integration-boundary).

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
GATEWAY_TEST_ADMIN_DATABASE_URL="$DISPOSABLE_ADMIN_DATABASE_URL" \
GATEWAY_TEST_REDIS_URL="$DISPOSABLE_REDIS_URL" pnpm test
```

`pnpm check` runs all three checks. Use an owned disposable PostgreSQL database with all migrations
and the restricted runtime role described above. Storage compatibility tests additionally require
an explicit disposable admin URL to create/drop isolated verification databases. Set `TMPDIR` to an
owned disposable directory for SQLite files and child-process checks. Tests require explicit fixture URLs;
they do not load `.env` or fall back to another database. Redis tests additionally require an explicit
owned AOF-enabled Redis 8.2 fixture; their capability scenario temporarily changes and restores that
fixture's AOF/eviction settings, so never point them at a shared/production service. Native socket I/O is controlled, so these
tests do not require QR pairing or live WhatsApp sends. There is no separate lint script.

## Remaining delivery qualification

Standalone bootstrap, container and installable package distribution remain in progress.
No NATS transport or full WhatsApp history import is included. Live client/R2 qualification and
production deployment remain separate work; integration tests do not pair or send to real numbers.
