import { z } from "zod";

export const ChoiceSchema = z.strictObject({ id: z.string().min(1), label: z.string().min(1) });
export type Choice = z.infer<typeof ChoiceSchema>;

export function hasUniqueChoiceIds(choices: readonly Choice[]): boolean
{
  return new Set(choices.map((choice) => choice.id)).size === choices.length;
}
