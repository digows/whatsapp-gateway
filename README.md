# WhatsApp Web Provider (Baileys)

This microservice acts as the provider responsible for connecting the Jarvix Core to the WhatsApp network using the Baileys library in a secure, cloaked manner.

## The Anti-Ban Triad (Operational Shield)

Due to WhatsApp's strict anti-automation policies for personal accounts, this Provider is designed on three fundamental pillars to prevent network-level bans and behavioral detection:

### 1. Operational Fork of Baileys
- Instead of relying on the slow release cycle of the official NPM package (`@whiskeysockets/baileys`), we use an [Operational Fork on GitHub](https://github.com/digows/baileys).
- Meta aggressively updates the Web protocol (`wa_version`). The fork enables us to apply community patches instantly (within minutes) without waiting for official approvals, keeping Jarvix's downtime and pairing bugs at zero.

### 2. IP Rotation via Residential Proxies
- If all Jarvix sessions route through the same datacenter ASN (DigitalOcean, AWS), Meta will detect it and mass-ban the accounts.
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
- Jarvix borrows the good ideas from `baileys-antiban` but does not adopt its wrapper, local queue or scheduler as runtime boundaries.
- Those responsibilities are split differently here:
  - anti-ban policy lives inside the session runtime,
  - durable command/event flow lives in NATS,
  - warm-up state and worker liveness live in Redis.
- Detailed reference:
  - [ANTIBAN.md](/Volumes/Files/Development/workspaces/digows/agent-jarvix/microservices/channel-providers/whatsapp-web/anti-ban.md)

---

## Macro Architecture: Control Plane vs. Session Worker
To achieve high density and reliability, the WhatsApp Gateway is logically divided:

1. **Control Plane (Java/Core):**
   - Handles HTTP Traffic (Dashboards, APIs).
   - Manages onboarding, QR Code/Pairing generation.
   - Decides which Worker gets which session based on a Health Registry.
   
2. **Session Worker (This Node.js Project):**
   - Headless background workers connecting directly to Meta's WebSockets via Baileys.
   - Dedicated exclusively to cryptography and I/O networking logic.
   - Internally split into:
     - `SessionWorkerHost`: owns worker heartbeat, capacity, NATS subjects and session leases.
     - `BaileysProvider`: owns one WhatsApp socket, auth state, normalization and anti-ban behavior.
   - Optimal density: **50 to 100 concurrent Baileys sessions** per Node.js process (due to Event Loop constraints).

## High Availability & Concurrency (Redlock)
Centralized AuthState storage in PostgreSQL creates a strict concurrency danger: *If Pod A and Pod B attempt to open the same User's WebSocket simultaneously, Meta will detect a cryptographic anomaly and terminate/ban the connection.*

To prevent this in a horizontally scaled Kubernetes cluster:
- **Redlock (Distributed Lock):** Before a Node.js worker starts a session, it must acquire a unique TTL lock (`wa:lock:session:X`) in Redis.
- **Object Immutability (Redlock v5 Fix):** The `Lock` object in Redlock v5 is immutable. To avoid the "already-expired lock" bug during long sessions, the Provider correctly updates its internal lock reference on every extension (`.extend()`).
- **TTL of 120s:** Configured with a generous TTL to tolerate Network Jitter and resource-heavy History Syncs.
- **Heartbeat:** The lock is actively extended every 45 seconds (`lockHeartbeat`) while the WebSocket is healthy.
- **Registry:** Upon acquiring the lock, the worker writes its `WORKER_ID` to an assignment hash in Redis (`wa:registry:workers`). The Control Plane uses this mapped registry to route outbound messages strictly to the correct Pod holding the active WebSocket.

## Core Engineering Features

### 1. Persistence & Multi-Tenancy (RLS + BYTEA)
- **Tenant Isolation:** We use **Row Level Security (RLS)** in PostgreSQL. This ensures that even if Pods share the same database pool, a `workspaceId` (Tenant) can never access another tenant's cryptographic keys. 
- **Binary storage:** `AuthState` is stored using `BYTEA` columns, preventing UTF-8 string corruption of cryptographic buffers and improving I/O performance.
- **L1 Cache:** Redis acts as a write-through cache for auth keys, reducing PostgreSQL load.

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
- **Worker control:** `jarvix.v1.channel.whatsapp-web.worker.[workerId].control`
- **Inbound:** `jarvix.v1.channel.whatsapp-web.session.[workspaceId].[sessionId].incoming`
- **Outbound:** `jarvix.v1.channel.whatsapp-web.session.[workspaceId].[sessionId].outgoing`
- **Delivery:** `jarvix.v1.channel.whatsapp-web.session.[workspaceId].[sessionId].delivery`
- **Session status:** `jarvix.v1.channel.whatsapp-web.session.[workspaceId].[sessionId].status`
- **Responsibility split:** Redis remains responsible for liveness, leases and worker registry; NATS is responsible for commands and events between planes.
- **Stateless core boundary:** The provider handles the raw WhatsApp protocol and emits standardized SDK contracts, so the Core backend remains "WhatsApp-agnostic".

### 5. Entrypoints
- **`src/index.ts`:** production worker entrypoint. Boots the host and waits for control-plane commands.
- **`src/dev.ts`:** local development entrypoint. Boots the host and auto-starts one session from `DEV_WORKSPACE_ID` and `DEV_SESSION_ID`.

---

## Environment Configuration
Configure the `.env` based on the `.env.example` template. The application uses a strict Fail-Fast system backed by `Zod` to validate these environment variables upon startup.

- `RESIDENTIAL_PROXY_URL`: Residential Proxy endpoint. In a local dev environment (with only 1 or 2 test accounts), this can be left empty for direct IP routing.
- `POSTGRES_URL`: PostgreSQL connection string for saving cryptographic sessions (`AuthState`).
- `REDIS_URL`: Redis connection string for distributed locks and blazing-fast `AuthState` caching.
- `LOG_LEVEL`: Engine verbosity. Default: `info` (for deep WebSocket protocol debugging, set to `debug` or `trace`).
