import { env } from '../../application/config/env.js';
import { MessageContent } from '../entities/messaging/MessageContent.js';
import { SessionReference } from '../entities/operational/SessionReference.js';
import { WarmUpStateRepository } from '../repositories/antiban/WarmUpStateRepository.js';
import { ContentVariator } from './antiban/ContentVariator.js';
import {
  BanRiskLevel,
  HealthMonitor,
  HealthStatus,
} from './antiban/HealthMonitor.js';
import { RateLimiter } from './antiban/RateLimiter.js';
import { WarmUpPolicy, WarmUpStatus } from './antiban/WarmUpPolicy.js';

export interface AntiBanDecision {
  allowed: boolean;
  delayMs: number;
  preSendDelayMs: number;
  typingDelayMs: number;
  riskLevel: BanRiskLevel;
  content: MessageContent;
  reason?: string;
  trackingKey?: string;
  health: HealthStatus;
  warmUp: WarmUpStatus;
}

/**
 * Behavioral guard aligned with the worker runtime design:
 * explicit policies, session-scoped warm-up persistence and no opaque send wrapper.
 */
export class AntiBanService {
  private readonly rateLimiter = new RateLimiter({
    maxPerMinute: env.ANTI_BAN_MAX_PER_MINUTE,
    maxPerHour: env.ANTI_BAN_MAX_PER_HOUR,
    maxPerDay: env.ANTI_BAN_MAX_PER_DAY,
    minDelayMs: env.ANTI_BAN_MIN_DELAY_MS,
    maxDelayMs: env.ANTI_BAN_MAX_DELAY_MS,
    newChatDelayMs: env.ANTI_BAN_NEW_CHAT_DELAY_MS,
    burstAllowance: env.ANTI_BAN_BURST_ALLOWANCE,
    maxCooldownMs: env.ANTI_BAN_MAX_COOLDOWN_MS,
  });
  private readonly warmUp = new WarmUpPolicy({
    enabled: env.ANTI_BAN_WARMUP_ENABLED,
    warmUpDays: env.ANTI_BAN_WARMUP_DAYS,
    day1Limit: env.ANTI_BAN_WARMUP_DAY1_LIMIT,
    growthFactor: env.ANTI_BAN_WARMUP_GROWTH_FACTOR,
    inactivityThresholdHours: env.ANTI_BAN_WARMUP_INACTIVITY_THRESHOLD_HOURS,
    missingStateMode: env.ANTI_BAN_WARMUP_MISSING_STATE_MODE,
  });
  private readonly healthMonitor = new HealthMonitor({
    disconnectWarningThreshold: env.ANTI_BAN_HEALTH_DISCONNECT_WARNING_THRESHOLD,
    disconnectCriticalThreshold: env.ANTI_BAN_HEALTH_DISCONNECT_CRITICAL_THRESHOLD,
    failedMessageThreshold: env.ANTI_BAN_HEALTH_FAILED_MESSAGE_THRESHOLD,
    autoPauseAt: env.ANTI_BAN_AUTO_PAUSE_AT,
    onRiskChange: status => {
      if (env.ANTI_BAN_LOG_RISK_CHANGES) {
        console.warn(
          `[ANTIBAN] Risk changed for ${this.session.toLogLabel()}: ${status.risk.toUpperCase()} (${status.score}) - ${status.recommendation}`,
        );
      }
    },
  });
  private readonly variator = new ContentVariator({
    maxIdenticalMessages: env.ANTI_BAN_MAX_IDENTICAL_MESSAGES,
    zeroWidthVariationEnabled: env.ANTI_BAN_ZERO_WIDTH_VARIATION_ENABLED,
    punctuationVariationEnabled: env.ANTI_BAN_PUNCTUATION_VARIATION_ENABLED,
  });
  private readonly repeatedMessages = new Map<string, number>();
  private initPromise?: Promise<void>;

  constructor(
    private readonly session: SessionReference,
    private readonly warmUpRepository: WarmUpStateRepository,
  ) {}

