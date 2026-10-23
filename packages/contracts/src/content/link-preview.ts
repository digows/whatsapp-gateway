import { z } from "zod";
import { InboundMediaSchema } from "./inbound-media.ts";
import { MediaReferenceSchema } from "./media-reference.ts";

export const HttpUrlSchema = z.url().regex(/^[hH][tT][tT][pP][sS]?:\/\//)
  .describe("Absolute HTTP or HTTPS URL.");

export const LinkPreviewSchema = z.strictObject({
  url: HttpUrlSchema,
  title: z.string().min(1),
  description: z.string(),
  thumbnail: MediaReferenceSchema,
});

export type LinkPreview = z.infer<typeof LinkPreviewSchema>;

export const InboundLinkPreviewSchema = z.strictObject({
  url: HttpUrlSchema.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  thumbnail: InboundMediaSchema.optional(),
});
export type InboundLinkPreview = z.infer<typeof InboundLinkPreviewSchema>;
