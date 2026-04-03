# Anti-Ban

This document expands the "Behavioral Middleware (Anti-Ban)" section from the provider [README.md](README.md).

It describes the anti-ban protections currently implemented in the WhatsApp Web provider.

It documents the runtime as it exists today. It does not describe future ideas, external wrappers or control-plane behavior that is not enforced inside this worker.

Within the anti-ban triad described in the README:
- the Baileys operational fork reduces protocol drift risk,
- residential proxies reduce network-origin risk,
- this document covers the behavioral protection layer enforced by the runtime.

## Scope

The anti-ban layer is outbound-focused.

It is responsible for:
- deciding whether an outbound send is allowed,
- inserting human-like delay before a send,
- simulating a short typing window for direct text messages,
- limiting volume and repetition,
- slowing down or pausing a session when the runtime starts showing ban-risk symptoms,
- persisting session warm-up state across worker restarts and worker moves.

It is not responsible for:
- durable queueing,
- campaign scheduling,
- onboarding,
- proxy rotation strategy,
- choosing which worker owns a session.

Those responsibilities live elsewhere in the Jarvix architecture.

## Runtime Flow

For each outbound message, the session runtime follows this order:

1. `BaileysProvider.send()` calls `AntiBanService.beforeSend()`.
2. `AntiBanService` initializes session warm-up state from Redis on first use.
3. Health is evaluated. If the session is paused by risk, the send is blocked.
4. Warm-up limits are evaluated. If the session exceeded the allowed daily volume for its current warm-up day, the send is blocked.
5. Repeated text is analyzed. If the same normalized message has already been sent several times, the content may be varied.
6. Rate limiting computes two delays:
   - `preSendDelayMs`: operational wait before typing starts
   - `typingDelayMs`: the short "human typing" window
7. `BaileysProvider` waits `preSendDelayMs`.
8. For direct text messages only, it sends `presenceSubscribe` and `composing`.
9. `BaileysProvider` waits `typingDelayMs`.
10. The message is sent with Baileys.
11. On success, `AntiBanService.afterSend()` updates counters and persists warm-up state.
12. On failure, `AntiBanService.afterSendFailed()` records a health event.
13. For direct text messages, the runtime sends `paused` at the end.

Relevant code:
- [AntiBanService.ts](src/domain/services/AntiBanService.ts)
- [BaileysProvider.ts](src/infrastructure/baileys/BaileysProvider.ts)

## Components

### 1. Rate Limiter

Implemented in [RateLimiter.ts](src/domain/services/antiban/RateLimiter.ts).

Current behavior:
- blocks sends when the session already reached `ANTI_BAN_MAX_PER_DAY`,
- computes cooldown based on rolling 1-minute and 1-hour windows,
- blocks sends when the required cooldown would exceed `ANTI_BAN_MAX_COOLDOWN_MS`,
- inserts gaussian-like jitter between `ANTI_BAN_MIN_DELAY_MS` and `ANTI_BAN_MAX_DELAY_MS`,
- applies extra delay for a new chat that has never been seen before in the current process,
- enforces a minimum spacing between consecutive sends,
- increases pacing after the burst allowance is consumed,
- estimates typing duration from text length, capped at 3 seconds.

Important implementation detail:
- `preSendDelayMs` and `typingDelayMs` are separated on purpose.
- Jarvix does not keep `composing` active for the full cooldown window, because that would look artificial.

What is process-local:
- rolling counters,
- known chat detection,
- burst tracking.

This means a process restart resets those pacing memories.

### 2. Warm-Up Policy

Implemented in [WarmUpPolicy.ts](src/domain/services/antiban/WarmUpPolicy.ts) with persistence in [RedisAntiBanWarmUpStateRepository.ts](\src/infrastructure/redis/RedisAntiBanWarmUpStateRepository.ts).

Current behavior:
- keeps a session-scoped warm-up state with:
  - `startedAt`
  - `lastActiveAt`
  - `dailyCounts`
  - `graduated`
- starts with either:
  - `graduated`, when `ANTI_BAN_WARMUP_MISSING_STATE_MODE=graduated`
  - `warming`, when `ANTI_BAN_WARMUP_MISSING_STATE_MODE=warming`
- uses `ANTI_BAN_WARMUP_DAY1_LIMIT` as the first-day cap,
- grows the daily cap by `ANTI_BAN_WARMUP_GROWTH_FACTOR`,
- graduates after `ANTI_BAN_WARMUP_DAYS`,
- resets the warm-up state after `ANTI_BAN_WARMUP_INACTIVITY_THRESHOLD_HOURS` of inactivity,
- persists state in Redis with `ANTI_BAN_WARMUP_STATE_TTL_SECONDS`.

Why Redis:
- warm-up should survive worker restarts,
- warm-up should follow the session if the lock moves to another worker.

Important tradeoff:
- warm-up persistence is shared by session, but pacing counters are not.
- This is intentional. Warm-up is a long-lived operational rule; fine-grained message timing is a short-lived runtime memory.

### 3. Health Monitor

Implemented in [HealthMonitor.ts](src/domain/services/antiban/HealthMonitor.ts).

The health monitor scores symptoms in the last hour:
- forbidden disconnects add 40 points each,
- logged-out events add 60 points,
- repeated disconnects add 15 or 30 points depending on threshold,
- repeated send failures add 20 points once the threshold is crossed.

Risk levels:
- `low`: score below 30
- `medium`: score 30-59
- `high`: score 60-84
- `critical`: score 85-100

Auto-pause:
- if the current risk is at or above `ANTI_BAN_AUTO_PAUSE_AT`, `beforeSend()` blocks outbound sends.
- the default threshold is `critical`.

