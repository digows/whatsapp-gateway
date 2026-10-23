import { z } from "zod";
import { ChoiceSchema, hasUniqueChoiceIds } from "./choice.ts";

export const ButtonsContentSchema = z.strictObject({
  contentKind: z.literal("BUTTONS"),
  text: z.string().min(1),
  footer: z.string().optional(),
  choices: z.array(ChoiceSchema).min(1),
}).refine((content) => hasUniqueChoiceIds(content.choices), {
  message: "Choice IDs must be unique.",
  path: ["choices"],
}).describe("Reply choices have IDs unique within the message.");

export type ButtonsContent = z.infer<typeof ButtonsContentSchema>;
