import { z } from "zod";
import { MessageTargetSchema } from "./message-reference.ts";

export const ReactionContentSchema = z.strictObject({
  contentKind: z.literal("REACTION"),
  target: MessageTargetSchema,
  emoji: z.string().describe("Empty removes the current sender reaction from the target."),
});

export type ReactionContent = z.infer<typeof ReactionContentSchema>;

export const InboundReactionContentSchema = ReactionContentSchema.extend({
  emoji: z.string().describe("An empty received emoji removes the sender's reaction from the target."),
});

export type InboundReactionContent = z.infer<typeof InboundReactionContentSchema>;
