export class AccountOwnedError extends Error
{
  constructor()
  {
    super("Account is already owned");
    this.name = "AccountOwnedError";
  }
}
