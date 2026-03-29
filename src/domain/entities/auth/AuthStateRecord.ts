import { AuthStateKey } from './AuthStateKey.js';
import { SessionReference } from '../operational/SessionReference.js';

export class AuthStateRecord {
  constructor(
    public readonly session: SessionReference,
    public readonly key: AuthStateKey,
    public readonly serializedData: unknown,
  ) {}
}
