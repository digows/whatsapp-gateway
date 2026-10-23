export interface PacingPolicy
{
  readonly minimumDelayMs: number;
  readonly maximumDelayMs: number;
  readonly dailyMaximum: number;
  readonly sendRateLimit: number;
  readonly sendRatePeriodMs: number;
  readonly firstDayLimit: number;
  readonly growthFactor: number;
  readonly warmUpDays: number;
  readonly inactivityMs: number;
}
export interface PacingRecord
{
  readonly nextSendAt: number;
  readonly startedAt: number;
  readonly lastActiveAt: number;
  readonly dailyDate: string;
  readonly dailyCount: number;
  readonly recentTimes: readonly number[];
}
export class AccountPacing
{
  constructor(private readonly record: PacingRecord, private readonly policy: PacingPolicy)
  {}
  reserve(now: number, random = Math.random()): PacingRecord
  {
    const fresh = now - this.record.lastActiveAt >= this.policy.inactivityMs;
    const startedAt = fresh ? now : this.record.startedAt;
    const day = Math.floor(Math.max(0, now - startedAt) / 86400000);
    const limit = day >= this.policy.warmUpDays
      ? this.policy.dailyMaximum
      : Math.min(
        this.policy.dailyMaximum,
        Math.floor(this.policy.firstDayLimit * this.policy.growthFactor ** day),
      );
    const date = new Date(now).toISOString().slice(0, 10);
    const count = this.record.dailyDate === date ? this.record.dailyCount : 0;
    if (count >= limit) throw new Error("Daily send limit reached");
    let scheduled = Math.max(now, this.record.nextSendAt);
    let recent = this.record.recentTimes.filter(time => time > scheduled - this.policy.sendRatePeriodMs);
    if (recent.length >= this.policy.sendRateLimit)
    {
      scheduled = Math.max(
        scheduled,
        recent[recent.length - this.policy.sendRateLimit]! + this.policy.sendRatePeriodMs,
      );
      recent = recent.filter(time => time > scheduled - this.policy.sendRatePeriodMs);
    }
    return {
      nextSendAt: scheduled + this.policy.minimumDelayMs
        + random * (this.policy.maximumDelayMs - this.policy.minimumDelayMs),
      startedAt,
      lastActiveAt: now,
      dailyDate: date,
      dailyCount: count + 1,
      recentTimes: [...recent, scheduled],
    };
  }
}
