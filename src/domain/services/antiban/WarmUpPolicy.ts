import { AntiBanWarmUpState } from '../../entities/AntiBanWarmUpState.js';

export interface WarmUpPolicyConfig {
  enabled: boolean;
  warmUpDays: number;
  day1Limit: number;
  growthFactor: number;
  inactivityThresholdHours: number;
  missingStateMode: 'graduated' | 'warming';
}

export interface WarmUpStatus {
  enabled: boolean;
  phase: 'warming' | 'graduated';
  day: number;
  totalDays: number;
  todayLimit: number;
  todaySent: number;
  progress: number;
}

export interface WarmUpDecision {
  allowed: boolean;
  reason?: string;
  stateChanged: boolean;
  status: WarmUpStatus;
}

export class WarmUpPolicy {
  private state!: AntiBanWarmUpState;
  private hydrated = false;

  constructor(private readonly config: WarmUpPolicyConfig) {}

  public hydrate(state: AntiBanWarmUpState | null): void {
    if (state) {
      this.state = state;
    } else {
      this.state = this.createInitialState();
    }

    this.hydrated = true;
  }

  public beforeSend(): WarmUpDecision {
    this.ensureHydrated();

    if (!this.config.enabled) {
      return {
        allowed: true,
        stateChanged: false,
        status: this.getStatus(),
      };
    }

    const stateChanged = this.checkInactivity();
    if (this.state.graduated) {
      return {
        allowed: true,
        stateChanged,
        status: this.getStatus(),
      };
    }

    const day = this.getCurrentDay();
    const todayCount = this.state.dailyCounts[day] ?? 0;
    const todayLimit = this.getDailyLimit();

    if (todayCount >= todayLimit) {
      return {
        allowed: false,
        reason: `warm-up limit reached (${todayCount}/${todayLimit} on day ${day + 1})`,
        stateChanged,
        status: this.getStatus(),
      };
    }

    return {
      allowed: true,
      stateChanged,
      status: this.getStatus(),
    };
  }

  public recordSend(): boolean {
    this.ensureHydrated();

    if (!this.config.enabled) {
      return false;
    }

    const day = this.getCurrentDay();
    while (this.state.dailyCounts.length <= day) {
      this.state.dailyCounts.push(0);
    }

    this.state.dailyCounts[day]++;
    this.state.lastActiveAt = Date.now();

    if (day >= this.config.warmUpDays) {
      this.state.graduated = true;
    }

    return true;
  }

  public getStatus(): WarmUpStatus {
    this.ensureHydrated();

    if (!this.config.enabled) {
      return {
        enabled: false,
        phase: 'graduated',
        day: 0,
        totalDays: this.config.warmUpDays,
        todayLimit: -1,
        todaySent: 0,
        progress: 100,
      };
    }

    const day = this.getCurrentDay();
    const todaySent = this.state.dailyCounts[day] ?? 0;
    const todayLimit = this.getDailyLimit();

    return {
      enabled: true,
      phase: this.state.graduated ? 'graduated' : 'warming',
      day: Math.min(day + 1, this.config.warmUpDays),
      totalDays: this.config.warmUpDays,
      todayLimit: todayLimit === Infinity ? -1 : todayLimit,
      todaySent,
      progress: this.state.graduated
        ? 100
        : Math.min(
            99,
            Math.round(((Math.min(day, this.config.warmUpDays - 1) + 1) / this.config.warmUpDays) * 100),
          ),
    };
  }

  public exportState(): AntiBanWarmUpState {
    this.ensureHydrated();
    return {
      ...this.state,
      dailyCounts: [...this.state.dailyCounts],
    };
  }

  private getDailyLimit(): number {
    if (!this.config.enabled || this.state.graduated) {
      return Infinity;
    }

    const day = this.getCurrentDay();
    if (day >= this.config.warmUpDays) {
      this.state.graduated = true;
      return Infinity;
    }

    return Math.round(this.config.day1Limit * Math.pow(this.config.growthFactor, day));
  }

  private getCurrentDay(): number {
    return Math.floor((Date.now() - this.state.startedAt) / 86_400_000);
  }

  private checkInactivity(): boolean {
    const hoursSinceLastActive = (Date.now() - this.state.lastActiveAt) / 3_600_000;
    if (hoursSinceLastActive <= this.config.inactivityThresholdHours) {
      return false;
    }

    this.state = this.createInitialState();
    return true;
  }

  private createInitialState(): AntiBanWarmUpState {
    const now = Date.now();
    return {
      startedAt: now,
      lastActiveAt: now,
      dailyCounts: [],
      graduated: this.config.missingStateMode === 'graduated' || !this.config.enabled,
    };
  }

  private ensureHydrated(): void {
    if (!this.hydrated) {
      throw new Error('WarmUpPolicy must be hydrated before use.');
    }
  }
}
