# Use Case: Outbound Command Families

## Purpose

Define the gateway-side outbound command contract for integrations that need to
operate a WhatsApp session beyond plain message sending.

This use case covers the asynchronous NATS contract only.

## Actors

- external service or internal product service publishing outbound commands
- `SessionWorkerHost` executing commands for the hosted session
- `BaileysProvider` translating the contract into WhatsApp/Baileys operations
- downstream consumers observing command execution results and delivery lifecycle

## Scope

Supported command families:

- `message`
- `presence`
- `read`
- `chat`
- `group`
- `community`
- `newsletter`
- `profile`
- `privacy`
- `call`

## Entry Point

The actor publishes a command payload to the rendered NATS `outgoing` subject
for a specific session:

- `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.outgoing`

## Core Flow

1. the actor publishes a command payload
2. the transport validates and parses the payload into a typed `OutboundCommand`
3. the worker host resolves the current hosted session runtime
4. the provider executes the typed command against Baileys
5. the transport publishes a `command-result` event
6. when the family is `message` and the action is `send`, the transport also
   publishes the existing delivery lifecycle event

## Invariants

- every outbound command must declare `commandId`
- every outbound command must declare `session`
- every outbound command must declare `family`
- every outbound command must declare `action`
- unsupported family or action values must be rejected during parsing
- every accepted outbound command must produce exactly one `command-result`
- `message/send` must keep the existing delivery contract in addition to
  `command-result`
- integrations must not depend on pod affinity; the addressed session may move
  between workers while preserving the same subject contract

## Backward Compatibility

- the `outgoing` subject still accepts the legacy message-send payload that does
  not declare `family`
- the legacy payload is interpreted as `family=message` and `action=send`
- new integrations should publish family-based commands explicitly

## Result Contract

Generic execution results are published to:

- `gateway.v1.channel.{provider}.session.{workspaceId}.{sessionId}.command-result`

The result carries:

- `commandId`
- `session`
- `family`
- `action`
- `status`
- `timestamp`
- optional `reason`
- optional `data`

Status values:

- `succeeded`
- `failed`
- `blocked`

## Failure Modes

- invalid payload shape
  - rejected before execution
- session not hosted locally at the time of consumption
  - command execution fails at worker level
- Baileys rejects the operation
  - execution result is `failed`
- anti-ban or internal policy blocks the operation
  - execution result is `blocked`

## Idempotency And Dedupe

- the gateway already uses dedupe-aware outbound processing when running on
  JetStream
- callers should still provide stable `commandId` values when retrying
- command-level idempotency beyond transport dedupe depends on the semantics of
  the underlying Baileys or WhatsApp operation

## Integration Boundaries

External systems should:

- publish typed commands
- observe `command-result`
- observe `delivery` when sending messages

External systems should not:

- publish raw worker control commands as a substitute for business integration
- depend on Baileys payloads directly
- infer success for non-message families from the absence of errors alone

## Testing Expectations

Changes to this use case should update:

- transport parsing tests
- provider execution tests when command semantics change
- SDK serialization tests when the public wire contract changes
