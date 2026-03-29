import { Redis } from 'ioredis';
import { env } from '../../application/config/env.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { RedisKeyBuilder } from './RedisKeyBuilder.js';

export enum CommandKind {
  Worker = 'worker',
  Outbound = 'outbound',
  Activation = 'activation',
}

export enum CommandClaimStatus {
  Ready = 'ready',
  Duplicate = 'duplicate',
  InProgress = 'in_progress',
}

/**
 * Redis-backed command dedupe guard.
 * Commands are first claimed as processing and only promoted to completed after
 * the handler succeeds, so transient failures remain retryable.
 */
export class RedisCommandDeduplicator {
  constructor(private readonly redis: Redis) {}

  public async begin(
    session: SessionReference,
    kind: CommandKind,
    identifier: string,
  ): Promise<CommandClaimStatus> {
    const completedKey = RedisKeyBuilder.getCommandCompletedKey(session, kind, identifier);
    const processingKey = RedisKeyBuilder.getCommandProcessingKey(session, kind, identifier);

    if (await this.redis.exists(completedKey)) {
      return CommandClaimStatus.Duplicate;
    }

    const processingClaim = await this.redis.set(
      processingKey,
      '1',
      'EX',
      env.REDIS_COMMAND_PROCESSING_TTL_SECONDS,
      'NX',
    );

    return processingClaim === 'OK'
      ? CommandClaimStatus.Ready
      : CommandClaimStatus.InProgress;
  }

  public async complete(
    session: SessionReference,
    kind: CommandKind,
    identifier: string,
  ): Promise<void> {
    const completedKey = RedisKeyBuilder.getCommandCompletedKey(session, kind, identifier);
    const processingKey = RedisKeyBuilder.getCommandProcessingKey(session, kind, identifier);

    await this.redis.multi()
      .del(processingKey)
      .set(completedKey, '1', 'EX', env.REDIS_COMMAND_COMPLETED_TTL_SECONDS)
      .exec();
  }

  public async abandon(
    session: SessionReference,
    kind: CommandKind,
    identifier: string,
  ): Promise<void> {
    await this.redis.del(
      RedisKeyBuilder.getCommandProcessingKey(session, kind, identifier),
    );
  }
}
