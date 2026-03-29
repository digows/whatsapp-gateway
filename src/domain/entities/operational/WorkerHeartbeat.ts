import { WorkerIdentity } from './WorkerIdentity.js';

/**
 * Snapshot of the worker state shared with the control plane.
 */
export class WorkerHeartbeat {
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

}
