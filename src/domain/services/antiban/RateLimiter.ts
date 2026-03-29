import { OutgoingMessageContent } from '@jarvix/ts-channel-provider';

export interface RateLimiterConfig {
  maxPerMinute: number;
  maxPerHour: number;
  maxPerDay: number;
  minDelayMs: number;
  maxDelayMs: number;
  newChatDelayMs: number;
  burstAllowance: number;
  maxCooldownMs: number;
}

interface MessageRecord {
  timestamp: number;
  recipient: string;
  fingerprint: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  delayMs: number;
  preSendDelayMs: number;
  typingDelayMs: number;
  reason?: string;
}

export class RateLimiter {
  private readonly messages: MessageRecord[] = [];
  private readonly knownChats = new Set<string>();
  private burstCount = 0;
  private lastMessageTime = 0;

  constructor(private readonly config: RateLimiterConfig) {}

  public getDelay(
    recipient: string,
    content: OutgoingMessageContent,
  ): RateLimitDecision {
    const now = Date.now();
    this.cleanup(now);
    this.resetBurstIfIdle(now);

    const dayMessages = this.messages.filter(message => now - message.timestamp < 86_400_000);
    if (dayMessages.length >= this.config.maxPerDay) {
      return {
        allowed: false,
        delayMs: 0,
        preSendDelayMs: 0,
        typingDelayMs: 0,
        reason: 'daily rate limit reached',
      };
    }

    const cooldownMs = this.computeCooldown(now);
    if (cooldownMs > this.config.maxCooldownMs) {
      return {
        allowed: false,
        delayMs: 0,
        preSendDelayMs: 0,
        typingDelayMs: 0,
        reason: `cooldown too long (${Math.round(cooldownMs / 1000)}s)`,
      };
    }

    let preSendDelayMs = cooldownMs;

    if (this.burstCount < this.config.burstAllowance) {
      preSendDelayMs += this.jitter(this.config.minDelayMs * 0.5, this.config.minDelayMs);
    } else {
      preSendDelayMs += this.jitter(this.config.minDelayMs, this.config.maxDelayMs);
    }

    if (!this.knownChats.has(recipient)) {
      preSendDelayMs += this.jitter(
        this.config.newChatDelayMs * 0.5,
        this.config.newChatDelayMs,
      );
    }

    const timeSinceLastMessage = now - this.lastMessageTime;
    if (timeSinceLastMessage < this.config.minDelayMs) {
      preSendDelayMs = Math.max(
        preSendDelayMs,
        this.config.minDelayMs - timeSinceLastMessage,
      );
    }

    const typingDelayMs = this.computeTypingDelay(content);

    return {
      allowed: true,
      delayMs: Math.round(preSendDelayMs + typingDelayMs),
      preSendDelayMs: Math.round(preSendDelayMs),
      typingDelayMs,
    };
  }

  public record(
    recipient: string,
    content: OutgoingMessageContent,
  ): void {
    const now = Date.now();
    this.resetBurstIfIdle(now);

    this.messages.push({
      timestamp: now,
      recipient,
      fingerprint: this.fingerprint(content),
    });
    this.knownChats.add(recipient);
    this.lastMessageTime = now;
    this.burstCount++;
  }

  public getStats(): {
    lastMinute: number;
    lastHour: number;
    lastDay: number;
    knownChats: number;
  } {
    const now = Date.now();
    this.cleanup(now);

    return {
      lastMinute: this.messages.filter(message => now - message.timestamp < 60_000).length,
      lastHour: this.messages.filter(message => now - message.timestamp < 3_600_000).length,
      lastDay: this.messages.filter(message => now - message.timestamp < 86_400_000).length,
      knownChats: this.knownChats.size,
    };
  }

  private computeCooldown(now: number): number {
    const hourMessages = this.messages.filter(message => now - message.timestamp < 3_600_000);
    const minuteMessages = this.messages.filter(message => now - message.timestamp < 60_000);

    let cooldownMs = 0;

    if (hourMessages.length >= this.config.maxPerHour) {
      const oldest = hourMessages[0];
      if (oldest) {
        cooldownMs = Math.max(cooldownMs, oldest.timestamp + 3_600_000 - now);
      }
    }

    if (minuteMessages.length >= this.config.maxPerMinute) {
      const oldest = minuteMessages[0];
      if (oldest) {
        cooldownMs = Math.max(cooldownMs, oldest.timestamp + 60_000 - now);
      }
    }

    return Math.max(cooldownMs, 0);
  }

  private resetBurstIfIdle(now: number): void {
    if (now - this.lastMessageTime > 30_000) {
      this.burstCount = 0;
    }
  }

  private cleanup(now: number): void {
    while (this.messages.length > 0 && now - this.messages[0].timestamp > 86_400_000) {
      this.messages.shift();
    }
  }

  private jitter(min: number, max: number): number {
    if (max <= min) {
      return Math.round(min);
    }

    const u1 = Math.random();
    const u2 = Math.random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const normalized = (normal + 3) / 6;
    const clamped = Math.max(0, Math.min(1, normalized));
    return Math.round(min + clamped * (max - min));
  }

  private computeTypingDelay(content: OutgoingMessageContent): number {
    const text = content.text ?? '';
    if (!text) {
      return 0;
    }

    const typingDelay = Math.min(text.length * 30, 3000);
    return this.jitter(typingDelay * 0.5, typingDelay);
  }

  private fingerprint(content: OutgoingMessageContent): string {
    return `${content.type}:${content.mediaUrl ?? ''}:${content.text ?? ''}`;
  }
}
