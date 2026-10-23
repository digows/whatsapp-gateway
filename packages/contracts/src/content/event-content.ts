import { z } from "zod";

export const EventContentSchema = z.strictObject({
  contentKind: z.literal("EVENT"),
  title: z.string().min(1),
  description: z.string().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  location: z.string().min(1).optional(),
}).refine((event) => event.endsAt === undefined || Date.parse(event.endsAt) >= Date.parse(event.startsAt), {
  message: "Event end cannot precede its start.",
  path: ["endsAt"],
}).describe(
  "Event endsAt cannot precede startsAt, comparing instants across offsets. Event replies are outside this contract.",
);

export type EventContent = z.infer<typeof EventContentSchema>;
