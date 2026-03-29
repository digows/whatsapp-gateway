import { AuthStateQuery } from '../../domain/entities/auth/AuthStateQuery.js';
import { AuthStateRecord } from '../../domain/entities/auth/AuthStateRecord.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';

export interface SignalKeyRepository {
  findByQuery(
    query: AuthStateQuery,
  ): Promise<AuthStateRecord[]>;

  save(records: readonly AuthStateRecord[]): Promise<void>;

  removeByQuery(
    query: AuthStateQuery,
  ): Promise<void>;

  removeAllForSession(session: SessionReference): Promise<void>;
}
