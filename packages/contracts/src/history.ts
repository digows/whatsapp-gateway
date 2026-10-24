import { z } from "zod";
import { InboundMessageSchema } from "./content/inbound-message.ts";
import { AccountScopeSchema } from "./gateway.ts";
export const GatewayObservedMessageSchema = AccountScopeSchema.extend({
  direction: z.enum(["INBOUND", "OUTBOUND"]),
  message: InboundMessageSchema,
  observedAt: z.iso.datetime({ offset: true }),
  timestampSource: z.enum(["PROVIDER", "GATEWAY_OBSERVATION"]),
  edited: z.boolean(),
  deleted: z.boolean(),
});
export type GatewayObservedMessage = z.infer<typeof GatewayObservedMessageSchema>;
export const GatewayHistoryRequestSchema = AccountScopeSchema.extend({
  apiVersion: z.literal("1"),
  chatAddress: z.string().min(1).max(512),
  direction: z.enum(["forward", "backward"]).default("backward"),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().positive().max(100).default(50),
});
export type GatewayHistoryRequest = z.infer<typeof GatewayHistoryRequestSchema>;
export const GatewayHistoryPageSchema = AccountScopeSchema.extend({
  apiVersion: z.literal("1"),
  chatAddress: z.string().min(1),
  coverage: z.literal("GATEWAY_OBSERVED"),
  messages: z.array(GatewayObservedMessageSchema),
  nextCursor: z.string().nullable(),
}).superRefine((page, context) =>
{
  if (
    page.messages.some(message =>
      message.workspaceId !== page.workspaceId || message.accountId !== page.accountId
      || message.message.chatAddress !== page.chatAddress
    )
  )
  {
    context.addIssue({ code: "custom", message: "History page identity mismatch" });
  }
});
export type GatewayHistoryPage = z.infer<typeof GatewayHistoryPageSchema>;
export const GatewayMessageRequestSchema = AccountScopeSchema.extend({
  apiVersion: z.literal("1"),
  chatAddress: z.string().min(1).max(512),
  messageId: z.string().min(1).max(512),
});
export type GatewayMessageRequest = z.infer<typeof GatewayMessageRequestSchema>;
