import { SessionReference } from '../../entities/operational/SessionReference.js';
import { Session } from '../../entities/session/Session.js';

export interface SessionRepository {
  findByReference(reference: SessionReference): Promise<Session | undefined>;
  listByProvider(providerId: string): Promise<readonly Session[]>;
  listByWorkspace(workspaceId: number): Promise<readonly Session[]>;
  listRecoverableByWorkspace(workspaceId: number): Promise<readonly Session[]>;
  save(session: Session): Promise<void>;
}