Additional behavior:
- when risk changes, the provider can log the transition if `ANTI_BAN_LOG_RISK_CHANGES=true`,
- disconnects are recorded from Baileys connection close events,
- failed sends are recorded from send exceptions,
- reconnect events are tracked for observability, although they do not currently reduce score directly.

### 4. Content Variator

Implemented in [ContentVariator.ts](whatsapp-web/src/domain/services/antiban/ContentVariator.ts).

Current behavior:
- only applies to text messages,
- normalizes text with trim + collapsed whitespace + lowercase to build a tracking key,
- allows a message to be repeated up to `ANTI_BAN_MAX_IDENTICAL_MESSAGES`,
- after that threshold, it can:
  - inject zero-width characters when `ANTI_BAN_ZERO_WIDTH_VARIATION_ENABLED=true`,
  - append small punctuation variations when `ANTI_BAN_PUNCTUATION_VARIATION_ENABLED=true`.

Important guardrail:
- Jarvix does not rewrite meaning.
- It does not use synonyms, paraphrasing or emoji stuffing.
- The goal is to avoid repeated-byte patterns, not to mutate the message content aggressively.

Current limitation:
- repeated-message counters are process-local and reset on restart.

### 5. Risk-Based Delay Scaling

Implemented in [AntiBanService.ts](src/domain/services/AntiBanService.ts).

When a send is still allowed, Jarvix scales only the `preSendDelayMs` according to current risk:
- `medium`: 1.5x
- `high`: 2.25x
- `critical`: 3x

This means:
- a session under stress becomes slower before it becomes fully blocked,
- typing simulation remains short and realistic,
- the worker degrades more gracefully than a binary allow/deny system.

## Baileys Integration

The anti-ban policy is not a Baileys wrapper. It is enforced explicitly by the session runtime in [BaileysProvider.ts](src/infrastructure/baileys/BaileysProvider.ts).

Current integration details:
- presence simulation is used only for direct text messages,
- group messages do not use `composing`,
- non-text messages do not simulate typing,
- on socket reconnect the anti-ban service records a reconnect event,
- on socket close the anti-ban service records a disconnect reason,
- on send failure the anti-ban service records a failed-message event.

This explicit integration is intentional. Jarvix keeps outbound behavior visible in the provider instead of hiding it behind a generic monkey-patch wrapper.

## Configuration

Main anti-ban environment variables are defined in [env.ts](src/application/config/env.ts) and exposed in [.env.example](.env.example).

Core switches:
- `ANTI_BAN_ENABLED`
- `ANTI_BAN_AUTO_PAUSE_AT`

Rate limiting:
- `ANTI_BAN_MIN_DELAY_MS`
- `ANTI_BAN_MAX_DELAY_MS`
- `ANTI_BAN_NEW_CHAT_DELAY_MS`
- `ANTI_BAN_MAX_COOLDOWN_MS`
- `ANTI_BAN_BURST_ALLOWANCE`
- `ANTI_BAN_MAX_PER_MINUTE`
- `ANTI_BAN_MAX_PER_HOUR`
- `ANTI_BAN_MAX_PER_DAY`

Duplicate protection:
- `ANTI_BAN_MAX_IDENTICAL_MESSAGES`
- `ANTI_BAN_ZERO_WIDTH_VARIATION_ENABLED`
- `ANTI_BAN_PUNCTUATION_VARIATION_ENABLED`

Warm-up:
- `ANTI_BAN_WARMUP_ENABLED`
- `ANTI_BAN_WARMUP_DAYS`
- `ANTI_BAN_WARMUP_DAY1_LIMIT`
- `ANTI_BAN_WARMUP_GROWTH_FACTOR`
- `ANTI_BAN_WARMUP_INACTIVITY_THRESHOLD_HOURS`
- `ANTI_BAN_WARMUP_MISSING_STATE_MODE`
- `ANTI_BAN_WARMUP_STATE_TTL_SECONDS`

Health:
- `ANTI_BAN_HEALTH_DISCONNECT_WARNING_THRESHOLD`
- `ANTI_BAN_HEALTH_DISCONNECT_CRITICAL_THRESHOLD`
- `ANTI_BAN_HEALTH_FAILED_MESSAGE_THRESHOLD`
- `ANTI_BAN_LOG_RISK_CHANGES`

## Known Limits

The current implementation is useful, but it is not magic.

Known limits today:
- no long-lived persistent message timing history beyond the current process,
- no campaign scheduler or delayed queue inside the worker,
- no semantic content rewriting,
- no inbound reputation scoring,
- no cross-session anti-ban coordination,
- no adaptive model based on real delivery feedback from WhatsApp.

The current design is intentionally conservative:
- durable flow belongs to NATS,
- session ownership belongs to Redis,
- anti-ban belongs to the session runtime.

## Operational Guidance

For normal conversational traffic:
- keep `ANTI_BAN_WARMUP_ENABLED=true`,
- prefer `ANTI_BAN_WARMUP_MISSING_STATE_MODE=graduated` only for already-established sessions,
- keep `ANTI_BAN_AUTO_PAUSE_AT=critical` unless you want a more defensive posture,
- keep punctuation variation disabled unless a specific workload proves it necessary.

For colder or more fragile sessions:
- switch `ANTI_BAN_WARMUP_MISSING_STATE_MODE=warming`,
- reduce `ANTI_BAN_MAX_PER_MINUTE` and `ANTI_BAN_MAX_PER_HOUR`,
- lower `ANTI_BAN_AUTO_PAUSE_AT` to `high` if you want the worker to stop earlier.
