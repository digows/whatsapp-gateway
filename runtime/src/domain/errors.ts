export class AccountOwnedError extends Error
{
  constructor()
  {
    super("Account is already owned");
    this.name = "AccountOwnedError";
  }
}
export class GatewayConflictError extends Error
{
  constructor(message: string)
  {
    super(message);
    this.name = "GatewayConflictError";
  }
}
export class GatewayResourceUnavailableError extends Error
{
  constructor(message: string)
  {
    super(message);
    this.name = "GatewayResourceUnavailableError";
  }
}

export class UnpairedAccountRecoveryError extends Error
{
  constructor()
  {
    super("Unpaired account attempt requires a new desired revision");
    this.name = "UnpairedAccountRecoveryError";
  }
}
