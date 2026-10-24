# Use case: Gateway accounts, sends and observed messages

This document owns the transport-independent gateway behavior reviewed on October 23, 2026.
The runtime, portable contracts and application-side Chat SDK projection are implemented here.
The versioned command contract, SQL ingress and HTTP transport are implemented. Embedded placement is implemented. Redis transport and webhook
acknowledgement remain pending increments of the approved design.
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
`runtime/migrations/001_gateway_core.sql` plus `002_storage_version.sql`, `003_command_ingress.sql` and `004_runtime_placement.sql`; SQLite uses
`runtime/migrations/sqlite/001_gateway_core.sql` plus `002_command_ingress.sql` and `003_runtime_placement.sql`. Schema version metadata is intentionally system-level,
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
implemented; Redis/CloudEvents publication and webhook delivery are separate pending increments.

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

## Chat SDK integration boundary

`GatewayChatMapping` compiles against published `chat@4.43.0`. It constructs real SDK Message
objects with typed originals and lazy Attachment fetching/rehydration. It encodes workspace,
account and chat identity in thread IDs and validates their scope. A handset self-chat is a user
input, not a bot echo. Text posting can use `postWithKey()` for a caller-owned stable identity;
a new ordinary `postMessage()` call allocates a new key. UNKNOWN is surfaced with the original
operation identity and must not become a fresh automatic post.

The public `gateway` operations boundary retains explicit rich-content sending and status access.
Unsupported card/file projections fail explicitly rather than silently flattening content.
This package is a tested SDK projection/send mapping, not a complete `Adapter` with remote event
intake. Full Adapter initialization, history methods, standard action/card translation and dispatch
bindings are incomplete and must be implemented against the selected transmission contract.
No stub webhook or pretend connected broker exists. No full WhatsApp history service is provided.

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
broker/webhook delivery semantics or full browser UI qualification or application/business approval. No live pairing, external
message, deployment, public package/image publication or production DML is part of this increment.
