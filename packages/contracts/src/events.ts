import { z } from "zod";
import { GatewayCommandResultSchema } from "./commands.ts";
import { InboundMessageSchema } from "./content/inbound-message.ts";
import { DesiredAccountSchema } from "./desired-account.ts";
import {
  AccountSchema,
  AccountScopeSchema,
  DeliveryObservationSchema,
  GatewayIdentifierSchema,
  OperationResultSchema,
} from "./gateway.ts";
import { GatewayStreamReceiptSchema } from "./streams.ts";
const messageData = AccountScopeSchema.extend({ message: InboundMessageSchema });
const receiptData = AccountScopeSchema.extend(DeliveryObservationSchema.shape);
const rejectionData = AccountScopeSchema.extend({ errorName: z.string().min(1) });
export const GatewayEventPayloadSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("com.digows.whatsapp.ingress.receipt.v1"),
    data: GatewayStreamReceiptSchema,
  }),
  z.strictObject({ type: z.literal("com.digows.whatsapp.account.updated.v1"), data: AccountSchema }),
  z.strictObject({ type: z.literal("com.digows.whatsapp.account.desired.v1"), data: DesiredAccountSchema }),
  z.strictObject({ type: z.literal("com.digows.whatsapp.message.received.v1"), data: messageData }),
  z.strictObject({ type: z.literal("com.digows.whatsapp.message.delivery.v1"), data: receiptData }),
  z.strictObject({ type: z.literal("com.digows.whatsapp.message.rejected.v1"), data: rejectionData }),
  z.strictObject({
    type: z.literal("com.digows.whatsapp.operation.updated.v1"),
    data: OperationResultSchema,
  }),
  z.strictObject({
    type: z.literal("com.digows.whatsapp.command.updated.v1"),
    data: GatewayCommandResultSchema,
  }),
]);
export type GatewayEventPayload = z.infer<typeof GatewayEventPayloadSchema>;
const cloudEventFields = {
  specversion: z.literal("1.0"),
  id: GatewayIdentifierSchema,
  source: z.literal("urn:digows:whatsapp-gateway"),
  subject: z.string().min(1),
  time: z.iso.datetime({ offset: true }),
  datacontenttype: z.literal("application/json"),
  workspaceid: GatewayIdentifierSchema,
  accountid: GatewayIdentifierSchema,
  sequence: z.number().int().positive().max(2147483647),
};
export const GatewayCloudEventSchema = z.discriminatedUnion("type", [
  GatewayEventPayloadSchema.options[0].extend(cloudEventFields),
  ...GatewayEventPayloadSchema.options.slice(1).map(schema => schema.extend(cloudEventFields)),
])
  .superRefine((event, context) =>
  {
    if (
      event.data.workspaceId !== event.workspaceid || event.data.accountId !== event.accountid
      || event.subject !== `accounts/${event.accountid}`
    )
    {
      context.addIssue({ code: "custom", message: "CloudEvent account identity mismatch" });
    }
  });
export type GatewayCloudEvent = z.infer<typeof GatewayCloudEventSchema>;
