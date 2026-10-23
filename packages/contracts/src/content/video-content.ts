import { z } from "zod";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const VideoContentSchema = z.strictObject({
  contentKind: z.literal("VIDEO"),
  media: MediaReferenceSchema,
  caption: z.string().optional(),
  presentation: z.enum(["VIDEO", "ANIMATION", "VIDEO_NOTE"]),
});

export type VideoContent = z.infer<typeof VideoContentSchema>;

export const InboundVideoContentSchema = VideoContentSchema.extend({
  media: InboundMediaSchema,
  albumMessageId: z.string().min(1).optional().describe(
    "Native parent album message ID, only when present on this child.",
  ),
});

export type InboundVideoContent = z.infer<typeof InboundVideoContentSchema>;
