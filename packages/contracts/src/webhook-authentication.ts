import { z } from "zod";
import { GatewayIdentifierSchema } from "./gateway.ts";
export const GatewayWebhookSignatureSchema = z.strictObject({
  eventId: GatewayIdentifierSchema,
  timestamp: z.string().regex(/^(0|[1-9][0-9]{0,12})$/),
  signature: z.string().regex(/^v1=[a-f0-9]{64}$/),
});
export type GatewayWebhookSignature = z.infer<typeof GatewayWebhookSignatureSchema>;
const signingSecretSchema = z.string().min(32).max(4096);
function signedBytes(eventId: string, timestamp: string, body: Uint8Array): Uint8Array<ArrayBuffer>
{
  const prefix = new TextEncoder().encode(`${timestamp}.${eventId}.`);
  const bytes = new Uint8Array(prefix.byteLength + body.byteLength);
  bytes.set(prefix);
  bytes.set(body, prefix.byteLength);
  return bytes;
}
async function signingKey(secret: string): Promise<CryptoKey>
{
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecretSchema.parse(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signGatewayWebhook(
  secret: string,
  eventId: string,
  timestamp: string,
  body: Uint8Array,
): Promise<GatewayWebhookSignature>
{
  const identity = GatewayIdentifierSchema.parse(eventId);
  const signed = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    signedBytes(identity, timestamp, body),
  );
  const hex = Array.from(new Uint8Array(signed), value => value.toString(16).padStart(2, "0")).join("");
  return GatewayWebhookSignatureSchema.parse({ eventId: identity, timestamp, signature: `v1=${hex}` });
}
/** Verify raw received bytes before parsing; the consumer must also match the parsed envelope ID/scope. */
export async function verifyGatewayWebhook(
  secret: string,
  input: GatewayWebhookSignature,
  body: Uint8Array,
  nowMs = Date.now(),
  maximumSkewMs = 300000,
): Promise<boolean>
{
  const parsed = GatewayWebhookSignatureSchema.safeParse(input);
  if (
    !parsed.success || !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maximumSkewMs)
    || maximumSkewMs < 0
  ) return false;
  const metadata = parsed.data;
  const milliseconds = Number(metadata.timestamp) * 1000;
  if (!Number.isSafeInteger(milliseconds) || Math.abs(nowMs - milliseconds) > maximumSkewMs) return false;
  const signature = Uint8Array.from(
    metadata.signature.slice(3).match(/../g) ?? [],
    value => Number.parseInt(value, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    signature,
    signedBytes(metadata.eventId, metadata.timestamp, body),
  );
}
