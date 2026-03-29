import {
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  SignalDataSet,
  proto,
} from 'baileys';
import { Redis } from 'ioredis';
import { ISignalKeyRepository } from '../../domain/repositories/ISignalKeyRepository.js';

const JSON_PARSE_FAILED = Symbol('json-parse-failed');

/**
 * Maps Baileys auth state to our PostgreSQL + Redis persistence model.
 */
export class BaileysAuthStateStore {
  private readonly cacheTtlSeconds = 3600;
  private readonly binaryKeyTypes = new Set(['sender-key', 'identity-key']);

  constructor(
    private readonly workspaceId: number,
    private readonly sessionId: string,
    private readonly repository: ISignalKeyRepository,
    private readonly redis: Redis,
  ) {}

  public async getAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    let creds: any;
    const credKeys = await this.repository.getKeys(
      this.workspaceId,
      this.sessionId,
      'creds',
      ['default'],
    );

    if (credKeys.length > 0) {
      creds = this.deserializeStoredValue('creds', credKeys[0].serializedData);
    } else {
      console.log(
        `[AUTH] No persistent credentials found for session ${this.sessionId}. Initializing new state.`,
      );
      creds = initAuthCreds();
    }

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const result: SignalDataSet = {};
            const cacheKeyPrefix = `wa:${this.workspaceId}:auth:${this.sessionId}:${type}:`;

            const cachedValues = await this.redis.mget(
              ...ids.map(id => `${cacheKeyPrefix}${id}`),
            );

            const missingIds: string[] = [];
            for (let index = 0; index < ids.length; index++) {
              const id = ids[index];
              const cached = cachedValues[index];
              if (cached) {
                (result as any)[id] = this.deserializeStoredValue(type, cached);
              } else {
                missingIds.push(id);
              }
            }

            if (missingIds.length > 0) {
              const dbRecords = await this.repository.getKeys(
                this.workspaceId,
                this.sessionId,
                type,
                missingIds,
              );

              for (const record of dbRecords) {
                const parsed = this.deserializeStoredValue(type, record.serializedData);
                (result as any)[record.keyId] = parsed;

                await this.redis.setex(
                  `${cacheKeyPrefix}${record.keyId}`,
                  this.cacheTtlSeconds,
                  this.serializeCacheValue(type, record.serializedData),
                );
              }
            }

            return result as any;
          },
          set: async data => {
            for (const [type, rawTypeData] of Object.entries(
              data as Record<string, Record<string, unknown> | undefined>,
            )) {
              const typeData = rawTypeData;
              if (!typeData) {
                continue;
              }

              await this.repository.saveKeys(
                this.workspaceId,
                this.sessionId,
                type,
                typeData,
              );

              const cacheKeyPrefix = `wa:${this.workspaceId}:auth:${this.sessionId}:${type}:`;
              for (const [id, value] of Object.entries(typeData)) {
                if (value) {
                  await this.redis.setex(
                    `${cacheKeyPrefix}${id}`,
                    this.cacheTtlSeconds,
                    this.serializeCacheValue(type, value),
                  );
                } else {
                  await this.redis.del(`${cacheKeyPrefix}${id}`);
                  await this.repository.removeKeys(this.workspaceId, this.sessionId, type, [id]);
                }
              }
            }
          },
        },
      },
      saveCreds: async () => {
        await this.repository.saveKeys(this.workspaceId, this.sessionId, 'creds', {
          default: creds,
        });
        await this.redis.del(`wa:${this.workspaceId}:auth:${this.sessionId}:creds:default`);
      },
    };
  }

  public async clearSession(): Promise<void> {
    console.warn(
      `[AUTH] Wiping all persistent data for session ${this.sessionId} (WS: ${this.workspaceId})...`,
    );

    await this.repository.removeAllKeys(this.workspaceId, this.sessionId);

    const pattern = `wa:${this.workspaceId}:auth:${this.sessionId}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  private deserializeStoredValue(type: string, data: unknown): unknown {
    if (this.binaryKeyTypes.has(type)) {
      return this.deserializeBinaryValue(data);
    }

    const parsed = this.deserializeStructuredValue(data);
    if (type === 'app-state-sync-key' && parsed) {
      return proto.Message.AppStateSyncKeyData.fromObject(parsed as any);
    }

    return parsed;
  }

  private deserializeBinaryValue(data: unknown): Buffer | null {
    if (!data) {
      return null;
    }

    if (data instanceof Uint8Array && !Buffer.isBuffer(data)) {
      return Buffer.from(data);
    }

    if (Buffer.isBuffer(data)) {
      const parsed = this.tryParseJson(data.toString('utf-8'));
      if (parsed === JSON_PARSE_FAILED) {
        return data;
      }

      if (Buffer.isBuffer(parsed)) {
        return parsed;
      }

      return Buffer.from(JSON.stringify(parsed, BufferJSON.replacer), 'utf-8');
    }

    if (typeof data === 'string') {
      const parsed = this.tryParseJson(data);
      if (parsed === JSON_PARSE_FAILED) {
        return Buffer.from(data, 'utf-8');
      }

      if (Buffer.isBuffer(parsed)) {
        return parsed;
      }

      return Buffer.from(JSON.stringify(parsed, BufferJSON.replacer), 'utf-8');
    }

    return Buffer.from(JSON.stringify(data, BufferJSON.replacer), 'utf-8');
  }

  private deserializeStructuredValue(data: unknown): unknown {
    if (!data) {
      return null;
    }

    let current: unknown = data instanceof Uint8Array && !Buffer.isBuffer(data)
      ? Buffer.from(data)
      : data;

    for (let depth = 0; depth < 3; depth++) {
      if (Buffer.isBuffer(current)) {
        const parsed = this.tryParseJson(current.toString('utf-8'));
        current = parsed === JSON_PARSE_FAILED ? current.toString('utf-8') : parsed;
        continue;
      }

      if (typeof current === 'string') {
        const parsed = this.tryParseJson(current);
        current = parsed === JSON_PARSE_FAILED ? current : parsed;
        continue;
      }

      return current;
    }

    return current;
  }

  private serializeCacheValue(type: string, value: unknown): string {
    if (this.binaryKeyTypes.has(type)) {
      const binary = this.deserializeBinaryValue(value);
      return JSON.stringify(binary, BufferJSON.replacer);
    }

    if (Buffer.isBuffer(value)) {
      return value.toString('utf-8');
    }

    if (typeof value === 'string') {
      return value;
    }

    return JSON.stringify(value, BufferJSON.replacer);
  }

  private tryParseJson(data: string): unknown | typeof JSON_PARSE_FAILED {
    try {
      return JSON.parse(data, BufferJSON.reviver);
    } catch {
      return JSON_PARSE_FAILED;
    }
  }
}
