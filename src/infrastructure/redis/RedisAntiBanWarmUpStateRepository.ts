import { Redis } from 'ioredis';
import { WarmUpStateRepository } from '../../application/ports/WarmUpStateRepository.js';
import { env } from '../../application/config/env.js';
import { AntiBanWarmUpState } from '../../domain/entities/antiban/AntiBanWarmUpState.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { RedisKeyBuilder } from './RedisKeyBuilder.js';

export class RedisAntiBanWarmUpStateRepository implements WarmUpStateRepository {
  constructor(private readonly redis: Redis) {}

  public async load(session: SessionReference): Promise<AntiBanWarmUpState | null> {
    const raw = await this.redis.get(RedisKeyBuilder.getAntiBanWarmUpKey(session));
    if (!raw) {
      return null;
    }

    try {
      const payload = JSON.parse(raw) as {
        startedAt: number;
        lastActiveAt: number;
        dailyCounts: number[];
        graduated: boolean;
      };

      return new AntiBanWarmUpState(
        payload.startedAt,
        payload.lastActiveAt,
        Array.isArray(payload.dailyCounts) ? payload.dailyCounts : [],
        Boolean(payload.graduated),
      );
    } catch (error) {
      console.warn(
        `[ANTIBAN] Failed to parse warm-up state for ${session.toLogLabel()}:`,
        error,
      );
      return null;
    }
  }

  public async save(session: SessionReference, state: AntiBanWarmUpState): Promise<void> {
    await this.redis.setex(
      RedisKeyBuilder.getAntiBanWarmUpKey(session),
      env.ANTI_BAN_WARMUP_STATE_TTL_SECONDS,
      JSON.stringify({
        startedAt: state.startedAt,
        lastActiveAt: state.lastActiveAt,
        dailyCounts: state.dailyCounts,
        graduated: state.graduated,
      }),
    );
  }
}
