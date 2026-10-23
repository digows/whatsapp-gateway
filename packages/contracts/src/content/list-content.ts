import { z } from "zod";
import { hasUniqueChoiceIds } from "./choice.ts";
import { ListSectionSchema } from "./list-section.ts";

export const ListContentSchema = z.strictObject({
  contentKind: z.literal("LIST"),
  title: z.string().min(1),
  description: z.string().min(1),
  openingLabel: z.string().min(1),
  footer: z.string().optional(),
  sections: z.array(ListSectionSchema).min(1),
}).refine((content) => hasUniqueChoiceIds(content.sections.flatMap((section) => section.rows)), {
  message: "Row IDs must be unique across all sections.",
  path: ["sections"],
}).describe("Ordered sections; row IDs are unique across the entire message.");

export type ListContent = z.infer<typeof ListContentSchema>;
