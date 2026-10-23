import { z } from "zod";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const FileContentSchema = z.strictObject({
  contentKind: z.literal("FILE"),
  media: MediaReferenceSchema,
  caption: z.string().optional(),
});

export type FileContent = z.infer<typeof FileContentSchema>;

export const InboundFileContentSchema = FileContentSchema.extend({ media: InboundMediaSchema });
export type InboundFileContent = z.infer<typeof InboundFileContentSchema>;
