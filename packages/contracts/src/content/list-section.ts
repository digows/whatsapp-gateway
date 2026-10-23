import { z } from "zod";
import { ChoiceSchema } from "./choice.ts";

export const ListRowSchema = ChoiceSchema.extend({ description: z.string().optional() });
export type ListRow = z.infer<typeof ListRowSchema>;

export const ListSectionSchema = z.strictObject({
  title: z.string().min(1),
  rows: z.array(ListRowSchema).min(1),
});
export type ListSection = z.infer<typeof ListSectionSchema>;
