import { z } from "zod";
import { LocationSchema } from "./location.ts";

export const LocationContentSchema = z.strictObject({
  contentKind: z.literal("LOCATION"),
  location: LocationSchema,
});

export type LocationContent = z.infer<typeof LocationContentSchema>;
