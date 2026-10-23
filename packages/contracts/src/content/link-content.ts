import { z } from "zod";
import { HttpUrlSchema } from "./link-preview.ts";

export const LinkContentSchema = z.strictObject({
  contentKind: z.literal("LINK"),
  text: z.string().min(1),
  label: z.string().min(1),
  url: HttpUrlSchema,
}).describe("HTTP(S) navigation action; navigation does not produce a selection callback.");

export type LinkContent = z.infer<typeof LinkContentSchema>;
