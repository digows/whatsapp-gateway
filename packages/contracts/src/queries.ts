import { z } from "zod";
import { AccountSchema, OperationResultSchema } from "./gateway.ts";
export const GatewayAccountResultSchema = AccountSchema.extend({ apiVersion: z.literal("1") });
export type GatewayAccountResult = z.infer<typeof GatewayAccountResultSchema>;
export const GatewayOperationResultSchema = OperationResultSchema.safeExtend({ apiVersion: z.literal("1") });
export type GatewayOperationResult = z.infer<typeof GatewayOperationResultSchema>;
export const GatewayHttpErrorSchema = z.strictObject({
  apiVersion: z.literal("1"),
  code: z.enum([
    "REQUEST_TIMEOUT",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "INVALID_REQUEST",
    "CONFLICT",
    "NOT_FOUND",
    "UNAVAILABLE",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "METHOD_NOT_ALLOWED",
  ]),
});
export type GatewayHttpError = z.infer<typeof GatewayHttpErrorSchema>;
