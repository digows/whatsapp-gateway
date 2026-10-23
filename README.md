# WhatsApp Gateway

A reusable custom-Baileys gateway core, independent of application domain policy.
The October 23 reconstruction replaces the legacy runtime and Java/NATS contract.
The existing checkout and Git history are preserved.

## Current increment

- `runtime`: account ownership, authentication/session restoration, paced/idempotent sends,
  explicit UNKNOWN outcomes, rich content and on-demand S3-compatible media.
- `packages/contracts`: the owning portable content/operation schemas and types.
- `packages/chat-adapter`: real Chat SDK Message/Attachment projection and explicit stable-key
  text-send mapping against `chat@4.43.0`.
- `runtime/migrations/001_gateway_core.sql`: fresh technical storage with workspace RLS.

The [gateway use case](docs/use-cases/gateway-core.md) owns behavior and limitations.
HTTP and Redis Streams/NATS mappings are still open. This is not a complete remote Chat SDK
Adapter or a deployable HTTP/broker service. It contains no placeholder network implementation.
There is no Jarvix, Mastra, DBOS or additional broker dependency.

## Development checks

Use Node 24 and pnpm 12.9.1. Install with `pnpm install --frozen-lockfile`.
Set `TMPDIR`, `XDG_CACHE_HOME` and the pnpm store directory to a task-owned location under
`/Volumes/Files/.tmp` when running disposable work in the development environment.

- `pnpm typecheck`: strict TypeScript, including tests and SDK compatibility.
- `pnpm format:check`: configured dprint checks.
- `pnpm test`: component, PostgreSQL and controlled Baileys/Chat SDK scenarios.

Tests require `GATEWAY_TEST_DATABASE_URL` pointing to an owned disposable PostgreSQL database,
with the versioned schema applied and a non-superuser/non-BYPASSRLS runtime role granted table
access. They never load `.env` or fall back to a production database. No live WhatsApp connection
is needed: socket I/O is controlled at the native boundary. Close gateways before closing stores.

The earlier `poc/` material is retained as historical feature evidence, not as the new runtime,
a compatibility layer or a recommended integration. Legacy releases/tags were removed separately;
this work does not rewrite Git history.
