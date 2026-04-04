# Integration Guide

This document explains how another service, another coding agent, or another engineering session should integrate with this WhatsApp gateway.

It assumes the current architecture already in this repository:

- single binary
- REST API
- NATS integration surface
- durable `Session` catalog in PostgreSQL
- embedded control plane with Redis leader election

## Integration Rule

Treat this project as a **self-managed gateway microservice**, not as a library and not as a thin worker.

External systems should:

- call the public REST API for synchronous operational requests
- consume NATS events for asynchronous lifecycle and messaging fanout
- prefer the Java SDK when integrating from JVM services
- avoid depending on local in-memory worker state

Do not integrate directly with Baileys from outside this service.

## What This Service Owns

This gateway owns:

- WhatsApp session runtime
- durable session lifecycle
- session recovery after rollout or pod failure
- worker placement and reassignment
- activation flow
- inbound and delivery event fanout

External infrastructure should not try to replicate those responsibilities.

## What External Infrastructure Should Own

This gateway does **not** currently own:

- authentication or authorization of API callers
- business policy for who may operate which workspace
- durable media storage pipeline for downstream file access
- downstream business workflows triggered by WhatsApp events
- public API gateway concerns such as rate limits, auth tokens and audit perimeter

Those concerns should live in the surrounding infrastructure.

## Recommended Topology

### Kubernetes

Recommended topology today:

- one `Deployment`
- multiple replicas
- one internal `Service` for REST
- all pods run the same binary
- one pod becomes control-plane leader automatically

Do not split controller and worker into different codebases.

If separation is needed later, do it by deployment mode from the same repository, not by cloning the runtime into another service.

## Public REST Surface

Use these routes for real integration:

- `GET /healthz`
- `GET /readyz`
- `POST /api/v1/workspaces/:workspaceId/activations`
- `GET /api/v1/workspaces/:workspaceId/sessions`
- `GET /api/v1/workspaces/:workspaceId/sessions/:sessionId`
- `PATCH /api/v1/workspaces/:workspaceId/sessions/:sessionId`
- `DELETE /api/v1/workspaces/:workspaceId/sessions/:sessionId`

### Semantics

#### Activation

`POST /api/v1/workspaces/:workspaceId/activations`

This creates or resumes the gateway-side session activation flow and returns the first challenge synchronously.

Use cases:

- get a QR code
- get a pairing code
- create the first durable `Session`

The response includes:

- session reference
- activation identifiers
- current activation status
- first QR code text and PNG base64, or first pairing code
- activation event subject for asynchronous follow-up

#### Session Catalog

`GET /api/v1/workspaces/:workspaceId/sessions`

Returns the durable session catalog for the workspace.

This is the correct way to query sessions globally across pods.

`GET /api/v1/workspaces/:workspaceId/sessions/:sessionId`

Returns one durable `Session`.

Important:

- this does not require hitting the pod that currently hosts the live session
- the response is the durable mirror, not the ephemeral local runtime snapshot

#### Desired State Control

`PATCH /api/v1/workspaces/:workspaceId/sessions/:sessionId`

Use this to change `desiredState`.

Supported values today:

- `active`
- `paused`
- `stopped`

This is the correct control-plane contract for external systems.

Do not publish ad hoc worker commands from outside unless you are intentionally operating at the infrastructure boundary.

`DELETE /api/v1/workspaces/:workspaceId/sessions/:sessionId`

This is a convenience operation for:

- `desiredState = stopped`

If the session is local to the current pod, it is stopped immediately.
If not, the durable desired state still changes and the embedded control plane converges the rest.

## Internal REST Surface

These routes are for debugging one pod:

- `GET /internal/v1/workspaces/:workspaceId/hosted-sessions`
- `GET /internal/v1/workspaces/:workspaceId/hosted-sessions/:sessionId`

Use them only for:

- debugging
- diagnostics
- checking what a specific pod currently hosts

Do not build business integration on top of these routes.

## Java SDK Integration

For JVM-based consumers, prefer the Java SDK in [sdks/java](/Volumes/Files/Development/workspaces/digows/whatsapp-gateway/sdks/java).

It gives you typed models for:

- `Session`
- `Activation`
- `ActivationEvent`
- `Message`
- `MessageContent`
- `InboundEvent`
- `DeliveryResult`
- `OutboundCommand`
- `OutboundCommandResult`
- public REST request payloads

Session-observed message lifecycle is modeled as:

- `message.created`
- `message.updated`
- `message.deleted`

Reaction changes are not a separate top-level event. They are emitted as `message.updated`
with `updateKinds` containing `reaction`, plus `reactionText` and `reactionRemoved`.

`message.created` can represent both:

- a remote-account message received by the session
- a local-account message created by the session itself

Use `fromMe` on the event to distinguish direction.

For `message.updated` and `message.deleted`:

