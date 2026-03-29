import { env } from '../../application/config/env.js';
import { renderConfigTemplate } from '../../application/config/renderConfigTemplate.js';
import { SessionAddress } from '../../shared/contracts/gateway.js';

export class RedisKeyBuilder {
  public static getSessionLockKey(session: SessionAddress): string {
    return renderConfigTemplate(env.REDIS_KEY_SESSION_LOCK_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  public static getSessionWorkerRegistryKey(session: SessionAddress): string {
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
    workspaceId: number,
    sessionId: string,
    type: string,
    id: string,
  ): string {
    return renderConfigTemplate(env.REDIS_KEY_AUTH_RECORD_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId,
      sessionId,
      type,
      id,
    });
  }

  public static getAuthRecordKeyPrefix(
    workspaceId: number,
    sessionId: string,
    type: string,
  ): string {
    return this.getAuthRecordKey(workspaceId, sessionId, type, '');
  }

  public static getAuthSessionPattern(workspaceId: number, sessionId: string): string {
    return renderConfigTemplate(env.REDIS_KEY_AUTH_SESSION_PATTERN_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId,
      sessionId,
    });
  }

  public static getLidMappingKey(workspaceId: number, jid: string): string {
    return renderConfigTemplate(env.REDIS_KEY_LID_MAPPING_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      workspaceId,
      jid,
    });
  }

  public static getAntiBanWarmUpKey(session: SessionAddress): string {
    return renderConfigTemplate(env.REDIS_KEY_ANTI_BAN_WARMUP_TEMPLATE, {
      prefix: env.REDIS_KEY_PREFIX,
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }
}
