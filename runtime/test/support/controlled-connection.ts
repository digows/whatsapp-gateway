import type { Account, ContactRegistration, OutboundMessage } from "@digows/whatsapp-gateway-contracts";
import type { ConnectionEvents, WhatsAppConnection } from "../../src/domain/connection.ts";
import type { PreparedWhatsAppSend } from "../../src/domain/connection.ts";
export class ControlledConnection implements WhatsAppConnection
{
  events!: ConnectionEvents;
  readonly sent: PreparedWhatsAppSend[] = [];
  readonly typing: boolean[] = [];
  failSend = false;
  async start(_account: Account, events: ConnectionEvents): Promise<void>
  {
    this.events = events;
    await events.state("CONNECTED", "100@s.whatsapp.net");
  }
  async prepare(message: OutboundMessage, _index: number, id: string): Promise<PreparedWhatsAppSend>
  {
    return {
      recipientAddress: message.recipientAddress,
      content: { text: "text" in message ? message.text ?? "" : "fixture" },
      options: { messageId: id },
    };
  }
  async send(prepared: PreparedWhatsAppSend): Promise<void>
  {
    this.sent.push(prepared);
    if (this.failSend) throw new Error("Ambiguous transport timeout");
  }
  async lookupContactAddress(): Promise<ContactRegistration>
  {
    throw new Error("Registration fixture is not configured");
  }
  async presence(_chat: string, composing: boolean): Promise<void>
  {
    this.typing.push(composing);
  }
  async stop(): Promise<void>
  {}
}
