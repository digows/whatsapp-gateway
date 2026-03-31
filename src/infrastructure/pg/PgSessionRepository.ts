import pg from 'pg';
import { env } from '../../application/config/env.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { Session } from '../../domain/entities/session/Session.js';
import {
  parseSessionActivationState,
  SessionActivationState,
} from '../../domain/entities/session/SessionActivationState.js';
import {
  parseSessionDesiredState,
  SessionDesiredState,
} from '../../domain/entities/session/SessionDesiredState.js';
import {
  parseSessionRuntimeState,
  SessionRuntimeState,
} from '../../domain/entities/session/SessionRuntimeState.js';
import { SessionRepository } from '../../domain/repositories/session/SessionRepository.js';
import { PgConnection } from './PgConnection.js';

interface SessionRow {
  provider: string;
  workspaceId: string;
  sessionId: string;
  desiredState: string;
  runtimeState: string;
  activationState: string;
  hasPersistedCredentials: boolean;
  assignedWorkerId: string | null;
  phoneNumber: string | null;
  whatsappJid: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
}

/**
 * PostgreSQL-backed catalog for durable Session entities.
 * This is the source of truth for the embedded control plane, distinct from the
 * lower-level authorization_keys table that stores Baileys auth state.
 */
export class PgSessionRepository implements SessionRepository {
  public async findByReference(reference: SessionReference): Promise<Session | undefined> {
    const client = await PgConnection.getPool().connect();

    try {
      await client.query('BEGIN');
      await this.setWorkspaceContext(client, reference.workspaceId);

      const result = await client.query<SessionRow>(
        `SELECT
            provider,
            workspace_id AS "workspaceId",
            session_id AS "sessionId",
            desired_state AS "desiredState",
            runtime_state AS "runtimeState",
            activation_state AS "activationState",
            has_persisted_credentials AS "hasPersistedCredentials",
            assigned_worker_id AS "assignedWorkerId",
            phone_number AS "phoneNumber",
            whatsapp_jid AS "whatsappJid",
            last_error AS "lastError",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            last_connected_at AS "lastConnectedAt",
            last_disconnected_at AS "lastDisconnectedAt"
         FROM "${env.DB_SCHEMA}".sessions
         WHERE provider = $1 AND session_id = $2`,
        [reference.provider, reference.sessionId],
      );

      await client.query('COMMIT');
      return result.rows[0] ? this.mapRowToSession(result.rows[0]) : undefined;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listByWorkspace(workspaceId: number): Promise<readonly Session[]> {
    const client = await PgConnection.getPool().connect();

    try {
      await client.query('BEGIN');
      await this.setWorkspaceContext(client, workspaceId);

      const result = await client.query<SessionRow>(
        `SELECT
            provider,
            workspace_id AS "workspaceId",
            session_id AS "sessionId",
            desired_state AS "desiredState",
            runtime_state AS "runtimeState",
            activation_state AS "activationState",
            has_persisted_credentials AS "hasPersistedCredentials",
            assigned_worker_id AS "assignedWorkerId",
            phone_number AS "phoneNumber",
            whatsapp_jid AS "whatsappJid",
            last_error AS "lastError",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            last_connected_at AS "lastConnectedAt",
            last_disconnected_at AS "lastDisconnectedAt"
         FROM "${env.DB_SCHEMA}".sessions
         ORDER BY created_at ASC`,
      );

      await client.query('COMMIT');
      return result.rows.map(row => this.mapRowToSession(row));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listByProvider(providerId: string): Promise<readonly Session[]> {
    const result = await PgConnection.query(
      `SELECT
          provider,
          workspace_id AS "workspaceId",
          session_id AS "sessionId",
          desired_state AS "desiredState",
          runtime_state AS "runtimeState",
          activation_state AS "activationState",
          has_persisted_credentials AS "hasPersistedCredentials",
          assigned_worker_id AS "assignedWorkerId",
          phone_number AS "phoneNumber",
          whatsapp_jid AS "whatsappJid",
          last_error AS "lastError",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_connected_at AS "lastConnectedAt",
          last_disconnected_at AS "lastDisconnectedAt"
       FROM "${env.DB_SCHEMA}".sessions
       WHERE provider = $1
       ORDER BY updated_at ASC`,
      [providerId],
    );

    return result.rows.map(row => this.mapRowToSession(row as SessionRow));
  }

  public async listRecoverableByWorkspace(workspaceId: number): Promise<readonly Session[]> {
    const client = await PgConnection.getPool().connect();

    try {
      await client.query('BEGIN');
      await this.setWorkspaceContext(client, workspaceId);

      const result = await client.query<SessionRow>(
        `SELECT
            provider,
            workspace_id AS "workspaceId",
            session_id AS "sessionId",
            desired_state AS "desiredState",
            runtime_state AS "runtimeState",
            activation_state AS "activationState",
            has_persisted_credentials AS "hasPersistedCredentials",
            assigned_worker_id AS "assignedWorkerId",
            phone_number AS "phoneNumber",
            whatsapp_jid AS "whatsappJid",
            last_error AS "lastError",
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            last_connected_at AS "lastConnectedAt",
            last_disconnected_at AS "lastDisconnectedAt"
         FROM "${env.DB_SCHEMA}".sessions
         WHERE desired_state = $1
           AND has_persisted_credentials = TRUE
           AND runtime_state <> $2
         ORDER BY updated_at ASC`,
        [SessionDesiredState.Active, SessionRuntimeState.LoggedOut],
      );

      await client.query('COMMIT');
      return result.rows.map(row => this.mapRowToSession(row));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async save(session: Session): Promise<void> {
    const client = await PgConnection.getPool().connect();

    try {
      await client.query('BEGIN');
      await this.setWorkspaceContext(client, session.reference.workspaceId);

      await client.query(
        `INSERT INTO "${env.DB_SCHEMA}".sessions (
            provider,
            workspace_id,
            session_id,
            desired_state,
            runtime_state,
            activation_state,
            has_persisted_credentials,
            assigned_worker_id,
            phone_number,
            whatsapp_jid,
            last_error,
            created_at,
            updated_at,
            last_connected_at,
            last_disconnected_at
         ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         )
         ON CONFLICT (provider, workspace_id, session_id)
         DO UPDATE SET
            desired_state = EXCLUDED.desired_state,
            runtime_state = EXCLUDED.runtime_state,
            activation_state = EXCLUDED.activation_state,
            has_persisted_credentials = EXCLUDED.has_persisted_credentials,
            assigned_worker_id = EXCLUDED.assigned_worker_id,
            phone_number = EXCLUDED.phone_number,
            whatsapp_jid = EXCLUDED.whatsapp_jid,
            last_error = EXCLUDED.last_error,
            updated_at = EXCLUDED.updated_at,
            last_connected_at = EXCLUDED.last_connected_at,
            last_disconnected_at = EXCLUDED.last_disconnected_at`,
        [
          session.reference.provider,
          session.reference.workspaceId,
          session.reference.sessionId,
          session.desiredState,
          session.runtimeState,
          session.activationState,
          session.hasPersistedCredentials,
          session.assignedWorkerId ?? null,
          session.phoneNumber ?? null,
          session.whatsappJid ?? null,
          session.lastError ?? null,
          session.createdAt,
          session.updatedAt,
          session.lastConnectedAt ?? null,
          session.lastDisconnectedAt ?? null,
        ],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async setWorkspaceContext(
    client: pg.PoolClient,
    workspaceId: number,
  ): Promise<void> {
    await client.query(`SELECT set_config('app.current_workspace_id', $1::text, true)`, [
      workspaceId.toString(),
    ]);
  }

  private mapRowToSession(row: SessionRow): Session {
    return new Session(
      new SessionReference(
        row.provider,
        Number.parseInt(row.workspaceId, 10),
        row.sessionId,
      ),
      parseSessionDesiredState(row.desiredState),
      parseSessionRuntimeState(row.runtimeState),
      parseSessionActivationState(row.activationState),
      row.hasPersistedCredentials,
      row.createdAt,
      row.updatedAt,
      row.assignedWorkerId ?? undefined,
      row.phoneNumber ?? undefined,
      row.whatsappJid ?? undefined,
      row.lastError ?? undefined,
      row.lastConnectedAt ?? undefined,
      row.lastDisconnectedAt ?? undefined,
    );
  }
}
