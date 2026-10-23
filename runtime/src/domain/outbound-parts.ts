import type { OutboundMessage } from "@digows/whatsapp-gateway-contracts";

export function outboundPartCount(message: OutboundMessage): number
{
  return message.contentKind === "ALBUM" ? message.parts.length + 1 : 1;
}

export function outboundPartId(message: OutboundMessage, partIndex: number): string
{
  return partIndex === 0
    ? message.idempotencyKey
    : `${message.idempotencyKey}:album:${String(partIndex - 1)}`;
}
