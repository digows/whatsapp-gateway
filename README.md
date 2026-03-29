# WhatsApp Gateway (Baileys)

This project is a WhatsApp gateway worker focused on multi-session, multi-tenant and horizontally scalable operation over Baileys. It is WhatsApp-specific at the runtime layer, but its control and messaging boundaries are gateway-owned rather than tied to a Jarvix SDK contract.

## The Anti-Ban Triad (Operational Shield)

Due to WhatsApp's strict anti-automation policies for personal accounts, this Provider is designed on three fundamental pillars to prevent network-level bans and behavioral detection:

### 1. Operational Fork of Baileys
- Instead of relying on the slow release cycle of the official NPM package (`@whiskeysockets/baileys`), we use an [Operational Fork on GitHub](https://github.com/digows/baileys).
- Meta aggressively updates the Web protocol (`wa_version`). The fork enables us to apply community patches instantly without waiting for official approvals, reducing downtime and pairing regressions.

### 2. IP Rotation via Residential Proxies
- If all sessions route through the same datacenter ASN (DigitalOcean, AWS), Meta will detect it and mass-ban the accounts.
- The Provider dynamically injects an `HttpsProxyAgent` into the Socket lifecycle, routing the master WebSocket connection and HTTP requests (media, profile pictures) through a reliable domestic provider before touching Meta's servers. This masks the server's true origin.
- *Usage:* Configurable via the `RESIDENTIAL_PROXY_URL` environment variable.

### 3. Behavioral Middleware (Anti-Ban)
- The runtime currently enforces an in-process anti-ban policy instead of delegating the send path to an external wrapper.
- This policy is intentionally modeled after the same operational shield:
  - **Gaussian-like Jitter:** Randomizes dispatch delay while separating queue cooldown from typing simulation, so the worker does not look like it is typing for 30-60 seconds straight.
  - **Presence Simulation:** Sends `presenceSubscribe` + `composing` only for the final typing window before direct text delivery, then pauses after the send.
  - **Throttling:** Strictly limits messages per minute/hour/day and blocks traffic when the worker exceeds those rails.
  - **Warm-Up Policy:** Session-scoped Redis state progressively raises daily outbound limits and can restart warm-up after long inactivity.
  - **Health Monitor:** Forced disconnects and send failures increase risk and can auto-pause outbound traffic.
  - **Content Variator:** Prevents Spamming By Value bans by injecting invisible zero-width characters only after repeated identical text.
- The gateway borrows the good ideas from `baileys-antiban` but does not adopt its wrapper, local queue or scheduler as runtime boundaries.
- Those responsibilities are split differently here:
  - anti-ban policy lives inside the session runtime,
  - durable command/event flow lives in NATS,
  - warm-up state and worker liveness live in Redis.
- Detailed reference:
  - [ANTIBAN.md](./ANTIBAN.md)

---

## Macro Architecture: Control Plane vs. Session Worker
To achieve high density and reliability, the gateway is logically divided:

1. **Control Plane:**
   - Manages onboarding, QR code or pairing-code activation and session lifecycle.
   - Routes commands and receives events over NATS.
   - Decides which worker should own which session based on health and leases.
   
2. **Session Worker (This Node.js Project):**
   - Headless background workers connecting directly to Meta's WebSockets via Baileys.
   - Dedicated exclusively to cryptography and I/O networking logic.
   - Internally split into:
     - `SessionWorkerHost`: owns worker heartbeat, capacity, NATS subjects and session leases.
     - `BaileysProvider`: owns one WhatsApp socket, auth state, normalization and anti-ban behavior.
   - A single worker process can host multiple WhatsApp sessions concurrently, up to `MAX_CONCURRENT_SESSIONS`.

## High Availability & Concurrency (Redlock)
Centralized authentication state storage in PostgreSQL creates a strict concurrency danger: *if Pod A and Pod B attempt to open the same WhatsApp session simultaneously, Meta will detect a cryptographic anomaly and terminate the connection.*

To prevent this in a horizontally scaled Kubernetes cluster:
- **Redlock (Distributed Lock):** Before a worker starts a session, it must acquire a unique TTL lock in Redis.
- **Object Immutability (Redlock v5 Fix):** The `Lock` object in Redlock v5 is immutable. To avoid the "already-expired lock" bug during long sessions, the Provider correctly updates its internal lock reference on every extension (`.extend()`).
- **TTL of 120s:** Configured with a generous TTL to tolerate Network Jitter and resource-heavy History Syncs.
- **Heartbeat:** The lock is actively extended every 45 seconds (`lockHeartbeat`) while the WebSocket is healthy.
- **Registry:** Upon acquiring the lock, the worker writes its `WORKER_ID` to an assignment hash in Redis. The control plane uses this mapped registry to route outbound messages strictly to the worker holding the active WebSocket.

## Core Engineering Features

### 1. Persistence & Multi-Tenancy (RLS + BYTEA)
- **Tenant Isolation:** We use **Row Level Security (RLS)** in PostgreSQL. This ensures that even if Pods share the same database pool, a `workspaceId` (Tenant) can never access another tenant's cryptographic keys. 
- **Binary storage:** `AuthState` is stored using `BYTEA` columns, preventing UTF-8 string corruption of cryptographic buffers and improving I/O performance.
- **L1 Cache:** Redis acts as a write-through cache for auth keys, reducing PostgreSQL load.
- **Session cardinality:** One tenant can own multiple WhatsApp sessions, each identified by `provider + workspaceId + sessionId`.

### 2. Fail-Safe Strategy (end vs logout)
To prevent accidental unpairing (the most common bug in Baileys implementations):
- **`end()`:** Used for all error-handling and socket closures. It drops the connection without destroying the session tokens.
- **`logout()`:** Strictly reserved for explicit user actions. Calling this instructs Meta to **unpair the device** from the phone.

### 3. Identity Resolution (LID-to-PN)
Meta masks phone numbers with **LIDs** (Local Identifiers) in certain contexts. The Provider resolves these on-the-fly:
- **`participantAlt` Extraction:** Automatically captures the real phone number (`+E.164`) from message metadata.
- **Resolution Cache:** Mappings between `@lid` and `@s.whatsapp.net` are cached in Redis (30-day TTL) for sub-millisecond retrieval.

### 4. NATS Bridge (Standardized Payloads)
The worker host uses NATS as the asynchronous bridge between Control Plane and session runtimes.
- **Worker control:** `gateway.v1.channel.{provider}.worker.{workerId}.control`
- **Inbound:** `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.incoming`
- **Outbound:** `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.outgoing`
- **Delivery:** `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.delivery`
- **Session status:** `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.status`
- **Activation:** `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.activation`
- **Responsibility split:** Redis remains responsible for liveness, leases and worker registry; NATS is responsible for commands and events between planes.
- **Gateway boundary:** The runtime handles the raw WhatsApp protocol and emits gateway-owned events and commands, so the control plane stays decoupled from Baileys internals.

### 5. Entrypoints
- **`src/index.ts`:** production worker entrypoint. Boots the host and waits for control-plane commands.
- **`src/dev.ts`:** local development entrypoint. Boots the host and auto-starts one session from `DEV_WORKSPACE_ID` and `DEV_SESSION_ID`.

---

## Environment Configuration
Configure the `.env` based on the `.env.example` template. The application uses a strict Fail-Fast system backed by `Zod` to validate these environment variables upon startup.

- `RESIDENTIAL_PROXY_URL`: Residential Proxy endpoint. In a local dev environment (with only 1 or 2 test accounts), this can be left empty for direct IP routing.
- `CHANNEL_PROVIDER_ID`: Logical provider identifier carried in subjects, sessions and telemetry. Default: `whatsapp-web`.
- `POSTGRES_URL`: PostgreSQL connection string for saving cryptographic sessions (`AuthState`).
- `REDIS_URL`: Redis connection string for distributed locks and blazing-fast `AuthState` caching.
- `LOG_LEVEL`: Engine verbosity. Default: `info` (for deep WebSocket protocol debugging, set to `debug` or `trace`).
