import { Redis } from 'ioredis';
import { env } from '../../application/config/env.js';
import { AntiBanWarmUpState } from '../../domain/entities/AntiBanWarmUpState.js';
import { SessionDescriptor } from '../../domain/entities/SessionDescriptor.js';
import { IAntiBanWarmUpStateRepository } from '../../domain/repositories/IAntiBanWarmUpStateRepository.js';
import { RedisKeyBuilder } from './RedisKeyBuilder.js';

export class RedisAntiBanWarmUpStateRepository implements IAntiBanWarmUpStateRepository {
  constructor(private readonly redis: Redis) {}

  public async load(session: SessionDescriptor): Promise<AntiBanWarmUpState | null> {
    const raw = await this.redis.get(this.getKey(session));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as AntiBanWarmUpState;
    } catch (error) {
      console.warn(
        `[ANTIBAN] Failed to parse warm-up state for ${session.toLogLabel()}:`,
        error,
      );
      return null;
    }
  }

  public async save(session: SessionDescriptor, state: AntiBanWarmUpState): Promise<void> {
    await this.redis.setex(
      this.getKey(session),
      env.ANTI_BAN_WARMUP_STATE_TTL_SECONDS,
      JSON.stringify(state),
    );
  }

  private getKey(session: SessionDescriptor): string {
    return RedisKeyBuilder.getAntiBanWarmUpKey(session);
  }
}
