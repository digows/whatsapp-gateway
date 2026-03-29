import { BufferJSON } from 'baileys';
import { SignalKeyRepository } from '../../domain/repositories/authentication/SignalKeyRepository.js';
import { env } from '../../application/config/env.js';
import { AuthenticationStateKey } from '../../domain/entities/authentication/AuthenticationStateKey.js';
import { AuthenticationStateQuery } from '../../domain/entities/authentication/AuthenticationStateQuery.js';
import { AuthenticationStateRecord } from '../../domain/entities/authentication/AuthenticationStateRecord.js';
import { AuthenticationStateType } from '../../domain/entities/authentication/AuthenticationStateType.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { PgConnection } from './PgConnection.js';

/**
 * PostgreSQL implementation of the signal key repository.
 * Uses Row Level Security (RLS) for tenant isolation.
 */
export class PgSignalKeyRepository implements SignalKeyRepository {
  private readonly pool = PgConnection.getPool();

  public async findByQuery(query: AuthenticationStateQuery): Promise<AuthenticationStateRecord[]> {
    if (query.keyIds.length === 0) {
      return [];
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        query.session.workspaceId.toString(),
      ]);

      const result = await client.query(
        `SELECT key_id as "keyId", serialized_data as "serializedData"
         FROM "${env.DB_SCHEMA}".authorization_keys
         WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3)`,
        [query.session.sessionId, query.keyType.value, query.keyIds],
      );

      await client.query('COMMIT');
      return result.rows.map(row => new AuthenticationStateRecord(
        query.session,
        new AuthenticationStateKey(query.keyType, row.keyId),
        row.serializedData,
      ));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(records: readonly AuthenticationStateRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const recordsBySession = new Map<string, AuthenticationStateRecord[]>();
    for (const record of records) {
      const sessionKey = record.session.toKey();
      const current = recordsBySession.get(sessionKey);
      if (current) {
        current.push(record);
      } else {
        recordsBySession.set(sessionKey, [record]);
      }
    }

    for (const sessionRecords of recordsBySession.values()) {
      await this.saveSessionRecords(sessionRecords);
    }
  }

  public async removeByQuery(query: AuthenticationStateQuery): Promise<void> {
    if (query.keyIds.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        query.session.workspaceId.toString(),
      ]);

      await client.query(
        `DELETE FROM "${env.DB_SCHEMA}".authorization_keys
         WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3)`,
        [query.session.sessionId, query.keyType.value, query.keyIds],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async removeAllForSession(session: SessionReference): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        session.workspaceId.toString(),
      ]);

      await client.query(
        `DELETE FROM "${env.DB_SCHEMA}".authorization_keys
         WHERE session_id = $1`,
        [session.sessionId],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async saveSessionRecords(records: readonly AuthenticationStateRecord[]): Promise<void> {
    const session = records[0].session;
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        session.workspaceId.toString(),
      ]);

      for (const record of records) {
        await client.query(
          `INSERT INTO "${env.DB_SCHEMA}".authorization_keys
           (workspace_id, session_id, key_type, key_id, serialized_data)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, session_id, key_type, key_id)
           DO UPDATE SET serialized_data = EXCLUDED.serialized_data, updated_at = NOW()`,
          [
            record.session.workspaceId,
            record.session.sessionId,
            record.key.type.value,
            record.key.id,
            this.serializeForPersistence(record.key.type, record.serializedData),
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private serializeForPersistence(type: AuthenticationStateType, value: unknown): string | Buffer {
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      return value;
    }

    if (type.isBinary() && value instanceof Uint8Array) {
      return Buffer.from(value);
    }

    return JSON.stringify(value, BufferJSON.replacer);
  }
}
