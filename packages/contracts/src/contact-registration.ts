import { z } from "zod";
import { AccountScopeSchema } from "./gateway.ts";
const ContactAddressSchema = AccountScopeSchema.extend({ address: z.string().min(1).max(512) });
export const ContactRegistrationReasonSchema = z.enum([
  "UNSUPPORTED_ADDRESS",
  "UNAVAILABLE",
  "INCOMPLETE_RESPONSE",
  "TIMEOUT",
  "OWNERSHIP_CHANGED",
]);
export type ContactRegistrationReason = z.infer<typeof ContactRegistrationReasonSchema>;
export const ContactRegistrationSchema = z.discriminatedUnion("status", [
  ContactAddressSchema.extend({ status: z.literal("REGISTERED"), resolvedAddress: z.string().min(1) }),
  ContactAddressSchema.extend({ status: z.literal("UNREGISTERED") }),
  ContactAddressSchema.extend({
    status: z.literal("INDETERMINATE"),
    reason: ContactRegistrationReasonSchema,
  }),
]);
export type ContactRegistration = z.infer<typeof ContactRegistrationSchema>;
