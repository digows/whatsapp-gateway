import { z } from "zod";
import { MessageTargetSchema } from "./message-reference.ts";

export const DeleteContentSchema = z.strictObject({
  contentKind: z.literal("DELETE"),
  target: MessageTargetSchema,
});

export type DeleteContent = z.infer<typeof DeleteContentSchema>;