- `targetMessage` identifies the logical WhatsApp message affected by the lifecycle change
- `message` is optional and only present when the gateway can normalize a payload for the update
- `fromMe` indicates whether the logical message belongs to the local account perspective
- when `message` is present in an update, `message.timestamp` comes from the WhatsApp/Baileys
  `messageTimestamp` carried by that update payload, not from the gateway processing clock

### JitPack

For public JVM consumers, prefer JitPack because it avoids Maven credential setup.

Add the JitPack repository:

```xml
<repositories>
  <repository>
    <id>jitpack.io</id>
    <url>https://jitpack.io</url>
  </repository>
</repositories>
```

Add the dependency. For JitPack, the version is the Git tag or commit hash. Example:

```xml
<dependency>
  <groupId>com.github.digows</groupId>
  <artifactId>whatsapp-gateway</artifactId>
  <version>3.0.0</version>
</dependency>
```

JitPack exposes the SDK with repository-based coordinates. The Java package base inside the jar still remains `com.digows.whatsappgateway`.

This repository includes [jitpack.yml](/Volumes/Files/Development/workspaces/digows/whatsapp-gateway/jitpack.yml) so JitPack builds the SDK module from [/sdks/java](/Volumes/Files/Development/workspaces/digows/whatsapp-gateway/sdks/java).

### GitHub Packages

For controlled internal consumption, the repository CI also publishes the SDK to GitHub Packages.

Add the SDK dependency:

```xml
<dependency>
  <groupId>com.digows.whatsappgateway</groupId>
  <artifactId>java-whatsappgateway-sdk</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

Add the GitHub Packages repository:

```xml
<repositories>
  <repository>
    <id>github</id>
    <url>https://maven.pkg.github.com/digows/whatsapp-gateway</url>
  </repository>
</repositories>
```

GitHub Packages Maven consumption requires credentials. Configure Maven `settings.xml` with the same repository id:

```xml
<settings>
  <servers>
    <server>
      <id>github</id>
      <username>YOUR_GITHUB_USERNAME</username>
      <password>YOUR_GITHUB_CLASSIC_PAT_WITH_READ_PACKAGES</password>
    </server>
  </servers>
