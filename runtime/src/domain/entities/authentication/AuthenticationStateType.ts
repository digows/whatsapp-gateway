/**
 * Canonical authentication state key kind used by the Baileys auth store.
 * Known types are exposed as named singletons, while unknown future values still
 * remain representable through fromValue at the infrastructure boundary.
 */
export class AuthenticationStateType {
  public static readonly Credentials = new AuthenticationStateType('creds');
  public static readonly AppStateSyncKey = new AuthenticationStateType('app-state-sync-key');
  public static readonly IdentityKey = new AuthenticationStateType('identity-key');
  public static readonly SenderKey = new AuthenticationStateType('sender-key');

  private static readonly knownTypes = new Map<string, AuthenticationStateType>([
    [AuthenticationStateType.Credentials.value, AuthenticationStateType.Credentials],
    [AuthenticationStateType.AppStateSyncKey.value, AuthenticationStateType.AppStateSyncKey],
    [AuthenticationStateType.IdentityKey.value, AuthenticationStateType.IdentityKey],
    [AuthenticationStateType.SenderKey.value, AuthenticationStateType.SenderKey],
  ]);

  public static fromValue(value: string): AuthenticationStateType {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new Error('AuthenticationStateType requires a non-empty value.');
    }

    return this.knownTypes.get(normalizedValue) ?? new AuthenticationStateType(normalizedValue);
  }

  private constructor(public readonly value: string) {}

  public isBinary(): boolean {
    return this.value === AuthenticationStateType.IdentityKey.value
      || this.value === AuthenticationStateType.SenderKey.value;
  }

  public isAppStateSyncKey(): boolean {
    return this.value === AuthenticationStateType.AppStateSyncKey.value;
  }

  public toString(): string {
    return this.value;
  }
}
