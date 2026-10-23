import { z } from "zod";
import { MediaReferenceSchema } from "./media-reference.ts";
import { MediaSourceSchema } from "./media-source.ts";

export const InboundMediaSchema = z.union([MediaSourceSchema, MediaReferenceSchema])
  .describe(
    "Unmaterialized media source, or a real stored reference retained for persisted inbound compatibility.",
  );

export type InboundMedia = z.infer<typeof InboundMediaSchema>;
