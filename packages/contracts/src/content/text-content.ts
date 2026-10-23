import { z } from "zod";
import { InboundLinkPreviewSchema, LinkPreviewSchema } from "./link-preview.ts";

export const TextContentSchema = z.strictObject({
  contentKind: z.literal("TEXT"),
  text: z.string(),
  linkPreview: LinkPreviewSchema.optional(),
}).describe(
  "Text preserves its original formatting. Empty received text remains valid; outbound text must be nonempty.",
);

export type TextContent = z.infer<typeof TextContentSchema>;

export const InboundTextContentSchema = TextContentSchema.extend({
  linkPreview: InboundLinkPreviewSchema.optional(),
});
export type InboundTextContent = z.infer<typeof InboundTextContentSchema>;
