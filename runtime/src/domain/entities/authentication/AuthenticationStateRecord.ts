import { AuthenticationStateKey } from './AuthenticationStateKey.js';
import { SessionReference } from '../operational/SessionReference.js';

/**
 * One authentication state row owned by a hosted session.
 */
export class AuthenticationStateRecord {
  constructor(
    public readonly session: SessionReference,
    public readonly key: AuthenticationStateKey,
    public readonly serializedData: unknown,
  ) {}
}
