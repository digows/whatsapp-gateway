import type { OutboundMessage } from "@digows/whatsapp-gateway-contracts";
export interface AcceptedOutboundPart
{
  readonly message: OutboundMessage;
  readonly chatAddress: string;
  readonly index: number;
  readonly occurredAt?: string;
  readonly native: string | null;
}
export interface WhatsAppSendReceipt
{
  readonly native: string | null;
  readonly occurredAt?: string;
}