  public async beforeSend(
    recipientId: string,
    content: MessageContent,
  ): Promise<AntiBanDecision> {
    await this.initialize();

    if (!env.ANTI_BAN_ENABLED) {
      return {
        allowed: true,
        delayMs: 0,
        preSendDelayMs: 0,
        typingDelayMs: 0,
        riskLevel: 'low',
        content,
        health: this.healthMonitor.getStatus(),
        warmUp: this.warmUp.getStatus(),
      };
    }

    const health = this.healthMonitor.getStatus();
    if (this.healthMonitor.isPaused()) {
      return {
        allowed: false,
        delayMs: 0,
        preSendDelayMs: 0,
        typingDelayMs: 0,
        riskLevel: health.risk,
        content,
        reason: `anti-ban auto-pause at risk ${health.risk} (${this.healthMonitor.getAutoPauseThreshold()} threshold)`,
        health,
        warmUp: this.warmUp.getStatus(),
      };
    }

    const warmUpDecision = this.warmUp.beforeSend();
    if (warmUpDecision.stateChanged) {
      await this.persistWarmUpState();
    }

    if (!warmUpDecision.allowed) {
      return {
        allowed: false,
        delayMs: 0,
        preSendDelayMs: 0,
        typingDelayMs: 0,
        riskLevel: health.risk,
        content,
        reason: warmUpDecision.reason,
        health,
        warmUp: warmUpDecision.status,
      };
    }

    const trackingKey = this.variator.getTrackingKey(content);
    const seenCount = trackingKey ? (this.repeatedMessages.get(trackingKey) ?? 0) : 0;
    const variedContent = this.variator.vary(content, seenCount);
    const rateLimitDecision = this.rateLimiter.getDelay(recipientId, variedContent);

    if (!rateLimitDecision.allowed) {
      return {
        allowed: false,
        delayMs: 0,
        preSendDelayMs: 0,
        typingDelayMs: 0,
        riskLevel: health.risk,
        content: variedContent,
        reason: rateLimitDecision.reason,
        trackingKey: trackingKey ?? undefined,
        health,
        warmUp: warmUpDecision.status,
      };
    }

    const preSendDelayMs = this.applyRiskMultiplier(
      rateLimitDecision.preSendDelayMs,
      health.risk,
    );
    const typingDelayMs = rateLimitDecision.typingDelayMs;

    return {
      allowed: true,
      delayMs: preSendDelayMs + typingDelayMs,
      preSendDelayMs,
      typingDelayMs,
      riskLevel: health.risk,
      content: variedContent,
      trackingKey: trackingKey ?? undefined,
      health,
      warmUp: warmUpDecision.status,
    };
  }

  public async afterSend(
    recipientId: string,
    content: MessageContent,
    trackingKey?: string,
  ): Promise<void> {
    await this.initialize();
    this.rateLimiter.record(recipientId, content);
    this.warmUp.recordSend();

    if (trackingKey) {
      this.repeatedMessages.set(trackingKey, (this.repeatedMessages.get(trackingKey) ?? 0) + 1);
    }

    await this.persistWarmUpState();
  }

  public afterSendFailed(error: unknown): void {
    console.warn(
      '[ANTIBAN] Send failure recorded:',
      error instanceof Error ? error.message : error,
    );
    this.healthMonitor.recordMessageFailed(
      error instanceof Error ? error.message : String(error),
    );
  }

  public onDisconnect(statusCode: number | string | undefined): void {
    this.healthMonitor.recordDisconnect(statusCode ?? 'unknown');
  }

  public onReconnect(): void {
    this.healthMonitor.recordReconnect();
  }

  public getStats(): {
    health: HealthStatus;
    warmUp: WarmUpStatus;
    rateLimiter: ReturnType<RateLimiter['getStats']>;
  } {
    return {
      health: this.healthMonitor.getStatus(),
      warmUp: this.warmUp.getStatus(),
      rateLimiter: this.rateLimiter.getStats(),
    };
  }

  private applyRiskMultiplier(delayMs: number, riskLevel: BanRiskLevel): number {
    if (riskLevel === 'medium') {
      return Math.round(delayMs * 1.5);
    } else if (riskLevel === 'high') {
      return Math.round(delayMs * 2.25);
    } else if (riskLevel === 'critical') {
      return Math.round(delayMs * 3);
    }

    return Math.round(delayMs);
  }

  private async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const state = await this.warmUpRepository.load(this.session).catch(error => {
          console.warn(
            `[ANTIBAN] Failed to load warm-up state for ${this.session.toLogLabel()}:`,
            error,
          );
          return null;
        });

        this.warmUp.hydrate(state);
      })();
    }

    await this.initPromise;
  }

  private async persistWarmUpState(): Promise<void> {
    await this.warmUpRepository.save(this.session, this.warmUp.exportState()).catch(error => {
      console.warn(
        `[ANTIBAN] Failed to persist warm-up state for ${this.session.toLogLabel()}:`,
        error,
      );
    });
  }
}
