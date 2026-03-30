import { env } from '../../application/config/env.js';
import { SessionWorkerHost } from '../../application/services/SessionWorkerHost.js';
import { HostedSessionSnapshot } from '../entities/operational/HostedSessionSnapshot.js';
import { SessionReference } from '../entities/operational/SessionReference.js';

type SessionHostAccess = Pick<
  SessionWorkerHost,
  'listHostedSessionSnapshots' | 'getHostedSessionSnapshot' | 'stopSession'
>;

/**
 * Synchronous operational service for the current worker's hosted sessions.
 * It intentionally exposes the local worker view only. Global session ownership
 * still requires a controller/read-model layer that does not exist yet.
 */
export class SessionService {
  constructor(
    private readonly sessionHost: SessionHostAccess,
    private readonly providerId = env.CHANNEL_PROVIDER_ID,
  ) {}

  public listHostedSessions(workspaceId: number): HostedSessionSnapshot[] {
    this.ensureWorkspaceId(workspaceId);

    return this.sessionHost
      .listHostedSessionSnapshots()
      .filter(snapshot => snapshot.session.provider === this.providerId)
      .filter(snapshot => snapshot.session.workspaceId === workspaceId);
  }

  public getHostedSession(
    workspaceId: number,
    sessionId: string,
  ): HostedSessionSnapshot | undefined {
    const session = this.createSessionReference(workspaceId, sessionId);
    return this.sessionHost.getHostedSessionSnapshot(session);
  }

  public async stopHostedSession(
    workspaceId: number,
    sessionId: string,
  ): Promise<boolean> {
    const session = this.createSessionReference(workspaceId, sessionId);
    const snapshot = this.sessionHost.getHostedSessionSnapshot(session);

    if (!snapshot) {
      return false;
    }

    await this.sessionHost.stopSession(session);
    return true;
  }

  private createSessionReference(workspaceId: number, sessionId: string): SessionReference {
    this.ensureWorkspaceId(workspaceId);

    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error('SessionService requires a non-empty sessionId.');
    }

    return new SessionReference(
      this.providerId,
      workspaceId,
      normalizedSessionId,
    );
  }

  private ensureWorkspaceId(workspaceId: number): void {
    if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
      throw new Error('SessionService requires a positive workspaceId.');
    }
  }
}