</settings>
```

The SDK CI publishes to GitHub Packages on pushes to `main`.

### Scope of the SDK

Use the SDK for:

- REST request and response typing
- NATS event payload typing
- consistent cross-service serialization

Do not expect it to provide:

- Baileys runtime access
- direct Redis, PostgreSQL or NATS clients
- control-plane orchestration

## NATS Integration

NATS remains the asynchronous contract for:

- inbound messages
- outbound commands
- command execution results
- delivery results
- session status updates
- activation lifecycle updates
- worker commands

### Recommended External Usage

Use REST when:

- you need an immediate operational result
- you need to request activation
- you need to change session desired state
- you need to read the durable session catalog

Use NATS when:

- you need inbound message fanout
- you need outbound command execution
- you need explicit typing or presence signaling
- you need delivery updates
- you need activation follow-up after the first challenge
- you need session lifecycle events in near real time

### Subject Strategy

Subjects are environment-driven templates.

The defaults are:

- worker control:
  - `gateway.v1.channel.{provider}.worker.{workerId}.control`
- incoming:
  - `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.incoming`
- outgoing:
  - `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.outgoing`
- command result:
  - `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.command-result`
- delivery:
  - `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.delivery`
- status:
  - `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.status`
- activation:
  - `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.activation`

If another system depends on these subjects, freeze the templates in deployment config and do not mutate them casually between environments.

## Outbound Command Contract

The `outgoing` subject now accepts family-based commands.

Supported families:

- `message`
  - `send`
- `presence`
  - `subscribe`
  - `update`
- `read`
  - `read_messages`
  - `send_receipt`
- `chat`
  - `archive`, `unarchive`, `pin`, `unpin`, `mute`, `unmute`
  - `clear`, `delete_for_me`, `delete_chat`
  - `mark_read`, `mark_unread`
  - `star`, `unstar`
- `group`
  - metadata, create, leave, invite, participant and settings operations
- `community`
  - metadata, link, invite, participant and settings operations
- `newsletter`
  - creation, metadata, follow, mute, fetch, reaction and ownership operations
- `profile`
  - profile picture, status, name, block and business profile operations
- `privacy`
  - privacy fetch and privacy update operations
- `call`
  - reject and create link

### Compatibility

The gateway still accepts the legacy outbound message-send payload on the same
subject.

That legacy payload is interpreted as:

- `family = message`
- `action = send`

New integrations should publish explicit family-based commands.

### Command Result Semantics

Every accepted outbound command produces one generic execution result on:

- `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.command-result`

Result status values:

- `succeeded`
- `failed`
- `blocked`

Important:

- `command-result` is the primary execution acknowledgement for all families
- `message/send` also continues to emit the delivery lifecycle on the `delivery` subject
- non-message families should be tracked through `command-result`, not through `delivery`

### Example: Presence Typing Indicator

```json
{
  "commandId": "cmd-typing-001",
  "session": {
    "provider": "whatsapp-web",
    "workspaceId": 1,
    "sessionId": "primary"
  },
  "family": "presence",
  "action": "update",
  "chatId": "5511999999999@s.whatsapp.net",
  "presence": "composing"
}
```

### Example: Generic Command Result

```json
{
  "commandId": "cmd-typing-001",
  "session": {
    "provider": "whatsapp-web",
    "workspaceId": 1,
    "sessionId": "primary"
  },
  "family": "presence",
  "action": "update",
  "status": "succeeded",
  "timestamp": "2026-04-04T12:00:00.000Z"
}
```

## Session Ownership Semantics

External services should understand one crucial rule:

- a `Session` is durable and global
- a live hosted runtime is local and exclusive

That means:

- any pod can answer the public session catalog API
- only one pod may host a given live WhatsApp session
- ownership is enforced through Redis locks
- ownership can move after rollout, crash or reconcile

So:

- integrate against the durable session model
- do not try to pin business behavior to one specific pod

## Recovery And Rollout Behavior

This service already supports automatic recovery driven by the durable session catalog.

What happens during rollout:

1. old pod receives `SIGTERM`
2. local worker host stops hosted sessions and releases locks
3. durable `Session` records still remain with `desiredState=active`
4. embedded control-plane leader sees missing live ownership
5. leader publishes `start_session` to a healthy worker
6. another pod reacquires the session

The integration consequence is:

- callers should reason in terms of `Session` desired state, not in terms of pod affinity

## Database Responsibilities

### `sessions`

This is the durable operational catalog.

Integrate with this conceptually, but preferably through the gateway API instead of direct database reads.

Contains data such as:

- desired state
- runtime state
- activation state
- assigned worker
- persisted credential flag
- operational timestamps and last error

### `authorization_keys`

This is technical credential storage.

External systems should not treat it as a session catalog.

Do not build discovery logic on top of `authorization_keys`.

That would reintroduce the coupling this refactor explicitly removed.

## Redis Responsibilities

Redis is not the durable source of truth for sessions.

It is used for:

- ownership leases
- worker liveness
- worker capacity registry
- auth cache
- anti-ban warm-up state
- control-plane leadership
- command dedupe

External systems should not persist business state there expecting durability semantics.

## Recommended Integration Patterns

### Pattern 1: Activation + Event Follow-Up

Best for onboarding UI or admin operations.

1. call `POST /activations`
2. show the first QR code or pairing code immediately
3. subscribe to activation events on NATS
4. wait for `completed`, `failed` or `expired`

### Pattern 2: Session Administration

Best for control-plane consumers or admin APIs.

1. call `GET /sessions`
2. inspect durable `desiredState`, `runtimeState`, `activationState`
3. call `PATCH` to set `active`, `paused` or `stopped`
4. consume `status` and `activation` events if you need real-time feedback

### Pattern 3: Outbound Messaging

Best for asynchronous command execution, including sends, typing indicators,
read receipts and chat operations.

1. ensure the target session exists and is active through REST
2. publish outbound command through NATS
3. consume `command-result`
4. for `message/send`, also consume delivery events through NATS

Do not convert outbound messaging to synchronous HTTP unless you have a concrete operational reason and owner-aware routing strategy.

## Security Guidance

This repository does not yet enforce a real authorization perimeter for external callers.

Integrate it behind:

- an internal API gateway
- service-to-service authentication
- workspace-scoped authorization checks outside this service

At minimum, the caller layer must guarantee:

- which workspaces it can operate
- which routes it can invoke
- who may start, stop or pause sessions

## Observability Guidance

The service already emits operational logs and worker heartbeat, but external infrastructure should still provide:

- centralized log aggregation
- NATS consumer monitoring
- Redis availability monitoring
- PostgreSQL monitoring
- deployment alerts for restart storms or reconcile failures

Recommended future additions:

- Prometheus metrics
- trace correlation across REST and NATS
- DLQ monitoring when replay support is added

## What Not To Do

Do not:

- read `authorization_keys` directly as a session list
- integrate against the internal hosted-session routes as if they were global
- depend on one pod staying owner of a session forever
- recreate Baileys logic in another service
- bypass the durable session catalog for lifecycle decisions
- publish arbitrary worker commands from business code without a very explicit infrastructure reason

## Current Gaps

The architecture is now coherent, but there are still gaps an integrating system should know about:

1. no public media download/storage pipeline yet
2. no explicit auth perimeter yet
3. no operator DLQ/replay workflow yet
4. no dedicated analytics read model beyond the durable `Session` catalog
5. no owner-aware synchronous routing for future live session actions beyond activation and desired-state control

These are not blockers for basic integration. They are the next maturity steps.

## Recommended Next Work For Another Agent

If another agent continues from here, the highest-value integration work is:

1. document request and event schemas as shared contract artifacts
2. add explicit HTTP examples for activation and session control
3. add auth middleware or integrate behind an existing internal gateway
4. add metrics and operational dashboards
5. add DLQ and replay tooling for JetStream mode
6. add media retrieval and durable media handles if downstream consumers need file bytes
