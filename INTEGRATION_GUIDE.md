# Infrastructure Integration Guide

This document is intended for another coding agent, another development session, or a senior engineer continuing the integration work around this repository.

It explains how to plug this WhatsApp gateway worker into a broader infrastructure without rewriting the runtime or reintroducing the legacy Jarvix control-plane assumptions.

## Verified Current State

The repository already contains:
- A WhatsApp-specific Baileys runtime.
- A multi-session worker host.
- Redis-backed single-owner session leases.
- Redis-backed worker heartbeat/registry.
- NATS-based command/event transport.
- PostgreSQL + Redis auth-state persistence.
- A synchronous REST API for activation.
- A local-worker REST API for health and session inspection.
- Docker/Kubernetes packaging.

The repository does **not** currently contain:
- A session catalog.
- Desired-state persistence.
- A controller/reconciler.
- Placement or rebalancing logic.
- A global query/read surface.
- Media download/storage abstraction.
- Owner-aware synchronous routing across multiple worker pods.

## Architectural Rule

Do **not** turn this worker into a generic “everything service” in one step.

Keep the following split:
- The existing worker/runtime remains responsible for WhatsApp protocol execution.
- New integration work should add orchestration, state and read models **around** the worker.

The recommended first production topology is **self-managed gateway**, not a separate control-plane product:
- same repository,
- same domain language,
- same NATS boundary,
- new controller module inside the project.

## Fixed Assumptions

These should be preserved unless the product direction changes explicitly:

1. The runtime remains WhatsApp/Baileys-specific.
2. NATS remains the primary boundary in v1.
3. This service is multi-session and multi-tenant.
4. Session identity remains `provider + workspaceId + sessionId`.
5. Redis continues to own leases, liveness and short-lived coordination.
6. PostgreSQL continues to own durable session/auth records.
7. Synchronous operational calls may use REST, but lifecycle fanout remains event-driven.
8. Another layer, not the Baileys runtime itself, should own authorization and global infrastructure-facing queries.

## Verified HTTP Surface

The worker now exposes:
- `GET /healthz`
- `GET /readyz`
- `POST /api/v1/workspaces/:workspaceId/activations`
- `GET /api/v1/workspaces/:workspaceId/sessions`
- `GET /api/v1/workspaces/:workspaceId/sessions/:sessionId`
- `DELETE /api/v1/workspaces/:workspaceId/sessions/:sessionId`

Important limitation:
- session routes expose the **local worker view only**
- they do not resolve ownership across pods
- they do not read from a global catalog

This is enough for direct pod/service operation and Kubernetes health checks.
It is not yet a replacement for a real controller/read-model layer.

## Recommended Target Topology

Implement two roles inside this same codebase:

1. **Worker role**
   - What already exists today.
   - Hosts Baileys sessions and executes commands.

2. **Controller role**
   - New module.
   - Owns session desired state.
   - Reconciles actual runtime state.
   - Performs worker placement.
   - Retries activation and repairs orphaned sessions.

Deployment options:
- One deployment running both roles.
- Separate deployments from the same codebase, for example `ROLE=worker`, `ROLE=controller`, `ROLE=all`.

Do not create a second repository for the controller unless the operational need is already proven.

## Minimum New Capabilities To Add

### 1. Session Catalog

Add a durable session catalog table in PostgreSQL.

Recommended minimum fields:
- `provider`
- `workspace_id`
- `session_id`
- `desired_state`
- `actual_state`
- `assigned_worker_id`
- `activation_state`
- `last_error`
- `last_connected_at`
- `updated_at`

This is the missing source of truth.

Without it, the current runtime can execute sessions, but it cannot decide which sessions should exist.

### 2. Reconciler

Add a periodic controller loop that:
- loads sessions from the catalog,
- reads worker heartbeat data from Redis,
- reads current ownership from Redis,
- reads recent status from the read model,
- issues `start_session`, `stop_session` or activation commands when reality diverges from desired state.

This reconciler is the minimal “control plane function”.

### 3. Placement

Start simple.

Recommended first algorithm:
- choose healthy workers only,
- filter workers that still have capacity,
- place on the least-loaded worker,
- avoid moving an already healthy session unless there is a hard reason.

Do not build a complex scheduler first.

### 4. Read Model

External systems should not be forced to replay all events to answer simple operational questions.

Add a read model for:
- session state,
- assigned worker,
- latest activation state,
- last delivery result,
- last inbound timestamp,
- worker capacity snapshot.

This can be PostgreSQL, Redis, or both.

### 5. Broker Recovery Features

The transport already supports `ephemeral` and `jetstream`.

Still missing:
- DLQ,
- replay tooling,
- poison-message handling,
- integration tests against real NATS/JetStream/Redis,
- operator-visible retry state.

This is required before declaring the gateway “production-grade” for other services.

### 6. Media Pipeline

There is currently no media download/storage layer in this repository.

If agents or downstream services need image/audio/document bytes:
- add media retrieval in the Baileys layer,
- upload to durable object storage,
- publish or persist a safe media handle instead of only message metadata.

Do not couple long-lived media storage to Redis.

## REST And NATS Integration Guidance

Use both boundaries intentionally:
- REST for synchronous operational requests that need an immediate result.
- NATS for lifecycle fanout and asynchronous integration.

Recommended usage by surrounding infrastructure:
- call REST to request activation and inspect or stop locally hosted sessions,
- consume NATS activation, status, inbound and delivery events,
- use a read model for cross-worker or historical queries.

Do not make external consumers depend on internal runtime classes directly.

Instead, publish a shared contract package or schemas based on the gateway domain entities already defined in this repository.

## What Not To Rewrite

Avoid these mistakes:
- do not replace the worker host lifecycle with a brand new runtime abstraction,
- do not move anti-ban logic out of the session runtime unless there is a very strong reason,
- do not reintroduce legacy Jarvix contracts,
- do not add fake generic abstractions over Baileys,
- do not make the worker responsible for business authorization decisions,
- do not hide session ownership logic outside Redis without a replacement plan.

## Highest-Value Missing Piece

The next real architecture gap is not another endpoint.

It is ownership-aware synchronous routing and a session catalog.

Without that:
- activation creation works because the session can be created on the pod that received the request,
- local session queries work,
- but any future synchronous operation against an already hosted session can hit the wrong pod.

That is why the next major milestone should add:
- durable session catalog,
- controller/reconciler,
- worker placement,
- owner-aware routing or query indirection.

## Suggested Implementation Order

1. Add the session catalog and its repository.
2. Add controller role bootstrap and leader election.
3. Add reconciler loop with simple placement.
4. Add read model updates from status/delivery/activation events.
5. Add owner-aware synchronous routing for existing sessions.
6. Add DLQ and replay support.
7. Add media pipeline if downstream consumers require content bytes.
8. Add metrics and richer operational tooling.

## Expected Outcome

After these additions, this repository becomes:
- a self-managed gateway microservice,
- deployable as one logical platform component,
- usable through REST for synchronous operations,
- still NATS-first,
- still WhatsApp/Baileys-specific,
- usable by other microservices and agents without depending on a separate legacy control plane.
