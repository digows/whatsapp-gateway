# Use case: Gateway accounts, sends and observed messages

This document owns the transport-independent gateway behavior. The standalone runtime, portable
contracts, remote Chat SDK Adapter and generic native Mastra integration are implemented here.
Versioned SQL ingress, embedded placement, HTTP/Redis commands and queries, public CloudEvents,
signed SQL webhook delivery, AsyncAPI and container/package distribution share the contracts below.
No legacy NATS subject is retained as a compatibility contract.

## Actors and boundaries

An authenticated integration supplies a trusted workspace context and a gateway account ID.
The embedded HTTP transport authenticates bearer credentials and maps them to explicit principal grants.
The core remains transport-independent; in-process embedders establish their trusted context.
Gateway-owned UUIDs are normalized to lower-case before map keys, locks, SQL identity and SDK thread
encoding. These UUIDs are separate from native WhatsApp JIDs. Send-operation snapshots/results carry
workspace/account explicitly; persistence rejects an operation whose identity differs from its lease.
The SDK also rejects a returned operation from another scope.
PostgreSQL RLS isolates technical tenant rows by `workspace_id`; SQLite local mode enforces the same
workspace/account keys in application queries and constraints, without database RLS. Callers never select a workspace
from an unverified incoming event. Account IDs, WhatsApp JIDs and phone aliases are transport
identity, not application Person, Household or Case policy.

## Storage selection and startup

`StorageConfigurationSchema` accepts only the implemented `sqlite` and `postgresql` engines.
SQLite requires a durable local filename and `mode: local`; PostgreSQL accepts local or shared
cluster mode and is currently qualified against PostgreSQL 18. Another Kysely dialect is not a
supported backend. Changing configuration does not transfer data between engines.

`migrateGatewayStorage()` is an explicit administrative step. PostgreSQL uses the immutable
`runtime/migrations/001_gateway_core.sql` plus `002_storage_version.sql`, `003_command_ingress.sql` `004_runtime_placement.sql` `005_public_events.sql` `006_webhook_outbox.sql`, `007_redis_streams.sql` and `008_message_history.sql`; SQLite uses
`runtime/migrations/sqlite/001_gateway_core.sql` plus `002_command_ingress.sql` `003_runtime_placement.sql` `004_public_events.sql` `005_webhook_outbox.sql`, `006_redis_streams.sql` and `007_message_history.sql`. Schema version metadata is intentionally system-level,
not tenant-owned. Unknown versions fail instead of being reset. Migration does not convert legacy
authentication directories or old deployments. PostgreSQL migration calls serialize on an advisory lock.

`openGatewayStorage()` verifies the actual schema version/required columns and driver capabilities
before exposing scoped stores. PostgreSQL requires the qualified server version, a non-superuser,
non-BYPASSRLS runtime role, forced RLS on every tenant table and the expected workspace policies.
SQLite requires foreign keys, valid existing foreign-key integrity, JSON support and the SQL version
needed by the implemented queries. Invalid combinations fail explicitly and release their resources.

SQLite requires a private regular database file (0600) and rejects symbolic links or group/other
access. It retains an OS-backed exclusive lock for the runtime's database connection lifetime. A second
runtime/process cannot open that file concurrently; process death releases the OS lock. Multiple
workspaces/accounts share the one storage instance through `storage.workspace(workspaceId)`. SQLite
WAL files are local, never a cross-host/shared-filesystem ownership mechanism. PostgreSQL preserves
its dedicated account advisory locks and generation fences. Cluster participants coordinate over shared PostgreSQL; the local SQLite participant remains under
the exclusive file owner. Runtime membership and desired state also retain explicit workspace keys.

Apply migrations with an administrative role; grant the PostgreSQL runtime role schema usage and
SELECT/INSERT/UPDATE/DELETE on its tables. The runtime does not silently migrate on startup.
Close gateways before closing their shared storage. The PostgreSQL convenience store also verifies
compatibility before its first transaction. Core and Baileys authentication use the owning store/lease
ports, not PostgreSQL client types. Serialized Baileys credentials/Signal keys remain private SQL data.

## Versioned durable command ingress

`GatewayCommandSchema` owns version `1` send, presence and contact-lookup requests. Every command,
receipt and response carries workspace/account/request identity. Unsupported versions and unknown
fields fail validation. The authenticated transport constructs `GatewayPrincipal` from trusted
credentials/configuration, never a caller-supplied principal. Explicit workspace/account grants
(or an explicit account wildcard within a workspace) are checked before submit and result reads.
The workspace-specific ingress also rejects routing to another workspace store.

`requestId` identifies durable command delivery; a send's `idempotencyKey` identifies the native effect.
A retried transport delivery retains its request ID. Separate requests can intentionally reference the
same native operation key without another effect. Reusing a request ID within its workspace/account
with a different canonical payload fails. Results retain the original sequence and identity.

SQL serializes per-account intake, assigns a sequence and commits before returning PENDING.
Intake does not require a locally owned WhatsApp socket. A `GatewayCommandWorker` claims only while
holding the actual exclusive account lease and generation. Only the earliest unfinished command
can execute; concurrent claims within a generation do not overtake it. Commands are PENDING,
EXECUTING, COMPLETED or FAILED. Terminal results cannot be overwritten. Failures expose a bounded
failure code instead of raw provider errors or private native content.

