import { BufferJSON } from 'baileys';
import { env } from '../../application/config/env.js';
import { ISignalKeyRepository } from '../../domain/repositories/ISignalKeyRepository.js';
import { PgConnection } from './PgConnection.js';

/**
 * PostgreSQL implementation of the Signal Key Repository.
 * Uses Row Level Security (RLS) for tenant isolation.
 */
export class PgSignalKeyRepository implements ISignalKeyRepository {
  private readonly pool = PgConnection.getPool();
  private readonly binaryKeyTypes = new Set(['sender-key', 'identity-key']);

  public async getKeys(
    workspaceId: number,
    sessionId: string,
    type: string,
    ids: string[],
  ): Promise<any[]> {
    if (ids.length === 0) {
      return [];
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        workspaceId.toString(),
      ]);

      const result = await client.query(
        `SELECT key_id as "keyId", serialized_data as "serializedData"
         FROM "${env.DB_SCHEMA}".authorization_keys
         WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3)`,
        [sessionId, type, ids],
      );

      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveKeys(
    workspaceId: number,
    sessionId: string,
    type: string,
    keys: { [id: string]: any },
  ): Promise<void> {
    if (Object.keys(keys).length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        workspaceId.toString(),
      ]);

      for (const [id, value] of Object.entries(keys)) {
        if (!value) {
          continue;
        }

        const data = this.serializeForPersistence(type, value);

        await client.query(
          `INSERT INTO "${env.DB_SCHEMA}".authorization_keys
           (workspace_id, session_id, key_type, key_id, serialized_data)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, session_id, key_type, key_id)
           DO UPDATE SET serialized_data = EXCLUDED.serialized_data, updated_at = NOW()`,
          [workspaceId, sessionId, type, id, data],
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

  public async removeKeys(
    workspaceId: number,
    sessionId: string,
    type: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        workspaceId.toString(),
      ]);

      await client.query(
        `DELETE FROM "${env.DB_SCHEMA}".authorization_keys
         WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3)`,
        [sessionId, type, ids],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async removeAllKeys(workspaceId: number, sessionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
        workspaceId.toString(),
      ]);

      await client.query(
        `DELETE FROM "${env.DB_SCHEMA}".authorization_keys
         WHERE session_id = $1`,
        [sessionId],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private serializeForPersistence(type: string, value: unknown): string | Buffer {
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      return value;
    }

    if (this.binaryKeyTypes.has(type) && value instanceof Uint8Array) {
      return Buffer.from(value);
    }

    return JSON.stringify(value, BufferJSON.replacer);
  }
}
