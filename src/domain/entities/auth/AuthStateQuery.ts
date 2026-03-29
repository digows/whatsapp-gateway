import { SessionReference } from '../operational/SessionReference.js';

export class AuthStateQuery {
  constructor(
    public readonly session: SessionReference,
    public readonly keyType: string,
    public readonly keyIds: readonly string[],
  ) {
    if (!keyType.trim()) {
      throw new Error('AuthStateQuery requires a non-empty key type.');
    }
  }
}