A new ownership generation can reclaim interrupted EXECUTING commands; wall-clock age never steals
work from a live owner. Stale claims cannot commit after ownership changes. A native send accepted
before an ingress-completion failure is replayed through its original operation key. Interrupted
IN_FLIGHT sends recover as UNKNOWN and remain UNKNOWN in the command response, with no automatic
resend. COMPLETED means command evaluation finished; it does not turn UNKNOWN into success or
ACCEPTED into delivery. SQL failures while recording a completion leave recovery possible rather
than rewriting the command as an execution failure. Command history is separate from later webhook
retention. A fleet participant automatically schedules `runOne()` only for its actual owned/assigned accounts.
An embedder may also drive the worker explicitly. The Redis transport remains a subsequent increment.

## Transactional public events and replay

`GatewayCloudEventSchema` owns structured CloudEvents 1.0 envelopes. Public event types are versioned
under `com.digows.whatsapp.*.v1`: account updates/desired state, retained messages, normalization
rejection observations, native delivery observations, send-operation changes and command changes.
Each envelope has an immutable UUID, source `urn:digows:whatsapp-gateway`, observation time,
account subject, authenticated-routing workspace/account extensions and a per-account sequence.
The envelope identity must match the owning data's workspace/account. These technical events carry
no Agent outcome or business-approval inference.

The `public_event` table is separate from retained private native protocol data and send-idempotency
records. Every public append happens inside the SQL transaction changing its owning state. Account
row serialization assigns sequence before commit on both qualified engines. A publication persistence
failure rolls back the state change; there is no independent network send inside these transactions.
Private native envelopes, authentication keys and provider media URLs do not enter this public log.
Pairing QR/account state is scoped integration data and must reach only authorized destinations.

Duplicate native retention/receipt inserts do not create another public event. Repeated equivalent
state/operation snapshots likewise do not create another transition. Actual command claim/recovery
transitions remain visible. `SqlGatewayEventLog.after(accountId, sequence, limit)` replays scoped
committed events in per-account sequence, with stable IDs across process/storage reopen. There is
no global cross-account order. This trusted in-process reader does not replace transport authentication.
The log is not automatically trimmed in this increment; future delivery-state retention must not delete
this history/idempotency or rescan it to recreate successful webhook deliveries. Public SQL retention and webhook delivery are implemented; Redis publication uses separate SQL cursors.
No delivery guarantee is inferred from the CloudEvents format itself.

## Signed webhook outbox, retries and retention

`SqlWebhookOutbox.configure()` accepts a trusted operator destination: workspace/account, stable
UUID, HTTP(S) URL without embedded credentials, signing secret and enabled flag. No public caller can
set its own delivery URL/principal through a command. Configuration serializes on the account row.
Multiple enabled destinations receive independent delivery work. Disabled destinations receive no
new work. A disabled dispatcher makes no requests; an embedder can pause dispatch independently of
spooling. The standalone runtime wires independent delivery loops and reconciles trusted configured
destinations before dispatch; destinations omitted from current configuration are disabled, retaining
their history.

When a public event commits, the same transaction inserts one `webhook_delivery` row per currently
enabled scoped destination. It stores the exact serialized body for byte-identical retries, including
across PostgreSQL JSONB normalization, process restart or later serializer changes. Enabling a new
destination does not backfill old public history. Successful task deletion never causes a history scan
that recreates the delivery. Public event/native message history and send-idempotency remain separate.

Dispatch claims only the oldest unfinished event for a destination and records its attempt/token/lease
before the HTTP call. Claims are exclusive under SQL serialization, and stale completion cannot change
a newer attempt. Another runtime can reclaim an expired claim. The HTTP request occurs outside SQL
transactions. Fair destination rotation lets separate destination queues progress. Per-account source
sequence remains available to consumers; delayed requests at the receiver can still complete after a
timeout, so external effect order/exactly-once delivery is not promised.

POST uses `application/cloudevents+json`. All 2xx statuses acknowledge receiver acceptance, not Agent
processing. Other statuses and network errors retry; redirects are not followed. Response bodies are
cancelled rather than downloaded. The request timeout is bounded by the remaining delivery lifetime.
A timeout/crash after receiver acceptance can duplicate the same event. Receivers must retain an
idempotency key by event ID before acknowledging durable intake. `SUCCEEDED`, `EXHAUSTED` and
`EXPIRED` are terminal; stop aborts an active request and preserves retryable work. SQL completion
failure leaves the claim recoverable instead of claiming delivery success.

`WebhookDeliveryPolicySchema` is the owning tuning surface. Defaults are a 10-second request timeout,
1-second initial retry delay, 60-second cap, 12 attempts, 24-hour delivery lifetime and seven-day terminal
retention. Retry delay doubles with bounded 50–100% jitter. These are application defaults, not provider
quotas. Delivery lifetime is distinct from terminal retention. Successful delivery retention defaults
zero: the successful delivery record/body is deleted in its completion transaction. Nonzero success
retention is configurable separately. Cleanup removes only webhook delivery records at their own
terminal deadline; it does not delete event/message history, native authentication or operation keys.

Webhook authentication is HMAC-SHA256 over the exact bytes of
`UTF8(timestamp + "." + eventId + ".") || rawBody`. Headers are `x-gateway-event-id`,
`x-gateway-timestamp` (Unix seconds) and `x-gateway-signature` (`v1=` plus lowercase hex).
A retry signs the stable ID/body with the current timestamp/configured secret. Shared portable
`signGatewayWebhook()`/`verifyGatewayWebhook()` use WebCrypto. Verification binds metadata and raw
bytes, defaults to a five-minute clock-skew window, and rejects unknown signature versions. The receiver
must also parse `GatewayCloudEventSchema` and match the event ID/workspace/account to its configured
scope before invoking application code. Destination secrets stay in private scoped SQL/configuration,
never public events, logs or API responses. TLS is an operator deployment requirement beyond local
fixtures. No standard-webhooks protocol alias or physical endpoint interoperability is claimed.

