# WhatsApp Gateway for AI Agents

A multi-account WhatsApp gateway for **AI agents and agent frameworks**, written in TypeScript
and built on a pinned
[custom Baileys release](https://github.com/digows/baileys/releases/tag/digows-7.0.0-rc14-interactive.1).
It manages multiple accounts, durable send operations, paced delivery, rich interactive messages
and media fetched on demand. SQLite local mode or PostgreSQL shared storage keeps authentication and technical state.
PostgreSQL enforces workspace isolation with Row Level Security; SQLite enforces workspace/account
isolation in application queries and keeps one private database file per workspace, with one local runtime
owner per file. That workspace's accounts share its file.

**Delivery:** a standalone or embedded gateway with authenticated HTTP, Redis Streams, signed webhooks,
embedded fleet coordination and a remote Chat SDK Adapter. Native Mastra channels and freshly
installed consumer packages are qualified against the released versions below. The container uses
Node.js 24 and runs independently of the consumer agent framework.

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
| Chat SDK / Mastra | Remote Adapter, native Mastra channels, history, lazy attachments, interaction callbacks and explicit stable-key operations |
| Operations | Explicit configuration/migrations, CLI, readiness, structured component log levels and a non-root container |

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
Shared cluster storage requires PostgreSQL; each SQLite workspace file has one exclusive runtime
owner on local disk.
Incoming attachments work on demand without object storage. Select S3-compatible materialization
when shared stored-media access is needed. Permanent application archives belong to the consumer.

```sh
git clone https://github.com/digows/whatsapp-gateway.git
cd whatsapp-gateway
pnpm install --frozen-lockfile
```

Build the compiled CLI and packages, then prepare a private configuration based on
[config/operator.example.json](config/operator.example.json). Replace the example IDs/token and choose
a writable local SQLite directory. The template uses `/data/workspaces` for the container; change it
for a source checkout. Files are named `<canonical-workspace-id>.sqlite`; accounts do not create
separate files. Its account starts disabled, so setup does not initiate pairing.

```sh
pnpm build
node runtime/dist/cli.js --help
node runtime/dist/cli.js migrate --config /absolute/path/gateway.json
node runtime/dist/cli.js verify-storage --config /absolute/path/gateway.json
node runtime/dist/cli.js serve --config /absolute/path/gateway.json
```

`GATEWAY_CONFIG` can supply the explicit JSON path. `pnpm start --config ...` and
`pnpm migrate --config ...` invoke the same compiled CLI. Configuration is strict; unknown fields,
invalid grants and unsupported backends fail. The CLI does not load `.env` or old authentication
directories. Keep configuration private: it may contain tokens, database URLs and object-store keys.

Migrations are explicit and versioned under [runtime/migrations](runtime/migrations), including
[gateway-observed history](runtime/migrations/008_message_history.sql) and its
[SQLite counterpart](runtime/migrations/sqlite/007_message_history.sql), followed by schema 9
[workspace file binding](runtime/migrations/sqlite/008_workspace_binding.sql) and the
[PostgreSQL version marker](runtime/migrations/009_workspace_storage.sql). Apply them once with an
administrative configuration, then serve with a restricted runtime configuration. Startup verifies
the schema without migrating. Backend selection does not convert legacy data or copy it between engines.

The operator SQLite configuration now requires `storage.directory`; the old global `storage.filename`
configuration is rejected. The CLI migrates/verifies every configured workspace file. PostgreSQL
still uses one shared connection pool with workspace RLS. Each versioned migration commits within its selected file. An upgrade spanning versions or files
is not one transaction: completed earlier steps may remain, and a failed command can be rerun
after correcting its cause.

This does not split, move or import data from the published single-file layout. Keep existing files
and backups while planning explicit placement. The low-level storage API can explicitly upgrade a
legacy file only when every tenant row belongs to its selected workspace; mixed-workspace files
are rejected before schema changes. It never chooses a workspace from existing data. No automatic
legacy splitter or backend converter is supplied.

For PostgreSQL, give a separate runtime role `USAGE` on schema `gateway` and `SELECT`, `INSERT`,
`UPDATE`, `DELETE` on its tables. It must have neither superuser privileges nor `BYPASSRLS`.
All tenant tables have forced RLS. SQLite provides local application isolation, not RLS equivalence.
The HTTP transport authenticates configured bearer credentials and checks workspace/account grants.
In-process embedders establish their own trusted workspace context.

### Standalone operation and logs

The CLI opens each configured workspace's SQLite file (or the shared PostgreSQL storage),
provisions configured accounts, preserves durable desired state and runs fleet, command,
Redis and webhook loops. An omitted account `enabled` leaves its recorded intent unchanged; an
explicit value updates it only when different. To authorize a fresh pairing attempt, use a new CAS
revision through `/desired`; restarting the process does not manufacture new pairing intent.
Read QR/account state through the authenticated scoped API. The default direct media mode needs no
object store. Optional S3-compatible configuration uses the same limits as the core.

`GET /health/live` reports that HTTP is listening. `GET /health/ready` reports running state plus the
latest SQL/Redis probes, and becomes unavailable during startup/drain. It does not assert that every
WhatsApp account is connected. An embedded HTTP transport without readiness hooks returns 503.
Redis-only mode (`http.enabled:false`) opens no HTTP port and reports startup through JSON logs.
The example binds the container interface; for a source process, use `127.0.0.1` unless a controlled
listener is intended. Provide TLS at your deployment boundary when exposing authenticated HTTP.
Interactive documentation is at `/docs`; schemas are at `/openapi.json` and `/asyncapi.json`.

Logs are JSON with `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent` thresholds. For example:

```json
{"logging":{"level":"info","components":{"baileys":"trace","sessions":"debug","http":"debug"}}}
```

Available component overrides are `runtime`, `sessions`, `baileys`, `http`, `redis`, `webhooks` and
`fleet`. Session logs include scope/generation and state changes; HTTP logs include request identity,
route, status and duration. Protocol logs keep classified signals or hashes and safe error codes,
without raw protocol objects, message bodies, QR/authentication material or credentials. Intentional
socket shutdown is logged at debug level without an error stack.

### Run the container

Build from the reviewed source; the Dockerfile pins Node.js 24.18.0 and runs as UID 1000. Publication
requires native checks and container qualification on **linux/amd64** and **linux/arm64**, followed
by a verified multi-platform index. The release records the measured platforms and immutable digest.
The image contains the runtime and contracts, without Chat SDK or Mastra dependencies.

```sh
GATEWAY_IMAGE=ghcr.io/digows/whatsapp-gateway:2.0.1
docker pull "$GATEWAY_IMAGE"
docker volume create whatsapp-gateway-data
# gateway.json must be readable by container UID 1000 and use directory /data/workspaces.
docker run --rm --mount type=volume,src=whatsapp-gateway-data,dst=/data \
  --mount type=bind,src=/absolute/path/gateway.json,dst=/run/secrets/gateway.json,readonly \
  "$GATEWAY_IMAGE" migrate
docker run --name whatsapp-gateway --stop-timeout 90 -p 127.0.0.1:8080:8080 \
  --mount type=volume,src=whatsapp-gateway-data,dst=/data \
  --mount type=bind,src=/absolute/path/gateway.json,dst=/run/secrets/gateway.json,readonly \
  "$GATEWAY_IMAGE" serve
docker stop whatsapp-gateway
```

For a local source build, select its own image tag and use that value with the same migrate/serve
commands above:

```sh
GATEWAY_IMAGE=whatsapp-gateway:local
docker buildx build --platform linux/arm64 --load --tag "$GATEWAY_IMAGE" \
  --build-arg GATEWAY_VERSION="$(node scripts/release.mjs check)" \
  --build-arg GATEWAY_REVISION="$(git rev-parse HEAD)" .
```

Bind paths belong to the Docker daemon host when using a remote context. Keep configuration outside
the build context; the build allowlist excludes `.env`, saved auth, tests and private operator files.
For PostgreSQL, replace the SQLite storage configuration with the qualified PostgreSQL URL/mode;
use separate administrative migration and restricted runtime configuration files. HTTP/media/native
work has bounded waits, so allow drain time rather than relying on Docker's default ten seconds.
SIGINT/SIGTERM stop admission and new account starts, drain work, release leases and close storage.

The [qualification script](scripts/qualify-container.py) creates isolated labeled containers and a
volume, checks two private workspace files and their accounts, migration/verification/startup/readiness,
durable intake, SIGTERM and restart, then removes only
its resources. Set `TMPDIR` to an owned disposable directory and pass a locally available image.
It uses no external network or real WhatsApp session. The
[workflow](.github/workflows/qualify-and-publish.yml) runs configured checks and archives consumer
tarballs and `SHA256SUMS`. Manual publication requires the exact reviewed main SHA and publishes
its immutable SHA image. Annotated release tags additionally publish versioned images and a stable
GitHub Release after all configured checks and the container smoke pass. A workflow definition
alone is not proof of publication.

### Versioning and releases

The repository, runtime, contracts and Chat Adapter share **SemVer 2.0.1**.
Git tags use `v<version>` (for example `v2.0.1`); GHCR uses `2.0.1`, the moving major alias `2`,
and `latest`. Release 2.0.0 remains the original ARM64 artifact. New publications qualify both
native architectures before assembling their shared image tag. Pin the version or, for immutable
deployments, the image digest reported in the GitHub Release. The SHA image tag identifies its source commit.
Major and latest aliases can move on subsequent stable releases.

Package SemVer is independent of the wire protocol (`apiVersion: "1"`) and database schema (9).
Release 2.0.1 does not change either identifier or imply that the proposed Mastra durable consumer
binding is complete. Its measured native-framework limitations remain documented below and in the
[owning use case](docs/use-cases/gateway-core.md).

Maintainers update all four manifests together, add release notes under `docs/releases/<version>.md`,
and run `pnpm release:check`. After review, push the accepted main commit and create an annotated tag
on that exact commit:

```sh
git tag -a v2.0.1 <accepted-commit> -m 'WhatsApp Gateway 2.0.1'
git push origin main
git push origin v2.0.1
```

The tag workflow rejects mismatched versions, lightweight tags and commits outside main. It runs
the configured checks, validates compiled consumer packages, smoke-tests the image and verifies
its version/revision labels before publication. It then publishes the stable GitHub Release with
the exact consumer archives and checksums. Never move a released tag or replace release assets;
use a new patch version for corrections. No npm registry publication is performed.

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
HTTP and Redis expose the same scoped query and private media-upload contracts.

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

Redis mode requires Redis 8.2 or later within 8.x, with AOF and `noeviction`. The qualification
matrix exercises Redis 8.2.10 and 8.10.2 on both native platforms. HTTP can be disabled. The embedder supplies
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
// On shutdown: begin participant.close() before awaiting HTTP drain; close storage last.
```

Desired state is also available through the scoped HTTP `/desired` GET/PUT endpoint. Read its revision
before a new decision; recording intent is asynchronous. A new enabled revision authorizes a restart
or fresh pairing attempt. Interrupted unpaired attempts need a new revision; paired sessions can
recover from saved credentials. PostgreSQL peers keep healthy assignments, place remaining accounts
within per-workspace capacity and obey actual exclusive account locks during handoff. SQLite runs
one local participant per owned workspace file. See the [owning use case](docs/use-cases/gateway-core.md) for exact recovery limits.

### Compose the core

Packages export compiled JavaScript and declarations after `pnpm build`; workspace tests select the
explicit `development` source condition. This example provisions an account without opening a
WhatsApp connection:

```ts
import { randomUUID } from "node:crypto";
import { BaileysConnection, Gateway, migrateGatewayStorage, openGatewayStorage } from "@digows/whatsapp-gateway-runtime";

const workspaceId = randomUUID();
const configuration = {
  engine: "sqlite", filename: `./${workspaceId}.sqlite`, workspaceId, mode: "local",
} as const;
// Explicit setup step; PostgreSQL migrations require an administrative connection.
await migrateGatewayStorage(configuration);
const storage = await openGatewayStorage(configuration);

// Use the same selected workspace from your application's authenticated context.
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
single pass over saved paired accounts. Close the gateway before closing its storage. A SQLite storage instance rejects another workspace
even when constructed through a scoped store directly; PostgreSQL exposes multiple RLS-scoped stores.
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

### Install the consumer packages

Download the versioned archives and `SHA256SUMS` from the selected GitHub Release. For 2.0.1:

```sh
gh release download v2.0.1 --repo digows/whatsapp-gateway \
  --pattern '*.tgz' --pattern SHA256SUMS --dir ./gateway-2.0.1
cd gateway-2.0.1
shasum -a 256 -c SHA256SUMS
```

Alternatively, run `pnpm build` and pack from the matching source revision into an owned artifact
directory, or obtain the matching `gateway-consumer-packages-<commit>` CI artifact:

```sh
pnpm --dir packages/contracts pack --pack-destination /absolute/path/artifacts
pnpm --dir packages/chat-adapter pack --pack-destination /absolute/path/artifacts
node scripts/release.mjs artifacts /absolute/path/artifacts
```

Copy both tarballs into the consumer project and pin pnpm 12.9.1. Install both files plus
`chat@4.43.0`; for Mastra add `@mastra/core@1.79.0`. With pnpm, supply these local resolutions in the
consumer's `pnpm-workspace.yaml` so the Adapter's contracts dependency resolves to the same artifact:

```yaml
overrides:
  '@digows/whatsapp-gateway-contracts': file:./digows-whatsapp-gateway-contracts-2.0.1.tgz
  chat: 4.43.0
```

```sh
pnpm add ./digows-whatsapp-gateway-contracts-2.0.1.tgz \
  ./digows-chat-adapter-whatsapp-gateway-2.0.1.tgz chat@4.43.0
# Only consumers using the optional Mastra composition need this peer:
pnpm add @mastra/core@1.79.0
```

Import the compiled Adapter from `@digows/chat-adapter-whatsapp-gateway`. The optional
`@digows/chat-adapter-whatsapp-gateway/examples/mastra` export provides
`createMastraGatewayExample({ adapter, model, state, storage })`, using released native channels.
The consumer supplies actual model credentials, Chat state and Mastra storage; the gateway owns none
of them. The installed-package test uses a controlled model and in-memory fixtures only for isolation.
Use shared durable Chat state for restart deduplication; this does not turn native fresh-key replies
or caught model failures into durable application outcomes. The integration example preserves the
replay/acknowledgement limits described above.

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
pnpm build
GATEWAY_TEST_PNPM_STORE="$OWNED_POPULATED_PNPM_STORE" \
GATEWAY_TEST_DATABASE_URL="$DISPOSABLE_RUNTIME_DATABASE_URL" \
GATEWAY_TEST_ADMIN_DATABASE_URL="$DISPOSABLE_ADMIN_DATABASE_URL" \
GATEWAY_TEST_REDIS_URL="$DISPOSABLE_REDIS_URL" pnpm test
```

`pnpm check` runs formatting, strict type checking, compilation and tests. Use an owned disposable PostgreSQL database with all migrations
and the restricted runtime role described above. Storage compatibility tests additionally require
an explicit disposable admin URL to create/drop isolated verification databases. Set `TMPDIR` to an
owned disposable directory for SQLite files and child-process checks. Tests require explicit fixture URLs;
they do not load `.env` or fall back to another database. Redis tests additionally require an explicit
owned AOF-enabled Redis 8.2 fixture; their capability scenario temporarily changes and restores that
fixture's AOF/eviction settings, so never point them at a shared/production service. Test files run
serially because that scenario mutates fixture-wide settings; explicit concurrency scenarios within
files still exercise overlapping operations. Installed-package tests need an owned populated pnpm
store and may read registries for missing consumer dependencies. Native socket I/O is controlled, so these
tests do not require QR pairing or live WhatsApp sends. There is no separate lint script.

## Qualification boundaries

No NATS transport or full WhatsApp history import is included. Live client/R2 qualification and
production deployment remain separate work; integration tests do not pair or send to real numbers.
Container and installed-consumer checks validate their stated platform and pinned package versions,
not every WhatsApp client or future framework release.
