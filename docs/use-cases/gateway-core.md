# Use case: Gateway accounts, sends and observed messages

This document owns the transport-independent gateway behavior reviewed on October 23, 2026.
The runtime, portable contracts and application-side Chat SDK projection are implemented here.
HTTP paths, authentication mapping, webhook acknowledgement and Redis Streams/NATS transmission
remain undecided. No legacy NATS subject is retained as a compatibility contract.

## Actors and boundaries

An authenticated integration supplies a trusted workspace context and a gateway account ID.
The core does not authenticate HTTP requests: a future transport must establish that context.
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
`runtime/migrations/001_gateway_core.sql` plus `002_storage_version.sql`; SQLite uses
`runtime/migrations/sqlite/001_gateway_core.sql`. Schema version metadata is intentionally system-level,
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
its dedicated account advisory locks and generation fences. The configured cluster mode currently
qualifies shared storage/ownership; automatic placement/transport routing is a separate pending increment.

Apply migrations with an administrative role; grant the PostgreSQL runtime role schema usage and
SELECT/INSERT/UPDATE/DELETE on its tables. The runtime does not silently migrate on startup.
Close gateways before closing their shared storage. The PostgreSQL convenience store also verifies
compatibility before its first transaction. Core and Baileys authentication use the owning store/lease
ports, not PostgreSQL client types. Serialized Baileys credentials/Signal keys remain private SQL data.

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
final HTTP/broker delivery semantics or application/business approval. No live pairing, external
message, deployment, public package/image publication or production DML is part of this increment.
