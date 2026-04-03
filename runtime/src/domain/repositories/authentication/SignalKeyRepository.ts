import { AuthenticationStateQuery } from '../../entities/authentication/AuthenticationStateQuery.js';
import { AuthenticationStateRecord } from '../../entities/authentication/AuthenticationStateRecord.js';
import { SessionReference } from '../../entities/operational/SessionReference.js';

/**
 * Persistence contract for Signal/Baileys authentication state records.
 */
export interface SignalKeyRepository {
  findByQuery(
    query: AuthenticationStateQuery,
  ): Promise<AuthenticationStateRecord[]>;

  save(records: readonly AuthenticationStateRecord[]): Promise<void>;

  removeByQuery(
    query: AuthenticationStateQuery,
  ): Promise<void>;

  removeAllForSession(session: SessionReference): Promise<void>;
}
