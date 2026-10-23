import { z } from "zod";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const ImageContentSchema = z.strictObject({
  contentKind: z.literal("IMAGE"),
  media: MediaReferenceSchema,
  caption: z.string().optional(),
});

export type ImageContent = z.infer<typeof ImageContentSchema>;

export const InboundImageContentSchema = ImageContentSchema.extend({
  media: InboundMediaSchema,
  albumMessageId: z.string().min(1).optional().describe(
    "Native parent album message ID, only when present on this child.",
  ),
});

export type InboundImageContent = z.infer<typeof InboundImageContentSchema>;
