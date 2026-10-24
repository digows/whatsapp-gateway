import {
  type AccountScope,
  AccountScopeSchema,
  GatewayIdentifierSchema,
} from "@digows/whatsapp-gateway-contracts";
import { z } from "zod";
export const AccountGrantSchema = z.strictObject({
  workspaceId: GatewayIdentifierSchema,
  accountIds: z.union([z.literal("*"), z.array(GatewayIdentifierSchema).min(1)]),
});
export type AccountGrant = z.infer<typeof AccountGrantSchema>;
export class GatewayAuthorizationError extends Error
{
  constructor()
  {
    super("Account scope is not authorized");
    this.name = "GatewayAuthorizationError";
  }
}
/** Construct only from authenticated transport configuration, never from the command body. */
export class GatewayPrincipal
{
  private readonly grants: readonly AccountGrant[];
  readonly id: string;
  constructor(id: string, grants: readonly AccountGrant[])
  {
    this.id = z.string().min(1).max(256).parse(id);
    this.grants = z.array(AccountGrantSchema).min(1).parse(grants);
  }
  authorize(input: AccountScope): AccountScope
  {
    const scope = AccountScopeSchema.parse({ workspaceId: input.workspaceId, accountId: input.accountId });
    if (
      !this.grants.some(grant =>
        grant.workspaceId === scope.workspaceId
        && (grant.accountIds === "*" || grant.accountIds.includes(scope.accountId))
      )
    )
    {
      throw new GatewayAuthorizationError();
    }
    return scope;
  }
}
