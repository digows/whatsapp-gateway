import { env } from '../../application/config/env.js';
import { renderConfigTemplate } from '../../application/config/renderConfigTemplate.js';
import { AuthStateKey } from '../../domain/entities/auth/AuthStateKey.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';

export class RedisKeyBuilder {
  public static getSessionLockKey(session: SessionReference): string {
    return renderConfigTemplate(env.REDIS_KEY_SESSION_LOCK_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  public static getSessionWorkerRegistryKey(session: SessionReference): string {
    return renderConfigTemplate(env.REDIS_KEY_SESSION_WORKER_REGISTRY_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId: session.workspaceId,
    });
  }

  public static getClusterAliveKey(workerId: string): string {
    return renderConfigTemplate(env.REDIS_KEY_CLUSTER_ALIVE_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workerId,
    });
  }

  public static getClusterHealthKey(): string {
    return renderConfigTemplate(env.REDIS_KEY_CLUSTER_HEALTH_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
    });
  }

  public static getAuthRecordKey(
    session: SessionReference,
    key: AuthStateKey,
  ): string {
    return renderConfigTemplate(env.REDIS_KEY_AUTH_RECORD_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      type: key.type,
      id: key.id,
    });
  }

  public static getAuthRecordKeyPrefix(
    session: SessionReference,
    keyType: string,
  ): string {
    return renderConfigTemplate(env.REDIS_KEY_AUTH_RECORD_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      type: keyType,
      id: '',
    });
  }

  public static getAuthSessionPattern(session: SessionReference): string {
    return renderConfigTemplate(env.REDIS_KEY_AUTH_SESSION_PATTERN_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  public static getLidMappingKey(session: SessionReference, jid: string): string {
    return renderConfigTemplate(env.REDIS_KEY_LID_MAPPING_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId: session.workspaceId,
      jid,
    });
  }

  public static getAntiBanWarmUpKey(session: SessionReference): string {
    return renderConfigTemplate(env.REDIS_KEY_ANTI_BAN_WARMUP_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }
}
