import { z } from "zod";
import { ImageContentSchema } from "./image-content.ts";
import { VideoContentSchema } from "./video-content.ts";

export const AlbumPartSchema = z.discriminatedUnion("contentKind", [ImageContentSchema, VideoContentSchema]);
export type AlbumPart = z.infer<typeof AlbumPartSchema>;

export const OutboundAlbumContentSchema = z.strictObject({
  contentKind: z.literal("ALBUM"),
  parts: z.array(AlbumPartSchema).min(1),
}).describe("Ordered image/video parts; providers retain stable part identities when sending.");

export type OutboundAlbumContent = z.infer<typeof OutboundAlbumContentSchema>;

export const InboundAlbumContentSchema = z.strictObject({
  contentKind: z.literal("ALBUM"),
  imageCount: z.int().nonnegative(),
  videoCount: z.int().nonnegative(),
}).describe(
  "Incoming parent announcement. Declared image/video counts are not proof of receipt or completion; children arrive independently.",
);

export type InboundAlbumContent = z.infer<typeof InboundAlbumContentSchema>;
