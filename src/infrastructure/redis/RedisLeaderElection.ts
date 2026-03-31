import crypto from 'crypto';
import { env } from '../../application/config/env.js';
import { RedisConnection } from './RedisConnection.js';
import { RedisKeyBuilder } from './RedisKeyBuilder.js';

/**
 * Redis-backed single-leader election for the embedded control plane.
 * Only one pod per provider should reconcile durable Session entities at a time.
 */
export class RedisLeaderElection {
  private readonly leadershipToken: string;
  private readonly leaderKey: string;
  private isLeader = false;

  constructor(
    private readonly providerId: string,
    private readonly participantId: string,
  ) {
    this.leadershipToken = `${participantId}:${crypto.randomUUID()}`;
    this.leaderKey = RedisKeyBuilder.getControlPlaneLeaderKey(providerId);
  }

  public async tryAcquireOrRenewLeadership(): Promise<boolean> {
    const redis = RedisConnection.getCoordinationClient();

    if (this.isLeader) {
      const currentToken = await redis.get(this.leaderKey);
      if (currentToken !== this.leadershipToken) {
        this.isLeader = false;
        return false;
      }

      await redis.pexpire(this.leaderKey, env.CONTROL_PLANE_LEADER_TTL_MS);
      return true;
    }

    const acquired = await redis.set(
      this.leaderKey,
      this.leadershipToken,
      'PX',
      env.CONTROL_PLANE_LEADER_TTL_MS,
      'NX',
    );

    this.isLeader = acquired === 'OK';
    return this.isLeader;
  }

  public currentlyLeads(): boolean {
    return this.isLeader;
  }

  public async stop(): Promise<void> {
    if (!this.isLeader) {
      return;
    }

    const redis = RedisConnection.getCoordinationClient();
    const releaseScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `;

    try {
      await redis.eval(releaseScript, 1, this.leaderKey, this.leadershipToken);
    } finally {
      this.isLeader = false;
    }
  }
}