## Redis Streams command intake and publication

`GatewayRedisTransport` is independently enabled. Disabled mode opens no Redis connection. Enabled
mode currently qualifies Redis 8.2 (measured 8.2.10), AOF enabled and `noeviction`; incompatible startup
fails explicitly. It uses the pinned node-redis client rather than a generic broker abstraction.
Account bindings come from trusted operator principals and explicit account IDs, not message fields.
`gatewayStreamNames(prefix, scope)` owns deterministic lowercase UUID stream names:
`{prefix}:{workspaceId}:{accountId}:commands`, `:results` and `:events` (default prefix `gateway:v1`).
Separate account keys let Redis ACLs restrict producer/consumer access before application validation.
Runtime credentials also require INFO/stream operations/WAITAOF/TIME permissions described below.

The only command stream field is `payload`, UTF-8 JSON of `GatewayCommandSchema`. A per-boot consumer
uses `XREADGROUP` in group `gateway` by default. It recovers idle PEL entries using `XAUTOCLAIM`, with
30-second default idle threshold and a retained scan cursor. A shared consumer group need not receive
on the native account owner: common SQL intake routes subsequent execution to the actual owner.
The runtime first persists validated commands and a source-message receipt/publication, then XACKs.
Invalid version/schema, forged account scope and request-ID conflicts get a durable bounded rejection
receipt before ACK. SQL failure leaves the source pending. Duplicate/reclaimed intake preserves the
original command/effect key. Missing externally deleted pending payloads raise an operational error.

