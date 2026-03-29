export class AuthStateKey {
  constructor(
    public readonly type: string,
    public readonly id: string,
  ) {
    if (!type.trim()) {
      throw new Error('AuthStateKey requires a non-empty type.');
    }

    if (!id.trim()) {
      throw new Error('AuthStateKey requires a non-empty id.');
    }
  }
}
