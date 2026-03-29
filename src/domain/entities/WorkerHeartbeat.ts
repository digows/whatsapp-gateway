import {
  ProviderId,
  WorkerHeartbeatContract,
} from '../../shared/contracts/gateway.js';
import { WorkerIdentity } from './WorkerIdentity.js';

/**
 * Snapshot of the worker state shared with the Control Plane.
 */
export class WorkerHeartbeat {
  public static capture(
    provider: ProviderId,
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

  private constructor(
    public readonly provider: ProviderId,
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

  public toContract(): WorkerHeartbeatContract {
    return {
      provider: this.provider,
      workerId: this.workerId,
      currentSessions: this.currentSessions,
      maxCapacity: this.maxCapacity,
      cpuUsageMicros: this.cpuUsageMicros,
      memoryUsageMb: this.memoryUsageMb,
      lastPulse: this.lastPulse,
    };
  }
}
