import { WorkerHeartbeat } from '../../domain/entities/operational/WorkerHeartbeat.js';
import { RedisConnection } from './RedisConnection.js';
import { RedisKeyBuilder } from './RedisKeyBuilder.js';

/**
 * Read-only view of worker liveness and capacity for the embedded control plane.
 */
export class RedisWorkerRegistryReader {
  public async listHealthyWorkers(providerId: string): Promise<readonly WorkerHeartbeat[]> {
    const redis = RedisConnection.getCoordinationClient();
    const registry = await redis.hgetall(RedisKeyBuilder.getClusterHealthKey());
    const healthyWorkers: WorkerHeartbeat[] = [];

    for (const [workerId, rawPayload] of Object.entries(registry)) {
      try {
        const parsedPayload = JSON.parse(rawPayload) as unknown;
        const heartbeat = WorkerHeartbeat.fromRegistryPayload(parsedPayload);

        if (heartbeat.provider !== providerId) {
          continue;
        }

        const alive = await redis.exists(RedisKeyBuilder.getClusterAliveKey(workerId));
        if (alive !== 1) {
          continue;
        }

        healthyWorkers.push(heartbeat);
      } catch (error) {
        console.warn(
          `[HEALTH] Failed to parse worker heartbeat for ${workerId}. Skipping registry entry.`,
          error,
        );
      }
    }

    return healthyWorkers;
  }
}
