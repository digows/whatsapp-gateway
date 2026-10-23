import type { Account, OutboundMessage } from "@digows/whatsapp-gateway-contracts";
import type { ConnectionEvents, WhatsAppConnection } from "../../src/domain/connection.ts";
import type { PreparedWhatsAppSend } from "../../src/infrastructure/baileys/baileys-outbound-content.ts";
export class ControlledConnection implements WhatsAppConnection
{
  readonly sent: PreparedWhatsAppSend[] = [];
  readonly typing: boolean[] = [];
  failSend = false;
  async start(_account: Account, events: ConnectionEvents): Promise<void>
  {
    await events.state("CONNECTED", "100@s.whatsapp.net");
  }
  async prepare(message: OutboundMessage, _index: number, id: string): Promise<PreparedWhatsAppSend>
  {
    return {
      content: { text: "text" in message ? message.text ?? "" : "fixture" },
      options: { messageId: id },
    };
  }
  async send(_recipient: string, prepared: PreparedWhatsAppSend): Promise<void>
  {
    this.sent.push(prepared);
    if (this.failSend) throw new Error("Ambiguous transport timeout");
  }
  async presence(_chat: string, composing: boolean): Promise<void>
  {
    this.typing.push(composing);
  }
  async stop(): Promise<void>
  {}
}
