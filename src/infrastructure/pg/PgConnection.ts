import pg from 'pg';
import { env } from '../../application/config/env.js';

const { Pool } = pg;

/**
 * Singleton PostgreSQL pool for provider persistence.
 */
export class PgConnection {
  private static pool?: pg.Pool;

  private static buildSslConfig(): pg.PoolConfig['ssl'] | undefined {
    if (!env.POSTGRES_SSL_ENABLED) {
      return undefined;
    }

    if (env.POSTGRES_SSL_CA?.trim()) {
      return {
        ca: env.POSTGRES_SSL_CA,
        rejectUnauthorized: env.POSTGRES_SSL_REJECT_UNAUTHORIZED,
      };
    }

    return {
      rejectUnauthorized: env.POSTGRES_SSL_REJECT_UNAUTHORIZED,
    };
  }

  public static getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: env.POSTGRES_URL,
        ssl: this.buildSslConfig(),
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      this.pool.on('error', err => {
        console.error('[DB] Unexpected error on idle client', err);
      });

      console.log(
        `[DB] PostgreSQL pool initialized with search_path="${env.DB_SCHEMA}" ssl=${env.POSTGRES_SSL_ENABLED}`,
      );
    }

    return this.pool;
  }

  public static async initializeSchema(): Promise<void> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      console.log(`[DB] Ensuring schema "${env.DB_SCHEMA}" exists...`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${env.DB_SCHEMA}"`);

      console.log('[DB] Configuring table "authorization_keys" with BYTEA and RLS...');
      await client.query(`
        CREATE TABLE IF NOT EXISTS "${env.DB_SCHEMA}".authorization_keys (
          workspace_id BIGINT NOT NULL,
          session_id TEXT NOT NULL,
          key_type TEXT NOT NULL,
          key_id TEXT NOT NULL,
          serialized_data BYTEA NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (workspace_id, session_id, key_type, key_id)
        );
      `);

      console.log('[DB] Enabling Row Level Security (RLS)...');
      await client.query(
        `ALTER TABLE "${env.DB_SCHEMA}".authorization_keys ENABLE ROW LEVEL SECURITY;`,
      );

      await client.query(
        `DROP POLICY IF EXISTS workspace_isolation_policy ON "${env.DB_SCHEMA}".authorization_keys;`,
      );

      await client.query(`
        CREATE POLICY workspace_isolation_policy ON "${env.DB_SCHEMA}".authorization_keys
        USING (workspace_id = current_setting('app.current_workspace_id')::bigint);
      `);

      console.log('[DB] Database initialization complete.');
    } catch (error) {
      console.error('[DB] Critical error during schema initialization:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  public static async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
    return this.getPool().query(text, params);
  }

  public static async close(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.end();
    this.pool = undefined;
  }
}
