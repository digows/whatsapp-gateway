import { z } from "zod";
import { ContactRegistrationSchema } from "./contact-registration.ts";
import { OutboundMessageSchema } from "./content/outbound-message.ts";
import { AccountScopeSchema, GatewayIdentifierSchema, OperationResultSchema } from "./gateway.ts";

export const GatewayRequestIdentitySchema = AccountScopeSchema.extend({ requestId: GatewayIdentifierSchema });
export type GatewayRequestIdentity = z.infer<typeof GatewayRequestIdentitySchema>;
const commandFields = {
  ...GatewayRequestIdentitySchema.shape,
  apiVersion: z.literal("1"),
};
export const GatewayCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...commandFields, type: z.literal("send"), message: OutboundMessageSchema }),
  z.strictObject({
    ...commandFields,
    type: z.literal("presence"),
    chatAddress: z.string().min(1).max(512),
    composing: z.boolean(),
  }),
  z.strictObject({
    ...commandFields,
    type: z.literal("contact.lookup"),
    address: z.string().min(1).max(512),
  }),
]);
export type GatewayCommand = z.infer<typeof GatewayCommandSchema>;
export const GatewayCommandResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...commandFields, type: z.literal("send"), result: OperationResultSchema }),
  z.strictObject({ ...commandFields, type: z.literal("presence") }),
  z.strictObject({ ...commandFields, type: z.literal("contact.lookup"), result: ContactRegistrationSchema }),
]).superRefine((value, context) =>
{
  if (
    "result" in value
    && (value.result.workspaceId !== value.workspaceId || value.result.accountId !== value.accountId)
  )
  {
    context.addIssue({ code: "custom", message: "Command response account scope mismatch" });
  }
});
export type GatewayCommandResponse = z.infer<typeof GatewayCommandResponseSchema>;
export const GatewayCommandStateSchema = z.enum(["PENDING", "EXECUTING", "COMPLETED", "FAILED"]);
export type GatewayCommandState = z.infer<typeof GatewayCommandStateSchema>;
export const GatewayCommandFailureSchema = z.enum(["EXECUTION_FAILED"]);
export type GatewayCommandFailure = z.infer<typeof GatewayCommandFailureSchema>;
export const GatewayCommandResultSchema = GatewayRequestIdentitySchema.extend({
  apiVersion: z.literal("1"),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: GatewayCommandStateSchema,
  response: GatewayCommandResponseSchema.nullable(),
  failure: GatewayCommandFailureSchema.nullable(),
}).superRefine((value, context) =>
{
  const response = value.response;
  if (
    (value.state === "COMPLETED") !== (response !== null)
    || (value.state === "FAILED") !== (value.failure !== null)
    || (response !== null
      && (response.workspaceId !== value.workspaceId || response.accountId !== value.accountId
        || response.requestId !== value.requestId))
  )
  {
    context.addIssue({ code: "custom", message: "Command result state or identity mismatch" });
  }
});
export type GatewayCommandResult = z.infer<typeof GatewayCommandResultSchema>;
