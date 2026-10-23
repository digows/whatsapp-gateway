import { z } from "zod";
import { MessageReferenceSchema } from "./message-reference.ts";

export const MessageContextSchema = z.strictObject({
  quotedMessage: MessageReferenceSchema.optional(),
  forwarded: z.boolean().optional(),
  mentionedAddresses: z.array(z.string().min(1)).optional(),
  lifetimeSeconds: z.int().positive().optional().describe(
    "Requested disappearing-message lifetime; delivery does not prove expiration.",
  ),
});

export type MessageContext = z.infer<typeof MessageContextSchema>;
