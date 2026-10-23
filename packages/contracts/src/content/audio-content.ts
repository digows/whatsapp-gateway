import { z } from "zod";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const AudioContentSchema = z.strictObject({
  contentKind: z.literal("AUDIO"),
  media: MediaReferenceSchema,
  presentation: z.enum(["AUDIO", "VOICE_NOTE"]),
});

export type AudioContent = z.infer<typeof AudioContentSchema>;

export const InboundAudioContentSchema = AudioContentSchema.extend({ media: InboundMediaSchema });
export type InboundAudioContent = z.infer<typeof InboundAudioContentSchema>;
