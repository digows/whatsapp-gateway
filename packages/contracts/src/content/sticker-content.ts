import { z } from "zod";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const StickerContentSchema = z.strictObject({
  contentKind: z.literal("STICKER"),
  media: MediaReferenceSchema,
  presentation: z.enum(["STATIC", "ANIMATED"]),
});

export type StickerContent = z.infer<typeof StickerContentSchema>;

export const InboundStickerContentSchema = StickerContentSchema.extend({ media: InboundMediaSchema });
export type InboundStickerContent = z.infer<typeof InboundStickerContentSchema>;
