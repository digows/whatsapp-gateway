import { z } from "zod";
import { AccountScopeSchema, GatewayIdentifierSchema } from "./gateway.ts";
export const DesiredAccountRequestSchema = AccountScopeSchema.extend({
  apiVersion: z.literal("1"),
  expectedRevision: z.number().int().nonnegative().max(2147483646),
  enabled: z.boolean(),
});
export type DesiredAccountRequest = z.infer<typeof DesiredAccountRequestSchema>;
export const DesiredAccountSchema = AccountScopeSchema.extend({
  apiVersion: z.literal("1"),
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  assignedRuntimeId: GatewayIdentifierSchema.nullable(),
  attemptedRevision: z.number().int().nonnegative(),
  blockedRevision: z.number().int().nonnegative(),
});
export type DesiredAccount = z.infer<typeof DesiredAccountSchema>;
