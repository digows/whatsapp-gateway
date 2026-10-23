import { z } from "zod";
import { MessageTargetSchema } from "./message-reference.ts";

export const EditContentSchema = z.strictObject({
  contentKind: z.literal("EDIT"),
  target: MessageTargetSchema,
  text: z.string().min(1),
});

export type EditContent = z.infer<typeof EditContentSchema>;
