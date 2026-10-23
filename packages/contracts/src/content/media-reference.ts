import { z } from "zod";

export const MediaReferenceSchema = z.strictObject({
  storageKey: z.string().min(1).describe(
    "Key in the configured private media bucket; no credentials or signed URL.",
  ),
  contentType: z.string().min(1),
  byteSize: z.int().nonnegative(),
  fileName: z.string().min(1).optional(),
});

export type MediaReference = z.infer<typeof MediaReferenceSchema>;
