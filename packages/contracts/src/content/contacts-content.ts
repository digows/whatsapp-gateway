import { z } from "zod";
import { ContactCardSchema } from "./contact-card.ts";

export const ContactsContentSchema = z.strictObject({
  contentKind: z.literal("CONTACTS"),
  contacts: z.array(ContactCardSchema).min(1),
});

export type ContactsContent = z.infer<typeof ContactsContentSchema>;
