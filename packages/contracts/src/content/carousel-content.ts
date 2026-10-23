import { z } from "zod";
import { CarouselCardSchema, InboundCarouselCardSchema } from "./carousel-card.ts";
import { hasUniqueChoiceIds } from "./choice.ts";

export const CarouselContentSchema = z.strictObject({
  contentKind: z.literal("CAROUSEL"),
  text: z.string().min(1),
  cards: z.array(CarouselCardSchema).min(1),
}).refine((content) => hasUniqueChoiceIds(content.cards.flatMap((card) => card.choices)), {
  message: "Choice IDs must be unique across all cards.",
  path: ["cards"],
}).describe(
  "Ordered image cards with message-wide unique choice IDs. Provider-specific client limitations are documented separately.",
);

export type CarouselContent = z.infer<typeof CarouselContentSchema>;

export const InboundCarouselContentSchema = z.strictObject({
  ...CarouselContentSchema.shape,
  cards: z.array(InboundCarouselCardSchema).min(1),
}).refine((content) => hasUniqueChoiceIds(content.cards.flatMap((card) => card.choices)), {
  message: "Choice IDs must be unique across all cards.",
  path: ["cards"],
}).describe(
  "Ordered incoming image cards; media may be sources or stored references. Choice IDs remain unique across the message.",
);

export type InboundCarouselContent = z.infer<typeof InboundCarouselContentSchema>;
