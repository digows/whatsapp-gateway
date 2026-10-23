import type {
  Account,
  DeliveryObservation,
  InboundMessage,
  OutboundMessage,
  SessionState,
} from "@digows/whatsapp-gateway-contracts";
import type { PreparedWhatsAppSend } from "../infrastructure/baileys/baileys-outbound-content.ts";

export interface ConnectionEvents
{
  state(state: SessionState, nativeJid?: string, qr?: string): Promise<void>;
  receipt(observation: DeliveryObservation): Promise<void>;
  received(message: InboundMessage, native: string): Promise<void>;
}
export interface WhatsAppConnection
{
  start(account: Account, events: ConnectionEvents): Promise<void>;
  prepare(message: OutboundMessage, index: number, nativeId: string): Promise<PreparedWhatsAppSend>;
  send(recipient: string, prepared: PreparedWhatsAppSend): Promise<void>;
  presence(chat: string, composing: boolean): Promise<void>;
  stop(): Promise<void>;
}
export type ConnectionFactory = (account: Account) => WhatsAppConnection;
