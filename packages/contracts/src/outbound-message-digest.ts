import type { OutboundMessage } from "./content/outbound-message.ts";

/** Stable JSON representation used by the gateway's existing payload fingerprints. */
export function canonicalGatewayJson(value: unknown): string
{
  if (Array.isArray(value)) return `[${value.map(canonicalGatewayJson).join(",")}]`;
  if (value !== null && typeof value === "object")
  {
    return `{${
      Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      ).map(([key, item]) => `${JSON.stringify(key)}:${canonicalGatewayJson(item)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/** Hash the exact validated wire message; compare scope and operation key separately. */
export async function outboundMessageDigest(message: OutboundMessage): Promise<string>
{
  const bytes = new TextEncoder().encode(canonicalGatewayJson(message));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
