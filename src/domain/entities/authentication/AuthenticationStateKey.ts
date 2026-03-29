/**
 * Identifies one stored authentication state entry inside a session scope.
 */
export class AuthenticationStateKey {
  constructor(
    public readonly type: string,
    public readonly id: string,
  ) {
    if (!type.trim()) {
      throw new Error('AuthenticationStateKey requires a non-empty type.');
    }

    if (!id.trim()) {
      throw new Error('AuthenticationStateKey requires a non-empty id.');
    }
  }
}
