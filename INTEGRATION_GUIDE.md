# Integration boundary

The current core API and its guarantees are owned by
[Gateway accounts, sends and observed messages](docs/use-cases/gateway-core.md).

The former REST/NATS/Java wire contract is retired from this reconstruction. Do not use old
subjects, activation payloads or Java artifacts as the new remote contract. HTTP plus messaging
are required, but their mapping remains an explicit owner decision. Redis Streams is the intended
first application transport; this does not establish ACK, retention, ordering or replay semantics.
NATS compatibility does not provision a broker or imply JetStream durability.

`GatewayOperations` is the typed, transport-independent application boundary. Application callers
must retain an explicit operation key and inspect original status after an unknown effect.
The Chat SDK mapping's ordinary post method is not an exactly-once application retry contract.
Rich content remains available through the owning portable operations; no capability is silently
replaced with plain text merely to fit a common chat interface.

No deployment, webhook authentication, remote subscription or end-to-end integration is claimed.
