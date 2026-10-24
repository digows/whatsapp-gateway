import { z } from "zod";
import { GatewayCommandResultSchema } from "./commands.ts";
import { type AccountScope, AccountScopeSchema, GatewayIdentifierSchema } from "./gateway.ts";
export interface GatewayStreamNames
{
  readonly commands: string;
  readonly results: string;
  readonly events: string;
}
export function gatewayStreamNames(prefix: string, scope: AccountScope): GatewayStreamNames
{
  z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).parse(prefix);
  const identity = AccountScopeSchema.parse({ workspaceId: scope.workspaceId, accountId: scope.accountId });
  const base = `${prefix}:${identity.workspaceId}:${identity.accountId}`;
  return { commands: `${base}:commands`, results: `${base}:results`, events: `${base}:events` };
}
export const GatewayStreamReceiptSchema = AccountScopeSchema.extend({
  apiVersion: z.literal("1"),
  sourceStream: z.string().min(1).max(512),
  sourceMessageId: z.string().regex(/^[0-9]+-[0-9]+$/),
  requestId: GatewayIdentifierSchema.nullable(),
  status: z.enum(["QUEUED", "REJECTED"]),
  command: GatewayCommandResultSchema.nullable(),
  failure: z.enum(["INVALID_REQUEST", "UNAUTHORIZED_SCOPE", "CONFLICT"]).nullable(),
}).superRefine((receipt, context) =>
{
  if (
    (receipt.status === "QUEUED") !== (receipt.command !== null)
    || (receipt.status === "REJECTED") !== (receipt.failure !== null)
    || (receipt.command !== null
      && (receipt.workspaceId !== receipt.command.workspaceId
        || receipt.accountId !== receipt.command.accountId
        || receipt.requestId !== receipt.command.requestId))
  )
  {
    context.addIssue({ code: "custom", message: "Stream receipt state or scope mismatch" });
  }
});
export type GatewayStreamReceipt = z.infer<typeof GatewayStreamReceiptSchema>;
