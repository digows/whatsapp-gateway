import { env } from '../../application/config/env.js';
import { ChannelProviderId } from '@jarvix/ts-channel-provider';
import { WorkerHeartbeat } from '../../domain/entities/WorkerHeartbeat.js';
import { WorkerIdentity } from '../../domain/entities/WorkerIdentity.js';
import { RedisConnection } from './RedisConnection.js';

/**
 * Redis adapter for the worker heartbeat registry consumed by the Control Plane.
 */
export class RedisWorkerHealthReporter {
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly providerId: ChannelProviderId,
    private readonly workerIdentity: WorkerIdentity,
    private readonly getCurrentSessions: () => number,
  ) {}

  public async start(): Promise<void> {
    if (this.heartbeatTimer) {
      return;
    }

    console.log(`[HEALTH] Starting health reporter for ${this.workerIdentity.id}`);
    await this.publishHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      void this.publishHeartbeat();
    }, 5000);
  }

  public async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    const redis = RedisConnection.getCoordinationClient();
    try {
      await redis.del(`wa:cluster:alive:${this.workerIdentity.id}`);
      await redis.hdel('wa:cluster:health', this.workerIdentity.id);
    } catch (error) {
      console.warn(`[HEALTH] Failed to clear health presence for ${this.workerIdentity.id}:`, error);
    }
  }

  private async publishHeartbeat(): Promise<void> {
    const redis = RedisConnection.getCoordinationClient();

    try {
      const heartbeat = WorkerHeartbeat.capture(
        this.providerId,
        this.workerIdentity,
        this.getCurrentSessions(),
        env.MAX_CONCURRENT_SESSIONS,
      );

      await redis.hset(
        'wa:cluster:health',
        this.workerIdentity.id,
        JSON.stringify(heartbeat.toRegistryPayload()),
      );
      await redis.set(`wa:cluster:alive:${this.workerIdentity.id}`, '1', 'EX', 15);
    } catch (error) {
      console.error('[HEALTH] Failed to send heartbeat:', error);
    }
  }
}
