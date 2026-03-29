import {
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  SignalDataSet,
  proto,
} from 'baileys';
import { Redis } from 'ioredis';
import { SignalKeyRepository } from '../../application/ports/SignalKeyRepository.js';
import { AuthStateKey } from '../../domain/entities/auth/AuthStateKey.js';
import { AuthStateQuery } from '../../domain/entities/auth/AuthStateQuery.js';
import { AuthStateRecord } from '../../domain/entities/auth/AuthStateRecord.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { RedisKeyBuilder } from '../redis/RedisKeyBuilder.js';

const JSON_PARSE_FAILED = Symbol('json-parse-failed');

/**
 * Maps Baileys auth state to our PostgreSQL + Redis persistence model.
 */
export class BaileysAuthStateStore {
  private readonly cacheTtlSeconds = 3600;
  private readonly binaryKeyTypes = new Set(['sender-key', 'identity-key']);

  constructor(
    private readonly session: SessionReference,
    private readonly repository: SignalKeyRepository,
    private readonly redis: Redis,
  ) {}

  public async getAuthState(): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }> {
    let credentials: any;
    const credentialsQuery = new AuthStateQuery(this.session, 'creds', ['default']);
    const credentialRecords = await this.repository.findByQuery(credentialsQuery);

    if (credentialRecords.length > 0) {
      credentials = this.deserializeStoredValue('creds', credentialRecords[0].serializedData);
    } else {
      console.log(
        `[AUTH] No persistent credentials found for ${this.session.toLogLabel()}. Initializing new state.`,
      );
      credentials = initAuthCreds();
    }

    return {
      state: {
        creds: credentials,
        keys: {
          get: async (type, ids) => {
            const result: SignalDataSet = {};
            const cacheKeyPrefix = RedisKeyBuilder.getAuthRecordKeyPrefix(this.session, type);

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
              const records = await this.repository.findByQuery(
                new AuthStateQuery(this.session, type, missingIds),
              );

              for (const record of records) {
                const parsed = this.deserializeStoredValue(type, record.serializedData);
                (result as any)[record.key.id] = parsed;

                await this.redis.setex(
                  `${cacheKeyPrefix}${record.key.id}`,
                  this.cacheTtlSeconds,
                  this.serializeCacheValue(type, record.serializedData),
                );
              }
            }

            return result as any;
          },
          set: async data => {
            const recordsToSave: AuthStateRecord[] = [];

            for (const [type, rawTypeData] of Object.entries(
              data as Record<string, Record<string, unknown> | undefined>,
            )) {
              if (!rawTypeData) {
                continue;
              }

              const cacheKeyPrefix = RedisKeyBuilder.getAuthRecordKeyPrefix(this.session, type);
              for (const [id, value] of Object.entries(rawTypeData)) {
                if (value) {
                  recordsToSave.push(
                    new AuthStateRecord(
                      this.session,
                      new AuthStateKey(type, id),
                      value,
                    ),
                  );

                  await this.redis.setex(
                    `${cacheKeyPrefix}${id}`,
                    this.cacheTtlSeconds,
                    this.serializeCacheValue(type, value),
                  );
                  continue;
                }

                await this.redis.del(`${cacheKeyPrefix}${id}`);
                await this.repository.removeByQuery(
                  new AuthStateQuery(this.session, type, [id]),
                );
              }
            }

            if (recordsToSave.length > 0) {
              await this.repository.save(recordsToSave);
            }
          },
        },
      },
      saveCreds: async () => {
        const credentialsKey = new AuthStateKey('creds', 'default');
        await this.repository.save([
          new AuthStateRecord(this.session, credentialsKey, credentials),
        ]);
        await this.redis.del(
          RedisKeyBuilder.getAuthRecordKey(this.session, credentialsKey),
        );
      },
    };
  }

  public async clearSession(): Promise<void> {
    console.warn(`[AUTH] Wiping all persistent data for ${this.session.toLogLabel()}...`);

    await this.repository.removeAllForSession(this.session);

    const pattern = RedisKeyBuilder.getAuthSessionPattern(this.session);
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
