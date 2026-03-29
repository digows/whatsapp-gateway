import { AuthenticationStateType } from './AuthenticationStateType.js';

/**
 * Identifies one stored authentication state entry inside a session scope.
 */
export class AuthenticationStateKey {
  constructor(
    public readonly type: AuthenticationStateType,
    public readonly id: string,
  ) {
    if (!id.trim()) {
      throw new Error('AuthenticationStateKey requires a non-empty id.');
    }
  }
}
