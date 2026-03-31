import { SessionReference } from '../../src/domain/entities/operational/SessionReference.js';
import { Session } from '../../src/domain/entities/session/Session.js';
import { SessionRepository } from '../../src/domain/repositories/session/SessionRepository.js';

export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();

  public async findByReference(reference: SessionReference): Promise<Session | undefined> {
    return this.sessions.get(reference.toKey());
  }

  public async listByWorkspace(workspaceId: number): Promise<readonly Session[]> {
    return Array.from(this.sessions.values())
      .filter(session => session.reference.workspaceId === workspaceId);
  }

  public async listRecoverableByWorkspace(workspaceId: number): Promise<readonly Session[]> {
    return Array.from(this.sessions.values())
      .filter(session =>
        session.reference.workspaceId === workspaceId
        && session.isRecoverable());
  }

  public async save(session: Session): Promise<void> {
    this.sessions.set(session.reference.toKey(), session);
  }
}
