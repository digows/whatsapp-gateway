import type { AnyMessageContent, AuthenticationState, MiscMessageGenerationOptions, WASocket } from "baileys";
import { EventEmitter } from "node:events";
import type { SocketConfiguration } from "../../src/infrastructure/baileys/baileys-connection.ts";
export interface SentNative
{
  readonly recipient: string;
  readonly content: AnyMessageContent;
  readonly options: MiscMessageGenerationOptions | undefined;
}
export class NativeSocketFixture
{
  readonly events = new EventEmitter();
  readonly transport = new EventEmitter();
  readonly sent: SentNative[] = [];
  readonly authentication: AuthenticationState;
  closed = false;
  readonly socket: WASocket;
  constructor(configuration: SocketConfiguration)
  {
    this.authentication = configuration.auth;
    const fixture = this;
    this.socket = {
      ev: {
        on: (event: string, listener: (data: unknown) => void) =>
        {
          this.events.on(event, listener);
        },
      },
      ws: {
        get isClosed()
        {
          return fixture.closed;
        },
        once: (event: string, listener: () => void) => this.transport.once(event, listener),
        removeListener: (event: string, listener: () => void) =>
          this.transport.removeListener(event, listener),
        close: async () => this.close(),
      },
      end: () => this.close(),
      sendPresenceUpdate: async () => undefined,
      onWhatsApp: async (...values: string[]) =>
        values.map(value => ({ exists: true, jid: `${value}@s.whatsapp.net` })),
      signalRepository: { lidMapping: { getPNForLID: async () => undefined } },
      sendMessage: async (
        recipient: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions,
      ) =>
      {
        this.sent.push({ recipient, content, options });
        return { key: { id: options?.messageId, remoteJid: recipient, fromMe: true } };
      },
    } as unknown as WASocket;
  }
  close(): void
  {
    this.closed = true;
    this.transport.emit("close");
  }
  pair(id = "100@s.whatsapp.net"): void
  {
    this.authentication.creds.me = { id };
    this.authentication.creds.registered = false;
    this.events.emit("creds.update", {});
  }
  update(connection: "open" | "close", code?: number): void
  {
    this.events.emit("connection.update", {
      connection,
      ...(code === undefined ? {} : { lastDisconnect: { error: { output: { statusCode: code } } } }),
    });
  }
}
