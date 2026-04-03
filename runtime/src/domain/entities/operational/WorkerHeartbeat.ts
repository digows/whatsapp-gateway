import { WorkerIdentity } from './WorkerIdentity.js';

/**
 * Snapshot of the worker state shared with the control plane.
 */
export class WorkerHeartbeat {
  public static fromRegistryPayload(payload: unknown): WorkerHeartbeat {
    if (!this.isRecord(payload)) {
      throw new Error('Worker heartbeat payload must be an object.');
    }

    return new WorkerHeartbeat(
      this.readRequiredString(payload, 'provider'),
      this.readRequiredString(payload, 'worker_id'),
      this.readRequiredNumber(payload, 'current_sessions'),
      this.readRequiredNumber(payload, 'max_capacity'),
      this.readRequiredNumber(payload, 'cpu_usage'),
      this.readRequiredNumber(payload, 'memory_usage_mb'),
      this.readRequiredNumber(payload, 'last_pulse'),
    );
  }

  public static capture(
    provider: string,
    workerIdentity: WorkerIdentity,
    currentSessions: number,
    maxCapacity: number,
  ): WorkerHeartbeat {
    return new WorkerHeartbeat(
      provider,
      workerIdentity.id,
      currentSessions,
      maxCapacity,
      process.cpuUsage().user,
      Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)),
      Date.now(),
    );
  }

  constructor(
    public readonly provider: string,
    public readonly workerId: string,
    public readonly currentSessions: number,
    public readonly maxCapacity: number,
    public readonly cpuUsageMicros: number,
    public readonly memoryUsageMb: number,
    public readonly lastPulse: number,
  ) {}

  public toRegistryPayload(): Record<string, string | number> {
    return {
      provider: this.provider,
      worker_id: this.workerId,
      current_sessions: this.currentSessions,
      max_capacity: this.maxCapacity,
      cpu_usage: this.cpuUsageMicros,
      memory_usage_mb: this.memoryUsageMb,
      memory_usage: `${this.memoryUsageMb.toFixed(2)} MB`,
      last_pulse: this.lastPulse,
    };
  }

  private static readRequiredString(
    payload: Record<string, unknown>,
    fieldName: string,
  ): string {
    const value = payload[fieldName];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Worker heartbeat field "${fieldName}" must be a non-empty string.`);
    }

    return value;
  }

  private static readRequiredNumber(
    payload: Record<string, unknown>,
    fieldName: string,
  ): number {
    const value = payload[fieldName];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    throw new Error(`Worker heartbeat field "${fieldName}" must be a finite number.`);
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
