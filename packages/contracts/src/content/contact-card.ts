import { z } from "zod";

export const ContactCardSchema = z.strictObject({
  displayName: z.string().min(1),
  vcard: z.string().regex(/^BEGIN:VCARD\r?\n[\s\S]+\r?\nEND:VCARD(?:\r?\n)?$/)
    .describe("Standard vCard content, preserved without provider-specific fields."),
});

export type ContactCard = z.infer<typeof ContactCardSchema>;
