import { z } from "zod";
import { MediaReferenceSchema } from "./media-reference.ts";

export const MediaSourceSchema = z.strictObject({
  sourceId: z.string().min(1).describe(
    "Opaque channel-owned identifier for one media part; encoding stays private to the provider.",
  ),
  contentType: MediaReferenceSchema.shape.contentType,
  byteSize: MediaReferenceSchema.shape.byteSize.optional().describe(
    "Declared source size when supplied; not verified stored bytes.",
  ),
  fileName: MediaReferenceSchema.shape.fileName,
}).describe("Media not yet materialized. No storage key, provider URL, credentials or encryption material.");

export type MediaSource = z.infer<typeof MediaSourceSchema>;
