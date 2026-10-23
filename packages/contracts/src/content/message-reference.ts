import { z } from "zod";

export const MessageReferenceSchema = z.strictObject({
  channelMessageId: z.string().min(1),
  senderAddress: z.string().min(1).optional(),
  chatAddress: z.string().min(1).optional(),
}).describe(
  "Reference to a native message known to the provider; include sender/chat when needed to resolve it.",
);

export type MessageReference = z.infer<typeof MessageReferenceSchema>;

export const MessageTargetSchema = MessageReferenceSchema.extend({
  senderAddress: z.string().min(1),
  chatAddress: z.string().min(1),
}).describe("Action target with its native message ID, original sender and chat correlation.");

export type MessageTarget = z.infer<typeof MessageTargetSchema>;
