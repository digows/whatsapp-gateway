import { z } from "zod";
import { ChoiceSchema, hasUniqueChoiceIds } from "./choice.ts";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const CarouselCardSchema = z.strictObject({
  image: MediaReferenceSchema,
  title: z.string().min(1),
  text: z.string().min(1),
  footer: z.string().optional(),
  choices: z.array(ChoiceSchema).min(1),
}).refine((card) => hasUniqueChoiceIds(card.choices), {
  message: "Choice IDs must be unique.",
  path: ["choices"],
});

export type CarouselCard = z.infer<typeof CarouselCardSchema>;

export const InboundCarouselCardSchema = z.strictObject({
  ...CarouselCardSchema.shape,
  image: InboundMediaSchema,
}).refine((card) => hasUniqueChoiceIds(card.choices), {
  message: "Choice IDs must be unique.",
  path: ["choices"],
});

export type InboundCarouselCard = z.infer<typeof InboundCarouselCardSchema>;
