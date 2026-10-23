import { z } from "zod";

export const LocationSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
});

export type Location = z.infer<typeof LocationSchema>;