Intake receipts and command state observations go to `:results`; other public CloudEvents go to
`:events`. Receipt `status: QUEUED` means intake, separate from a terminal command outcome. Correlate
scope/request ID, and preserve terminal outcomes rather than regressing them on an older receipt
snapshot. Each publisher uses an exclusive SQL cursor claim. It sends XADD then
[WAITAOF](https://redis.io/docs/latest/commands/waitaof/) for local AOF acknowledgement before
advancing the SQL cursor. A failure between Redis persistence and SQL completion can duplicate the
same CloudEvent ID, so consumers must deduplicate. Round-robin account/stream scheduling prevents
one source queue from monopolizing the publisher. SQL history remains available independently.
No replicated-Redis failover or exactly-once receiver effect is claimed by local AOF acknowledgement.

A newly registered stream destination starts at the current SQL tail in one account transaction;
restarts resume its existing cursor. Enabling Redis does not automatically dispatch old historical
messages into an Agent. Retained Redis entries can be replayed with a separate consumer group, using
stable public IDs for deduplication. This is distinct from reading gateway-observed message history
and never requests full WhatsApp history download. Scoped queries/private media uploads use the
same command stream and their separate result envelope as defined below.

`trimOnce(retentionMs)` uses Redis server time and exact
[XTRIM MINID ACKED](https://redis.io/docs/latest/commands/xtrim/), supported by the qualified server.
Zero disables trimming. Trimming requires all consumer groups to have acknowledged an eligible
entry; pending and unread bodies remain. Age is an eligibility window, not a hard memory cap when
consumers lag. XACK itself removes PEL membership, not the stream payload. SQL source receipts,
message history and operation keys are not deleted by stream retention. Administrative replay/reset
or deletion of groups/streams is outside the ordinary consumer loop. Empty old consumer names are
not pruned by blindly deleting PEL ownership. A disconnected client reconnects and repeats capability
verification/group registration; offline command queueing is disabled, and network operations are bounded.

The generated AsyncAPI 3.0.0 document at `/asyncapi.json` (or `createGatewayAsyncApi(prefix)`) uses
those same command/CloudEvent schemas, with a stream-field extension describing the actual Redis
mapping. It does not invent a standard Pub/Sub binding for Streams. Actual parser validation and
restricted producer/runtime ACL fixtures qualify these bindings. HTTP documentation accepts an
optional matching Redis namespace when embedded; the standalone bootstrap supplies configured
values. Independent HTTP queries/webhooks do not require a Redis process.

## HTTP commands, queries and interactive documentation

`GatewayHttpTransport` is independently enabled; disabling it opens no listener and does not require
credentials. Enabling it requires explicit bearer credentials, each mapped to a trusted
`GatewayPrincipal`. Tokens have at least 32 characters and are hashed before comparison with
constant-time digest comparison. Duplicate credentials or mismatched workspace routing fail startup.
Serve it behind TLS in deployments that expose it beyond the host; the embedded listener is HTTP,
with default host 127.0.0.1/port 8080. No authentication token, native payload or raw media URL appears
in the request logs. Remote account/operation results must match the route's authorized scope.

- `POST /v1/commands`: validate version/content/scope, commit SQL intake and return 202. A replay
  can return its already completed receipt, still with the original identity/sequence.
- `GET /v1/accounts/{workspaceId}/{accountId}`: scoped account state and available pairing QR.
- `GET /v1/accounts/{workspaceId}/{accountId}/commands/{requestId}`: durable command outcome.
- `GET /v1/accounts/{workspaceId}/{accountId}/operations/{key}`: native send-operation observation.
- `GET`/`PUT /v1/accounts/{workspaceId}/{accountId}/desired`: scoped durable revisioned intent,
  when a fleet store is configured; otherwise explicitly unavailable.
- `GET /v1/accounts/{workspaceId}/{accountId}/media?sourceId=...`: bounded, lazy decrypted bytes,
  without an object store or through configured S3 materialization. Source expiry/unavailability
  is explicit; no media-key/provider-URL response. Responses use private/no-store caching.

The same owning Zod schemas generate [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) at `/openapi.json`. `/docs` serves pinned local
[Swagger UI assets](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/) with the actual bearer security scheme and callable operations, without an external
validator/CDN or persistent browser credentials. Documentation is public and contains no account data.
The OpenAPI document is independently parsed/validated in HTTP integration tests; no manual schema
copy is maintained. Cross-field identity and accepted-count invariants are also checked at runtime.

HTTP accepts only JSON command bodies, defaults to a 1 MiB bound (maximum configurable 16 MiB),
and applies an explicit 15-second body deadline in addition to Node's HTTP timeouts. Declared and
chunked over-limit bodies fail with 413; incomplete bodies expire with 408. Invalid input is 400,
missing/invalid credentials 401, unauthorized scope 403, unavailable scoped resources 404,
request-ID conflicts 409, wrong media type 415 and storage/provider failures 503. Malformed provider
results are 503 rather than blaming the caller; raw dependency errors are not returned.

Closing the transport stops admission/listening, waits for active handlers and closes connections
at the configured shutdown deadline (default 15 seconds). Persisted commands survive HTTP shutdown
or caller disconnection; stopping the server does not cancel an accepted native operation. Close
HTTP before its gateway and storage. Gateway media and SQL operations retain their own bounded
execution timeouts. This increment is an embeddable HTTP server, not a separately published runtime,
Redis qualification, webhook implementation or production deployment.

## Embedded fleet coordination and durable desired state

`SqlFleetStore` owns per-workspace runtime membership and desired account state. Both tables are
workspace-scoped, with forced PostgreSQL RLS. No new global tenant data or separate coordinator
service is introduced. Each `GatewayFleetParticipant` has a fresh boot UUID and a configured capacity
for that workspace. An application hosting several workspaces allocates its desired quota to each
participant; capacity is not a claimed shared host-resource or cross-workspace global quota.

A reconciliation pass elects one coordinator using a workspace-specific PostgreSQL transaction
advisory lock. Leadership lasts only for that transaction and is released on commit/rollback or
connection loss. Followers skip placement for the occupied pass. SQLite's one exclusive runtime
performs its local placement without a distributed-election claim. The coordinator retains healthy,
non-draining assignments first, then selects least-loaded eligible peers within capacity. New peers
do not cause unnecessary migration of existing sessions. Excess accounts remain unassigned.

Membership expires against the database clock, avoiding application host-clock disagreement. Defaults
are one-second reconciliation and 15-second membership lifetime; an independent heartbeat runs every
third of that lifetime. Reconciliation intervals must fit at least three times inside membership.
Native sends run in separate per-account workers, so a slow send does not block membership renewal.
Workspace assignments are desired placement, not authority to use a WhatsApp session. An expired
heartbeat never steals a held account advisory lock; only actual lease acquisition and generation
advance permit connection initialization or command claims.

`DesiredAccountRequestSchema` carries version, workspace/account, `expectedRevision` and `enabled`.
The authenticated caller compares against the observed revision (initially zero). Recording a new
revision is durable and asynchronous: enabled authorizes a fresh pairing/restart attempt, disabled
requests stop. The immediate same expected revision/payload replay is idempotent; a delayed stale
revision after another decision conflicts. A new enabled revision restarts an already active account;
this also supplies the explicit retry after a failed/unpaired attempt. HTTP GET/PUT at the scoped
`/desired` path uses this same contract when the workspace has a fleet store. HTTP intake can record
a decision without locally running a participant; it is not proof that the account is connected.

A participant verifies the current assignment and marks its attempted revision while holding the
actual account lease, before creating the connection. A guarded start does not adopt a pre-existing
manually started session; that session must release its owner first. Known lease loss during the
initialization guard prevents socket creation. Interrupted attempts without paired credentials
are blocked until an explicit new revision; they do not open endless QR sockets. Paired recovery
checks saved native identity after acquiring the lease, allowing the old owner to flush its final
credentials first. A stale coordinator snapshot of credentials never makes that decision. Terminal
FAILED/LOGGED_OUT sessions block their revision instead of automatic login retries. An enabled newer
revision supplies new intent. UNKNOWN send-operation state itself is never reset by session recovery.

Desired changes, worker loss and drain stop the old owner's scheduling, close/drain native work and
release its actual lease before a successor opens a socket. Already-dispatched effects can remain
UNKNOWN; stop is not instantaneous remote cancellation. Stale initialization/claim completion is
rejected by the owning assignment/revision/generation checks. An ingress completion failure while
otherwise healthy schedules local ownership recovery; replay of an already accepted operation
finishes the inbox result without another native effect. Known shutdown/lost-lease worker exits are
logged as stops, while unexpected live-owner failures remain errors.

Closing a participant cancels its timers, waits for reconciliation/heartbeat, advertises draining,
closes the gateway and command workers, then removes its membership. It preserves durable desired
state and send history. Expiry recovers membership after ungraceful process loss; live account locks
still govern handoff. Close the participant before its shared storage. Automatic SQL scheduling is
implemented; Redis Streams publication runs independently of the session coordinator.

## Session flow and ownership

`store.createAccount()` creates a scoped account without starting WhatsApp.
`Gateway.start()` acquires exclusive account ownership and advances the ownership
generation (a dedicated advisory-lock connection in PostgreSQL; a local lease under SQLite file
exclusivity) before creating the Baileys connection. Concurrent starts in one Gateway share that
start; another owner is rejected. A failed connection factory releases the acquired connection.

The state is STOPPED, CONNECTING, AWAITING_PAIRING, CONNECTED, LOGGED_OUT or FAILED.
QR observations retain their PNG data URL in private account state. The unpaired attempt has a
bounded deadline; refreshing a QR does not create an unlimited attempt. `restart()` is explicit.
Authentication/Signal writes are serialized and generation checked. A successful scan followed by
native restart-required (515) recreates the socket using the saved identity even when Baileys'
`registered` flag remains false. Logout (401) clears revoked authentication. Other paired closes
use bounded reconnection; no full historical-chat download is requested.

`restore()` makes one pass over this workspace's accounts with saved paired credentials; it skips
accounts already owned elsewhere. It does not continuously claim idle accounts or initiate new QR
pairing for logged-out accounts. Stop drains work, closes the socket, flushes authentication and
releases ownership. It is a technical stop, not a durable administrative disable policy.

Known ownership loss stops future scheduling and stale database writes/callbacks. PostgreSQL cannot
fence an already-dispatched remote WhatsApp effect. A connection partition therefore cannot be
advertised as an exactly-once external-effect guarantee.

## Send flow and recovery

The application supplies a stable operation key and validated portable content to `send()`.
Within an account, operations are serialized. Preparation resolves the native recipient before
dispatch; typing and transmission use that same prepared address, without another phone lookup
after recording IN_FLIGHT. The SQL store reserves a payload digest and native IDs
for every album parent/part before transmission. The same key and digest returns the original
result; reusing a key with another payload is a conflict. Native IDs also exclude bot echoes while
preserving handset-originated messages, including self-chat.

The operation states are PENDING, IN_FLIGHT, ACCEPTED, FAILED and UNKNOWN. ACCEPTED means the
native send call returned, not that a person received/read the message. The accepted album prefix
and its reserved IDs remain durable. Delivery observations retain native acknowledgement names
separately and deduplicate repeated observations.

Known preparation failures are explicit, retain FAILED and any accepted prefix, and do not trigger
a new send. A caller may inspect the original failure; this increment supplies no automatic retry
loop or fresh-key substitution. Before external dispatch,
IN_FLIGHT is durably recorded. A timeout, interrupted dispatched operation or lost confirmation
leaves UNKNOWN. A replay never resets UNKNOWN into PENDING. The socket is quarantined after
ambiguous sends. A replacement owner recovers interrupted IN_FLIGHT work as UNKNOWN. An already
accepted prefix of an album is never resent as a new parent/part.

Recovery requires inspecting the original operation/status and available authoritative native
evidence; the core does not automatically resend an ambiguous effect. The current calling path
must be qualified before another application's old delivery handoff is retired.

## Pacing, typing and shutdown

Per-account durable pacing combines randomized spacing, a rolling send window, first-day growth,
a daily ceiling and inactivity reset. Defaults are 1.5–5 seconds spacing, eight per 60 seconds,
60 on the first day growing by 1.6, seven warm-up days, a 1,500 ceiling and 168 hours inactivity.
Reservations count attempts conservatively; they do not claim delivered-message totals.

Typing before send has a deadline and finally cleanup. Incoming direct text may start a bounded
30-second heartbeat with randomized 4–7 second spacing, without an Agent signal. Handset activity,
reply, stop and ownership loss end activity. A stale activity may not clear a newer activity.
Presence failure never causes an automatic duplicate send. The number of active activities is
bounded. These controls are pacing/UX behavior, not a promise against account bans.

## Content and media

Portable content uses an explicit contentKind discriminator; no legacy undistinguished-text input
compatibility is retained. Portable schemas own text, explicit link previews, image, video/GIF/video-note, audio/voice,
file, static/animated sticker, vCards, location, polls, events, quoted messages, mentions/forwarding,
buttons/cards, URL actions, lists, carousels, albums, selections, reactions, edits and deletions.
Builders retain the exercised custom Baileys profiles. The pinned release implements
`replyButtons` (including JPEG image cards), `urlButton`, `list` and `carousel`; the owning
gateway builder maps those keys directly rather than maintaining separate raw-protobuf PoC recipes.
Runtime source and captured response fixtures supersede the removed historical interactive PoC.
Missing inbound preview metadata remains absent rather than inventing a title/description. An incoming album parent and its individual
children remain separately identified. Selection callbacks retain actual IDs, source message IDs
and only indices actually present. Empty native reaction text represents removal.

N47 carousel iOS selection remains disabled in the accepted evidence; horizontal navigation on iOS
is unconfirmed. No poll-vote or event-reply capability is invented.
A normalization failure retains a private technical failure event rather than converting the
message to successful empty content or terminating the connected account. Other messages in the
same native batch continue. Failure to persist that evidence still propagates as an operational
failure; no automatic replay or new transmission contract is implied. Unqualified legacy declarations
for group/community/newsletter/profile/privacy/call operations are outside this increment; their
old presence does not establish delivered behavior or a requirement to port them.

On-demand media first exposes a workspace/account-scoped source handle and metadata. Normalization
never fetches an attachment. `readMedia()` always checks the handle's workspace/account and resolves
its private retained native source. It offers two configured modes:

- Direct mode requires no object store: fetch/decrypt bounded bytes only for the explicit consumer
  request. The SDK attachment remains lazy. A later request may download again; this is not an archive.
- Optional S3 mode materializes using the existing S3-compatible adapter. Concurrent callers reuse
  the scoped materialization and deterministic key under `media/whatsapp/<workspace>/<account>/`.
  A stored object remains available when the original provider source expires, subject to actual
  object availability and metadata integrity. Both download and stored reads enforce byte bounds; the host passes matching
  `maximumBytes`/`timeoutMs` transfer limits to the S3 resource factory.

`createMediaStorage({ mode: "direct" })` selects direct access without creating an S3 client.
The S3 configuration selects endpoint, region, bucket, path style and optional explicit credentials;
standard AWS credential discovery is available when credentials are omitted. For Cloudflare R2 use
its S3 endpoint, region `auto` and R2 credentials. No public bucket or R2-specific service is required.
The owning resources include the SDK client so the host can destroy it during shutdown. Actual R2
live success has not been measured; local integration uses real signed AWS SDK requests.

`maximumMediaBytes` defaults to 32 MiB (configurable up to 256 MiB); `mediaTimeoutMs` defaults to
60 seconds and cannot exceed that bound. Declared oversize fails before download; missing size
stays absent and is enforced against actual received bytes. Native framing/HMAC and available
SHA-256 checksums are verified before returning or storing plaintext; metadata/size mismatches fail.
The pinned Baileys `getHttpStream()` drops its supplied AbortSignal and does not forward upstream
pipe errors. The gateway therefore owns bounded fetch/cancellation and retains the release's
public `getMediaKeys()` derivation and AES-CBC/10-byte-HMAC framing from `encryptedStream()`.
Controlled encrypted HTTP scenarios prove timeout, byte limits and corruption rejection.

Unavailable/expired source or missing object is an explicit error, not empty successful media.
Native envelopes/keys and provider URLs remain private; the portable source exposes none of them.
SQL retains protocol envelopes/metadata, not downloaded/decrypted media objects. Permanent archive
and business retention belong to the consumer. No filesystem media backend, automatic incoming
attachment archive or full history service is added. Outgoing stored media still uses the configured
media repository; direct incoming access does not silently invent an outbound object store.

## Contact-address registration

`lookupContactAddress(accountId, address)` runs on an initialized, locally owned account/session.
It returns the authenticated account's workspace/account, original address and one of REGISTERED,
UNREGISTERED or INDETERMINATE. REGISTERED includes the authoritative native `resolvedAddress`;
no country-specific digit rewrite or fabricated WhatsApp ID is used. Phone queries accept E.164
or a phone-number JID. A LID/group/unsupported input is indeterminate, not an unregistered number.

The pinned `onWhatsApp()` helper drops negative entries. This path instead uses its public
`USyncQuery`/`USyncUser` contact query and preserves explicit `in`/`out` profile results. Unknown
contact node types, missing/extra results, absent contact fields, mismatched negative phone identity,
query errors, timeout or session-generation change cannot become UNREGISTERED. Native error-node
validation is retained. A negative is accepted only for the queried phone; a positive preserves
returned native PN/LID authority. A ten-second query deadline is cancellable on session stop.

The query is read-only and does not send a WhatsApp message. Phone-originated sends reuse the same
query semantics during preparation; an indeterminate lookup fails preparation explicitly. For a
durable application job, resolve once and retain `resolvedAddress` in its send payload. The native
query/decoder fixtures qualify the implemented profile, not current live WhatsApp registration.

## Chat SDK and Mastra integration boundary

`WhatsAppGatewayAdapter` implements the published `chat@4.43.0` Adapter. Its remote
`GatewayRemoteClient` uses actual HTTP or Redis Streams requests, polling durable
command results and preserving scoped operation outcomes. Timeout errors retain
the original request identity; no fresh-key retry is performed. Redis result
intake correlates request IDs in a stable consumer group configured for that
application instance. Do not share that result group between independent clients:
they have independent outstanding-request maps. Redis failure is explicit; reopen
the client to reconnect and inspect/retry original operation keys.

Thread IDs encode workspace, account and native chat. Raw SDK messages retain the
owning `GatewayObservedMessage`, including direction, timestamp provenance and
edited/deleted state. Handset self-chat input remains user-authored; a retained
outbound observation is marked as the adapter's own message. History comes from
observed snapshots, with scoped cursors and chronological pages. Incoming native
and stored attachments stay lazy and can be rehydrated from scoped metadata.

Standard text/Markdown/AST output translates to the qualified WhatsApp formatting.
Single files upload through private storage; multiple image/video files become an
album. SDK reply cards preserve reply action ID/value using an opaque native
choice ID. Text/sections/dividers and one bounded HTTP(S) JPEG image are supported;
image URL materialization is explicit outgoing work and requires private storage.
Unsupported controls such as modals, disabled/access-restricted buttons and
unsupported layouts fail explicitly. Gateway-native rich families remain
available through `executeWithKey`, returning the actual operation outcome.
`postGatewayWithKey` returns a message only for ordinary message content; lifecycle
operations use their outcome contract. Edit/delete/reaction targets resolve from
observed sender/chat identity. Native quotes can load their original retained
protocol envelope after a socket restart, validating chat/sender correlation.

Signed HTTP webhooks validate raw bytes, envelope ID and account scope before
processing. `GatewayRedisEvents` checks the authenticated account stream and
XACKs only after the supplied handler fulfills. It reclaims idle pending work on
subsequent calls; the consumer application schedules calls and handles failures.
Redis group retention remains operator/consumer-owned, not automatically deleted
on disconnect. Both intake paths dispatch actual SDK message/action/reaction/
update/delete methods. Ordinary messages pass `deduplicate:false` because SDK
pre-handler deduplication would otherwise suppress a retry after handler failure.
A conversation lock serializes adapter intake, with renewal while processing;
completion is marked in the configured Chat StateAdapter only after the handler
fulfills and the lock remains held. Completed-event retention defaults to seven
days. Shared Redis StateAdapter reconstruction is exercised; in-memory state
only protects one process lifetime. A crash after an application effect but before
the marker can replay it; external application effects are not fenced by this
lock. The qualified SDK dispatch profile is `concurrency:"concurrent"`, also the
released Mastra default. Queued/debounced/burst dispatch is not qualified for this
inline completion/ACK contract. `waitUntil` does not cause an early successful ACK.
Disconnect stops intake and waits for active handlers before closing its client.

The reproducible generic composition is
`packages/chat-adapter/examples/mastra.ts`, exercised against released
`@mastra/core@1.79.0`, actual `AgentChannels`, `Agent` and `chat@4.43.0` with a
controlled outer model boundary, real transport and SQL. Mastra is a consumer/test
dependency, not a gateway runtime dependency. The fixture uses native in-memory
Mastra storage only for framework state; it does not claim durable agent runs.

Native interoperability is not application exactly-once replay. Native
`postMessage` has no caller operation key and creates a new one for each call.
The measured case posts, receives ACCEPTED and then throws in the handler:
replaying that native call creates a second effect. The explicit `postWithKey`
case covers the same after-acceptance failure boundary: the same event/key/body
can execute the handler twice with one native effect. Payload conflicts fail;
UNKNOWN remains inspectable under the original key and never triggers a fresh
send in this Adapter. Released `AgentChannels.handleChatMessage` catches run
errors and delegates to its error handler, so webhook success is not proof of
model/run success. Durable consumer send intent and run outcomes remain consumer
composition responsibilities; no implicit output identities or framework-internal
interception are introduced here. There is no full WhatsApp history service.

## Validation and limits

Integration tests use real SQLite and PostgreSQL drivers, a non-owner PostgreSQL RLS role and
controlled Baileys sockets. Storage scenarios cover invalid configurations/schema/roles/policies,
workspace/account separation, a competing SQLite process and SIGKILL recovery to UNKNOWN. They
exercise ownership, stable-key sends/conflicts, UNKNOWN recovery, QR/515/restart/logout, media,
rich native inputs, receipts and cleanup. Captured predecessor interactive responses in
`runtime/test/fixtures/native-response-fixtures.json` preserve the library revision, observation dates,
normalization disclosure and client-evidence limits. The custom release
`digows-7.0.0-rc14-interactive.1` supplies the interactive builders in `lib/Utils/interactive-messages.js`
and the content dispatch in `lib/Utils/messages.js`; the gateway maps them in
`runtime/src/infrastructure/baileys/baileys-outbound-content.ts`. These source boundaries and fixtures
retain the relevant verified capability evidence after removing the historical PoC, whose floating
Baileys dependency, file authentication and independent raw relay scripts are not current setup.
Component tests cover finite typing and pacing invariants. The SDK tests
exercise its actual Message and Attachment types.

These tests do not establish physical client rendering, live receipt, WhatsApp server availability,
unmeasured broker/webhook failure boundaries or application/business approval. Browser qualification
uses a synthetic disabled account and verifies rendered Swagger authorization, an authenticated
scoped request and the actual server response; it does not establish every browser interaction.
No live pairing, external message, production deployment or production DML is part of qualification.
Repository/image publication follows final review; a prepared workflow is not proof of publication.


## Gateway-observed history and remote queries

Schema version 8 adds scoped message snapshots, keyed by workspace, account, chat,
message and sender. It backfills retained ordinary inbound observations; it does
not reconstruct missing old outbound bodies or import WhatsApp history. Newly
accepted outbound parts record their actual reserved native ID and prepared
recipient in the same transaction as operation acceptance and `message.sent.v1`.
An unavailable native timestamp is explicitly `GATEWAY_OBSERVATION`, not a
fabricated provider time. `PROVIDER` identifies the native timestamp field, not a
claim that the server independently certified its clock. Edits update known text
snapshots and deletion marks known targets; history pages exclude deleted items.
Reactions and selections remain lifecycle observations. Pagination uses provider
or observation time plus a stable account position, returning each page oldest
first. Cursors bind account, chat and direction; ambiguous sender identity fails.

Native media source version 2 also binds the native chat JID. Lookup and private
object keys distinguish equal message IDs across chats. Legacy version 1 remains
readable only when its message identity is unambiguous, including cached objects.
No geographic rewriting or extra contact lookup changes the native correlation.

`POST /v1/queries` uses `GatewayQuerySchema` for account/operation observations,
retained history pages/messages, lazy native media and stored references. Queries
are authorized before execution and do not need a locally connected account.
HTTP retains the optimized binary native-media GET route. JSON and Redis media
responses use bounded base64, with its encoding overhead. HTTP's configured
request-byte limit also bounds upload sizes; it defaults to 1 MiB and allows up
to 16 MiB JSON, independently of the native media limit.

`POST /v1/media` accepts `GatewayMediaUploadSchema` when private object storage is
configured. Bytes and metadata determine the scoped object key; repeated uploads
return the same reference, although the PUT itself may repeat. Account existence,
configured media bounds and reference scope are checked. This does not add a
filesystem store or put downloaded/uploaded bytes in SQL.

Redis accepts the same queries and uploads on the account commands stream.
Commands keep their durable SQL intake/receipt rule. Read queries and uploads
reply directly on the results stream, using `GatewayQueryCloudEventSchema`, and
XACK only after local Redis AOF confirmation of the reply. They never wait for a
session owner. A crash before ACK may re-evaluate a query or repeat the identical
object PUT and publish another reply with a new event ID; correlate `requestId`.
These replies have no SQL event sequence and are observations, not durable SQL
query snapshots. An unavailable dependency produces an explicit failed reply;
retrying a read is a new observation. Media bytes can reside in the selected Redis
stream/AOF until its configured retention and consumer groups permit trimming;
SQL and webhook outboxes never store those bytes. Retention is not a permanent
consumer archive. OpenAPI and AsyncAPI describe the common owning schemas.


## Standalone runtime and distribution

`GatewayRuntimeConfigurationSchema` owns the strict JSON operator contract. `GatewayRuntime` opens
and verifies the selected storage, creates per-workspace gateways, ingress/query services, embedded
fleet participants and optional Redis/webhook loops. Configuration is external and explicit through
`--config` or `GATEWAY_CONFIG`; there is no implicit `.env`, old auth-directory or database fallback.
The CLI has `serve`, `migrate`, `verify-storage` and `--help`; migration is a separate administrative
operation and ordinary startup never upgrades a schema. Config failures expose safe categories,
not raw configuration or secret-bearing validation messages.

Configured accounts are provisioned idempotently. An omitted `enabled` preserves durable intent;
an explicit value updates it only if different. Restart does not issue a fresh enabled revision to
bypass a blocked pairing attempt. Desired-state CAS remains the operator boundary for new intent.
HTTP credentials use configured principals/grants; Redis bindings must reference an authorized
principal and configured workspace. Disabled HTTP opens no listener. Direct media creates no S3
client; the optional object-store client uses the same core media limits and closes with runtime.

Startup advertises readiness only after storage/Redis checks, HTTP startup and participant startup.
HTTP `/health/live` reports listener liveness. `/health/ready` returns 200 only while running and the
latest periodic SQL/Redis probes are healthy, otherwise 503; it does not assert paired/connected
accounts or model health. An embedded transport without explicit readiness hooks returns 503.
Account command intake remains authenticated; health routes expose no credentials or account data.
Redis-only operation exposes no health port and emits structured `runtime_ready`/failure logs.

SIGINT/SIGTERM and repeated `close()` calls share one cleanup operation. Cancellation during startup
prevents later readiness. Shutdown stops new admission and begins participant drain before waiting
for HTTP requests; pending reconciliation checks closing state between account starts and after SQL
claim. An in-flight claim that finishes during drain releases ownership without opening a native
socket or blocking the desired revision. No second account starts after closing because a prior
account's asynchronous startup completed. Existing commands retain their durable result/UNKNOWN
semantics. HTTP, webhook and Redis work are drained/aborted, background loops joined, participants
closed, then shared storage and object-store clients closed. Cleanup attempts continue after a
resource failure and aggregate the failures. Tests reproduce shutdown during HTTP body intake,
native startup and SQL placement on both backends; bind failure also releases the storage owner.

Pino JSON logging has a global threshold and optional runtime/sessions/baileys/http/redis/webhooks/
fleet thresholds. Valid levels are trace/debug/info/warn/error/fatal/silent. Connection/session
records carry scope/generation, state and pairing flags without QR or credentials. Protocol adapter
logs discard arbitrary objects/bindings and raw XML, exposing classified literals or signal hashes
and safe error codes. Intentional socket close is a debug event, not an error stack. HTTP logs record
request identity/route/status/duration, not credentials or bodies. Tests capture secret-bearing
protocol objects and intentional close, verifying their exclusion.

The build emits JavaScript and declarations for contracts, runtime and Adapter, with production
exports pointing to `dist`. The explicit development condition selects sources for workspace tests.
The CLI bin is compiled; consumer tarballs include compiled exports and the generic Mastra example.
An actual packed/freshly installed consumer runs released native Mastra channels through remote
HTTP intake/send/history and stable-key/conflict checks, without source aliases. Mastra is an
optional consumer peer, never a runtime dependency. Package versions remain 0.0.0 until a separate
registry release; CI artifacts do not imply npm publication.

The container pins the Node 24.18.0 base digest, deploys pruned runtime dependencies and runs as UID
1000. Operator configuration is mounted externally and data remains on the selected durable backend.
The context allowlist excludes local authentication and private configuration. The offline container
qualifier uses owned labeled resources and a synthetic disabled account to measure explicit migration,
startup/readiness, durable queued intake, SIGTERM, restart and retained work. It verifies Node/platform,
SQLite and absence of Chat/Mastra from runtime. It removes only its own containers/volume. The
qualified architecture is linux/arm64; another architecture is not inferred. Allow deployment stop
time for bounded in-flight work rather than relying on Docker's default ten-second kill window.

CI runs formatting, strict types, compilation and all tests using isolated PostgreSQL/Redis fixtures,
then archives contracts/Adapter tarballs. Test files are serialized because Redis capability tests
mutate the isolated server's global AOF/eviction settings; explicit within-file concurrency remains
covered. Manual image publication matches the reviewed main SHA, builds and qualifies the actual
arm64 image before pushing it, then records its registry digest. Publication is distinct from any
production rollout or real-number qualification.
