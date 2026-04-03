export type BanRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface HealthStatus {
  risk: BanRiskLevel;
  score: number;
  reasons: string[];
  recommendation: string;
  stats: {
    disconnectsLastHour: number;
    failedMessagesLastHour: number;
    forbiddenErrors: number;
    uptimeMs: number;
    lastDisconnectReason?: string;
  };
}

export interface HealthMonitorConfig {
  disconnectWarningThreshold: number;
  disconnectCriticalThreshold: number;
  failedMessageThreshold: number;
  autoPauseAt: BanRiskLevel;
  onRiskChange?: (status: HealthStatus) => void;
}

interface HealthEvent {
  type: 'disconnect' | 'forbidden' | 'loggedOut' | 'messageFailed' | 'reconnect';
  timestamp: number;
  detail?: string;
}

export class HealthMonitor {
  private readonly events: HealthEvent[] = [];
  private readonly startedAt = Date.now();
  private paused = false;
  private lastRisk: BanRiskLevel = 'low';

  constructor(private readonly config: HealthMonitorConfig) {}

  public recordDisconnect(reason: string | number): void {
    const reasonText = String(reason);

    if (reasonText === '403' || reasonText.toLowerCase() === 'forbidden') {
      this.events.push({ type: 'forbidden', timestamp: Date.now(), detail: reasonText });
    } else if (reasonText === '401' || reasonText.toLowerCase() === 'loggedout') {
      this.events.push({ type: 'loggedOut', timestamp: Date.now(), detail: reasonText });
    } else {
      this.events.push({ type: 'disconnect', timestamp: Date.now(), detail: reasonText });
    }

    this.notifyIfChanged();
  }

  public recordReconnect(): void {
    this.events.push({ type: 'reconnect', timestamp: Date.now() });
    this.notifyIfChanged();
  }

  public recordMessageFailed(error?: string): void {
    this.events.push({ type: 'messageFailed', timestamp: Date.now(), detail: error });
    this.notifyIfChanged();
  }

  public getStatus(): HealthStatus {
    const now = Date.now();
    this.cleanup(now);

    const lastHour = this.events.filter(event => now - event.timestamp < 3_600_000);
    const disconnects = lastHour.filter(event => event.type === 'disconnect').length;
    const forbidden = lastHour.filter(event => event.type === 'forbidden').length;
    const loggedOut = lastHour.filter(event => event.type === 'loggedOut').length;
    const failedMessages = lastHour.filter(event => event.type === 'messageFailed').length;

    let score = 0;
    const reasons: string[] = [];

    if (forbidden > 0) {
      score += 40 * forbidden;
      reasons.push(`${forbidden} forbidden disconnects in the last hour`);
    }

    if (loggedOut > 0) {
      score += 60;
      reasons.push('logged out by WhatsApp');
    }

    if (disconnects >= this.config.disconnectCriticalThreshold) {
      score += 30;
      reasons.push(`${disconnects} disconnects in the last hour`);
    } else if (disconnects >= this.config.disconnectWarningThreshold) {
      score += 15;
      reasons.push(`${disconnects} disconnects in the last hour`);
    }

    if (failedMessages >= this.config.failedMessageThreshold) {
      score += 20;
      reasons.push(`${failedMessages} failed sends in the last hour`);
    }

    score = Math.min(100, score);
    const risk = this.toRisk(score);
    const lastDisconnect = [...this.events]
      .reverse()
      .find(event => event.type === 'disconnect' || event.type === 'forbidden' || event.type === 'loggedOut');

    return {
      risk,
      score,
      reasons: reasons.length > 0 ? reasons : ['no warning signs detected'],
      recommendation: this.getRecommendation(risk),
      stats: {
        disconnectsLastHour: disconnects,
        failedMessagesLastHour: failedMessages,
        forbiddenErrors: forbidden,
        uptimeMs: now - this.startedAt,
        lastDisconnectReason: lastDisconnect?.detail,
      },
    };
  }

  public isPaused(): boolean {
    if (this.paused) {
      return true;
    }

    const status = this.getStatus();
    const order: BanRiskLevel[] = ['low', 'medium', 'high', 'critical'];
    return order.indexOf(status.risk) >= order.indexOf(this.config.autoPauseAt);
  }

  public getAutoPauseThreshold(): BanRiskLevel {
    return this.config.autoPauseAt;
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
  }

  private toRisk(score: number): BanRiskLevel {
    if (score >= 85) {
      return 'critical';
    }

    if (score >= 60) {
      return 'high';
    }

    if (score >= 30) {
      return 'medium';
    }

    return 'low';
  }

  private getRecommendation(risk: BanRiskLevel): string {
    switch (risk) {
      case 'critical':
        return 'stop sending immediately and let the session cool down';
      case 'high':
        return 'reduce traffic sharply and consider pausing sends for a while';
      case 'medium':
        return 'slow down and increase delay between sends';
      default:
        return 'operate normally and keep monitoring';
    }
  }

  private cleanup(now: number): void {
    while (this.events.length > 0 && now - this.events[0].timestamp > 21_600_000) {
      this.events.shift();
    }
  }

  private notifyIfChanged(): void {
    const status = this.getStatus();
    if (status.risk !== this.lastRisk) {
      this.lastRisk = status.risk;
      this.config.onRiskChange?.(status);
    }
  }
}
