import { z } from "zod";

export const PollContentSchema = z.strictObject({
  contentKind: z.literal("POLL"),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
  selectionCount: z.int().positive(),
}).refine((poll) => poll.selectionCount <= poll.options.length, {
  message: "Selection count cannot exceed available options.",
  path: ["selectionCount"],
}).describe("Poll selectionCount is between one and the number of options. Votes are outside this contract.");

export type PollContent = z.infer<typeof PollContentSchema>;
