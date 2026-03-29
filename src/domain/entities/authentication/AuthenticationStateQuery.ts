import { SessionReference } from '../operational/SessionReference.js';

/**
 * Query object used to load or delete a subset of authentication state keys for one session.
 */
export class AuthenticationStateQuery {
  constructor(
    public readonly session: SessionReference,
    public readonly keyType: string,
    public readonly keyIds: readonly string[],
  ) {
    if (!keyType.trim()) {
      throw new Error('AuthenticationStateQuery requires a non-empty key type.');
    }
  }
}
