# Use case: Gateway accounts, sends and observed messages

This document owns the transport-independent gateway behavior reviewed on October 23, 2026.
The runtime, portable contracts and application-side Chat SDK projection are implemented here.
HTTP paths, authentication mapping, webhook acknowledgement and Redis Streams/NATS transmission
remain undecided. No legacy NATS subject is retained as a compatibility contract.

## Actors and boundaries

An authenticated integration supplies a trusted workspace context and a gateway account ID.
The core does not authenticate HTTP requests: a future transport must establish that context.
PostgreSQL RLS isolates all technical rows by `workspace_id`; callers never select a workspace
from an unverified incoming event. Account IDs, WhatsApp JIDs and phone aliases are transport
identity, not application Person, Household or Case policy.

The versioned fresh-baseline schema is `runtime/migrations/001_gateway_core.sql`.
Apply it as an administrative migration role, then grant the runtime role schema usage and
SELECT/INSERT/UPDATE/DELETE on its tables. The runtime role must not be a superuser or have
BYPASSRLS. There is no automatic destructive migration or legacy data conversion.

## Session flow and ownership

`PostgresGatewayStore.createAccount()` creates a scoped account without starting WhatsApp.
`Gateway.start()` acquires one PostgreSQL advisory-lock connection and advances the ownership
generation before creating the Baileys connection. Concurrent starts in one Gateway share that
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
Within an account, operations are serialized. PostgreSQL reserves a payload digest and native IDs
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
does not download it. Explicit materialization resolves the retained private native envelope,
downloads/decrypts when required and writes the configured S3-compatible store. Concurrency reuses
the stored materialization and deterministic object key. References must stay under
`media/whatsapp/<workspace>/<account>/`; another workspace's source or object is rejected.
Unavailable or expired source/media is an error, not a successful empty attachment. Encryption
keys remain in private native/auth storage; no native envelope is exposed by the portable contract.

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

Integration tests use PostgreSQL with a non-owner RLS role and controlled Baileys sockets. They
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
