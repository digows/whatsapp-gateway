import { env } from '../../application/config/env.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { WorkerIdentity } from '../../domain/entities/operational/WorkerIdentity.js';
import { RedisConnection } from './RedisConnection.js';
import { RedisKeyBuilder } from './RedisKeyBuilder.js';
import Redlock from 'redlock';

export interface SessionLease {
  session: SessionReference;
  release(): Promise<void>;
  extend(ms: number): Promise<void>;
}

/**
 * Redis-backed lease coordinator that guarantees one live worker per WhatsApp session.
 */
export class RedisSessionCoordinator {
  private readonly redis = RedisConnection.getCoordinationClient();
  private readonly redlock: Redlock;

  constructor(private readonly workerIdentity: WorkerIdentity) {
    this.redlock = new Redlock([this.redis], {
      driftFactor: 0.01,
      retryCount: 3,
      retryDelay: 500,
      retryJitter: 200,
      automaticExtensionThreshold: 500,
    });
  }

  public async acquireSessionLock(
    session: SessionReference,
    ttlMs: number,
  ): Promise<SessionLease> {
    if (env.DISABLE_REDLOCK) {
      console.log(
        `[COORD] Redlock disabled. Using in-memory ownership for ${session.toLogLabel()}.`,
      );
      await this.registerWorkerAssignment(session);
      return {
        session,
        release: async () => {
          await this.unregisterWorkerAssignment(session);
        },
        extend: async () => {},
      };
    }

    const lockKey = RedisKeyBuilder.getSessionLockKey(session);
    await this.clearOrphanedAssignment(session, lockKey);

    try {
      let currentLock = await this.redlock.acquire([lockKey], ttlMs);
      console.log(
        `[COORD][${this.workerIdentity.id}] Lock acquired for ${session.toLogLabel()}.`,
      );
      await this.registerWorkerAssignment(session);

      return {
        session,
        release: async () => {
          try {
            console.log(
              `[COORD][${this.workerIdentity.id}] Releasing lock for ${session.toLogLabel()}...`,
            );
            await currentLock.release();
          } catch (error: any) {
            console.warn(
              `[COORD][${this.workerIdentity.id}] Error during release: ${error?.message || error}`,
            );
          }

          await this.unregisterWorkerAssignment(session);
        },
        extend: async (ms: number) => {
          currentLock = await currentLock.extend(ms);
          console.log(
            `[COORD][${this.workerIdentity.id}] Lock extended for ${session.toLogLabel()} (+${ms}ms). Next expiry: ${new Date(currentLock.expiration).toISOString()}`,
          );
        },
      };
    } catch (error) {
      const diagnosis = await this.inspectLockFailure(session, lockKey);
      console.error(
        `[COORD] Failed to acquire lock for ${session.toLogLabel()}${diagnosis ? ` (${diagnosis})` : ''}:`,
        error,
      );
      throw error;
    }
  }

  public async getAssignedWorker(session: SessionReference): Promise<string | null> {
    return this.redis.hget(
      RedisKeyBuilder.getSessionWorkerRegistryKey(session),
      session.sessionId,
    );
  }

  private async clearOrphanedAssignment(
    session: SessionReference,
    lockKey: string,
  ): Promise<void> {
    const assignedWorker = await this.getAssignedWorker(session);
    if (!assignedWorker) {
      return;
    }

    const [lockExists, workerAlive] = await Promise.all([
      this.redis.exists(lockKey),
      this.isWorkerAlive(assignedWorker),
    ]);

    if (lockExists || workerAlive) {
      return;
    }

    await this.redis.hdel(
      RedisKeyBuilder.getSessionWorkerRegistryKey(session),
      session.sessionId,
    );
    console.warn(
      `[COORD] Cleared orphaned ownership of ${session.toLogLabel()} previously assigned to dead worker ${assignedWorker}.`,
    );
  }

  private async inspectLockFailure(
    session: SessionReference,
    lockKey: string,
  ): Promise<string> {
    try {
      const [assignedWorker, lockTtlMs] = await Promise.all([
        this.getAssignedWorker(session),
        this.redis.pttl(lockKey),
      ]);

      if (!assignedWorker) {
        return lockTtlMs > 0
          ? `lock key still alive for ~${lockTtlMs}ms with no registry owner`
          : 'no registry owner found';
      }

      const workerAlive = await this.isWorkerAlive(assignedWorker);
      return `assignedWorker=${assignedWorker}, workerAlive=${workerAlive}, lockTtlMs=${lockTtlMs}`;
    } catch (error) {
      return `lock diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async isWorkerAlive(workerId: string): Promise<boolean> {
    const exists = await this.redis.exists(RedisKeyBuilder.getClusterAliveKey(workerId));
    return exists === 1;
  }

  private async registerWorkerAssignment(session: SessionReference): Promise<void> {
    await this.redis.hset(
      RedisKeyBuilder.getSessionWorkerRegistryKey(session),
      session.sessionId,
      this.workerIdentity.id,
    );
    console.log(
      `[COORD] Worker ${this.workerIdentity.id} took ownership of ${session.toLogLabel()}.`,
    );
  }

  private async unregisterWorkerAssignment(session: SessionReference): Promise<void> {
    await this.redis.hdel(
      RedisKeyBuilder.getSessionWorkerRegistryKey(session),
      session.sessionId,
    );
    console.log(
      `[COORD] Worker ${this.workerIdentity.id} released ${session.toLogLabel()}.`,
    );
  }
}
