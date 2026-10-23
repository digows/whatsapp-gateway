import { z } from "zod";

export const SelectionContentSchema = z.strictObject({
  contentKind: z.literal("SELECTION"),
  optionId: z.string().min(1),
  label: z.string().min(1).optional(),
  originatingChannelMessageId: z.string().min(1),
  optionIndex: z.int().nonnegative().optional(),
  cardIndex: z.int().nonnegative().optional(),
}).describe(
  "Received actual choice and originating native message ID. Indices are present only when captured; no device provenance is inferred.",
);

export type SelectionContent = z.infer<typeof SelectionContentSchema>;
