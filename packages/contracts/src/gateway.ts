import { z } from "zod";
import type { ContactRegistration } from "./contact-registration.ts";
import type { OutboundMessage } from "./content/outbound-message.ts";

export const GatewayIdentifierSchema = z.uuid().transform(value => value.toLowerCase());
export const AccountScopeSchema = z.strictObject({
  workspaceId: GatewayIdentifierSchema,
  accountId: GatewayIdentifierSchema,
});
export type AccountScope = z.infer<typeof AccountScopeSchema>;
export const SessionStateSchema = z.enum([
  "STOPPED",
  "CONNECTING",
  "AWAITING_PAIRING",
  "CONNECTED",
  "LOGGED_OUT",
  "FAILED",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const OperationStateSchema = z.enum(["PENDING", "IN_FLIGHT", "ACCEPTED", "FAILED", "UNKNOWN"]);
export type OperationState = z.infer<typeof OperationStateSchema>;
export const AccountSchema = AccountScopeSchema.extend({
  state: SessionStateSchema,
  generation: z.number().int().nonnegative(),
  nativeJid: z.string().min(1).nullable(),
  qr: z.string().min(1).nullable(),
});
export type Account = Readonly<z.infer<typeof AccountSchema>>;
export const OperationResultSchema = AccountScopeSchema.extend({
  key: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  nativeIds: z.array(z.string().min(1)).min(1).readonly(),
  acceptedParts: z.number().int().nonnegative(),
  state: OperationStateSchema,
}).superRefine((value, context) =>
{
  if (
    value.acceptedParts > value.nativeIds.length
    || (value.state === "ACCEPTED" && value.acceptedParts !== value.nativeIds.length)
  )
  {
    context.addIssue({ code: "custom", message: "Invalid accepted native message count" });
  }
});
export type OperationResult = Readonly<z.infer<typeof OperationResultSchema>>;
/** A confirmed integration boundary; implementations must not translate UNKNOWN into retry. */
export interface GatewayOperations
{
  lookupContactAddress(accountId: string, address: string): Promise<ContactRegistration>;
  send(accountId: string, message: OutboundMessage): Promise<OperationResult>;
  operation(accountId: string, key: string): Promise<OperationResult>;
  presence(accountId: string, chatId: string, composing: boolean): Promise<void>;
  readMedia(accountId: string, sourceId: string): Promise<Uint8Array>;
}
export const DeliveryObservationSchema = z.strictObject({
  channelMessageId: z.string().min(1),
  chatAddress: z.string().nullable(),
  status: z.string().min(1),
});
export type DeliveryObservation = Readonly<z.infer<typeof DeliveryObservationSchema>>;
