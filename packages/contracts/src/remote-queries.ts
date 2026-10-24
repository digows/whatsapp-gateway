import { z } from "zod";
import { GatewayRequestIdentitySchema } from "./commands.ts";
import { MediaReferenceSchema } from "./content/media-reference.ts";
import { AccountSchema, OperationResultSchema } from "./gateway.ts";
import {
  GatewayHistoryPageSchema,
  GatewayHistoryRequestSchema,
  GatewayObservedMessageSchema,
} from "./history.ts";
export const GatewayMediaBytesSchema = z.strictObject({
  encoding: z.literal("base64"),
  bytes: z.string().max(357913944),
  byteSize: z.number().int().nonnegative().max(256 * 1024 * 1024),
}).superRefine((media, context) =>
{
  if (
    media.bytes.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(media.bytes)
    || media.bytes.length / 4 * 3 - (media.bytes.endsWith("==") ? 2 : media.bytes.endsWith("=") ? 1 : 0)
      !== media.byteSize
  )
  {
    context.addIssue({ code: "custom", message: "Media encoding mismatch" });
  }
});
const fields = { ...GatewayRequestIdentitySchema.shape, apiVersion: z.literal("1") };
export const GatewayMediaUploadSchema = z.strictObject({
  ...fields,
  type: z.literal("media.upload"),
  contentType: z.string().min(1).max(256),
  fileName: z.string().min(1).max(512).optional(),
  media: GatewayMediaBytesSchema,
});
export const GatewayMediaUploadResultSchema = z.strictObject({
  ...fields,
  type: z.literal("media.upload"),
  result: MediaReferenceSchema,
});
export type GatewayMediaUploadResult = z.infer<typeof GatewayMediaUploadResultSchema>;
export const GatewayQuerySchema = z.discriminatedUnion("type", [
  z.strictObject({ ...fields, type: z.literal("account.get") }),
  z.strictObject({ ...fields, type: z.literal("media.readStored"), reference: MediaReferenceSchema }),
  z.strictObject({ ...fields, type: z.literal("operation.get"), key: z.string().min(1).max(512) }),
  z.strictObject({ ...GatewayHistoryRequestSchema.shape, ...fields, type: z.literal("history.page") }),
  z.strictObject({
    ...fields,
    type: z.literal("history.message"),
    chatAddress: z.string().min(1).max(512),
    messageId: z.string().min(1).max(512),
  }),
  z.strictObject({ ...fields, type: z.literal("media.read"), sourceId: z.string().min(1).max(16384) }),
]);
export type GatewayQuery = z.infer<typeof GatewayQuerySchema>;
export const GatewayQueryResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...fields, type: z.literal("media.readStored"), result: GatewayMediaBytesSchema }),
  z.strictObject({ ...fields, type: z.literal("account.get"), result: AccountSchema }),
  z.strictObject({ ...fields, type: z.literal("operation.get"), result: OperationResultSchema }),
  z.strictObject({ ...fields, type: z.literal("history.page"), result: GatewayHistoryPageSchema }),
  z.strictObject({
    ...fields,
    type: z.literal("history.message"),
    result: GatewayObservedMessageSchema.nullable(),
  }),
  z.strictObject({
    ...fields,
    type: z.literal("media.read"),
    result: GatewayMediaBytesSchema,
  }),
]).superRefine((response, context) =>
{
  if (
    response.type !== "media.read" && response.type !== "media.readStored" && response.result !== null
    && (response.result.workspaceId !== response.workspaceId
      || response.result.accountId !== response.accountId)
  )
  {
    context.addIssue({ code: "custom", message: "Query response scope mismatch" });
  }
});
export type GatewayQueryResponse = z.infer<typeof GatewayQueryResponseSchema>;
export const GatewayQueryReplySchema = GatewayRequestIdentitySchema.extend({
  apiVersion: z.literal("1"),
  response: z.union([GatewayQueryResponseSchema, GatewayMediaUploadResultSchema]).nullable(),
  failure: z.enum(["UNAVAILABLE", "UNAUTHORIZED_SCOPE"]).nullable(),
}).superRefine((reply, context) =>
{
  if (
    (reply.response === null) === (reply.failure === null)
    || (reply.response !== null && (reply.response.workspaceId !== reply.workspaceId
      || reply.response.accountId !== reply.accountId || reply.response.requestId !== reply.requestId))
  )
  {
    context.addIssue({ code: "custom", message: "Query reply identity or outcome mismatch" });
  }
});
export const GatewayQueryCloudEventSchema = z.strictObject({
  specversion: z.literal("1.0"),
  id: z.uuid(),
  source: z.literal("urn:digows:whatsapp-gateway"),
  type: z.literal("com.digows.whatsapp.query.result.v1"),
  subject: z.string(),
  time: z.iso.datetime({ offset: true }),
  datacontenttype: z.literal("application/json"),
  workspaceid: z.uuid(),
  accountid: z.uuid(),
  data: GatewayQueryReplySchema,
}).superRefine((event, context) =>
{
  if (
    event.workspaceid !== event.data.workspaceId || event.accountid !== event.data.accountId
    || event.subject !== `accounts/${event.accountid}`
  )
  {
    context.addIssue({ code: "custom", message: "Query CloudEvent scope mismatch" });
  }
});
export type GatewayQueryCloudEvent = z.infer<typeof GatewayQueryCloudEventSchema>;
