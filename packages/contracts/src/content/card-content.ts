import { z } from "zod";
import { ChoiceSchema, hasUniqueChoiceIds } from "./choice.ts";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const CardContentSchema = z.strictObject({
  contentKind: z.literal("CARD"),
  image: MediaReferenceSchema,
  text: z.string().min(1),
  footer: z.string().optional(),
  choices: z.array(ChoiceSchema).min(1),
}).refine((content) => hasUniqueChoiceIds(content.choices), {
  message: "Choice IDs must be unique.",
  path: ["choices"],
}).describe("An image reply card; choice IDs are unique within the message.");

export type CardContent = z.infer<typeof CardContentSchema>;

export const InboundCardContentSchema = z.strictObject({
  ...CardContentSchema.shape,
  image: InboundMediaSchema,
}).refine((content) => hasUniqueChoiceIds(content.choices), {
  message: "Choice IDs must be unique.",
  path: ["choices"],
}).describe(
  "An incoming image reply card; image may be a source or an existing stored reference, with unique choice IDs.",
);

export type InboundCardContent = z.infer<typeof InboundCardContentSchema>;
