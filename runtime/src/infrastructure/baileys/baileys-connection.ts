import {
  type Account,
  type ContactRegistration,
  type InboundMessage,
  InboundMessageSchema,
  type MessageReference,
  type OutboundMessage,
} from "@digows/whatsapp-gateway-contracts";
import makeWASocket, {
  type AuthenticationState,
  BufferJSON,
  DisconnectReason,
  isJidBroadcast,
  isJidNewsletter,
  jidNormalizedUser,
  proto,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import pino, { type Logger } from "pino";
import QRCode from "qrcode";
import type { WhatsAppSendReceipt } from "../../domain/accepted-outbound-part.ts";
import type { ConnectionEvents, PreparedWhatsAppSend, WhatsAppConnection } from "../../domain/connection.ts";
import { describeWhatsAppError } from "../../domain/error-details.ts";
import { type AccountLease, type GatewayStore } from "../../domain/gateway-store.ts";
import type { IMediaRepository } from "../../domain/media-storage.ts";
import { BaileysAuthenticationStore } from "./baileys-authentication-store.ts";
import { lookupNativeContact } from "./baileys-contact-registration.ts";
import {
  BaileysInboundContent,
  type InboundContentContext,
  inboundMessageContext,
} from "./baileys-inbound-content.ts";
import { BaileysMessageCache } from "./baileys-message-cache.ts";
import { prepareOutboundContent } from "./baileys-outbound-content.ts";
import { closeBaileysSocket, withBaileysTimeout } from "./baileys-socket-lifecycle.ts";
import { BaileysProtocolLogger } from "./protocol-logger.ts";
export type SocketConfiguration = Parameters<typeof makeWASocket>[0];
export type SocketFactory = (configuration: SocketConfiguration) => WASocket;
export class BaileysConnection implements WhatsAppConnection
{
  private socket: WASocket | null = null;
  private authentication: AuthenticationState | null = null;
  private readonly authenticationStore: BaileysAuthenticationStore;
  private readonly cache = new BaileysMessageCache();
  private account: Account | undefined;
  private events: ConnectionEvents | undefined;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private stopped = true;
  private abort = new AbortController();
  private stopping: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pairingTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectStartedAt: number | undefined;
  private retry = 0;
  private pairingDeadline = 0;
  constructor(
    private readonly store: GatewayStore,
    private readonly lease: AccountLease,
    private readonly media: IMediaRepository | null = null,
    private readonly factory: SocketFactory = makeWASocket,
    private readonly pairingTimeoutMs = 30000,
    private readonly registrationTimeoutMs = 10000,
    private readonly logger: Logger = pino(),
  )
  {
    if (
      !Number.isSafeInteger(registrationTimeoutMs) || registrationTimeoutMs < 1
      || registrationTimeoutMs > 60000
    ) throw new Error("Registration timeout is invalid");
    this.authenticationStore = new BaileysAuthenticationStore(lease.accountId, {
      readAuthentication: (accountId, category, key) => store.readAuthentication(accountId, category, key),
      writeAuthentication: async (accountId, mutations) =>
      {
        if (accountId !== lease.accountId) throw new Error("Authentication scope mismatch");
        await store.writeAuthentication(lease, mutations);
      },
      clearAuthentication: async (accountId) =>
      {
        if (accountId !== lease.accountId) throw new Error("Authentication scope mismatch");
        await store.clearAuthentication(lease);
      },
    });
  }
  async start(account: Account, events: ConnectionEvents): Promise<void>
  {
    if (!this.stopped) throw new Error("Connection is already started");
    this.abort = new AbortController();
    this.account = account;
    this.events = events;
    this.stopped = false;
    this.failure = undefined;
    this.stopping = undefined;
    this.authentication = await this.authenticationStore.load();
    this.logger.info({ event: "socket_starting", paired: Boolean(this.authentication.creds.me) });
    this.pairingDeadline = Date.now() + this.pairingTimeoutMs;
    await events.state("CONNECTING");
    this.createSocket();
  }
  private createSocket(): void
  {
    if (this.stopped || !this.lease.alive || !this.authentication) return;
    const socket = this.factory({
      auth: this.authentication,
      logger: new BaileysProtocolLogger(this.logger, () => this.stopped),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      getMessage: async key => this.cache.read(key),
    });
    this.socket = socket;
    if (!this.authentication.creds.me)
    {
      this.pairingTimer = setTimeout(() =>
      {
        enqueue(() => this.expirePairing(socket));
      }, Math.max(1, this.pairingDeadline - Date.now()));
      this.pairingTimer.unref();
    }
    const enqueue = (work: () => Promise<void>): void =>
    {
      this.queue = this.queue.then(async () =>
      {
        if (this.socket !== socket || this.stopped || !this.lease.alive) return;
        await work();
      }).catch(async error =>
      {
        this.logger.error({ event: "socket_event_failed", failure: describeWhatsAppError(error) });
        this.failure = error;
        this.stopped = true;
        clearTimeout(this.timer);
        clearTimeout(this.pairingTimer);
        await this.events?.state("FAILED").catch(() => undefined);
        const current = this.socket;
        this.socket = null;
        if (current) await closeBaileysSocket(current, 15000).catch(() => undefined);
      });
    };
    socket.ev.on("creds.update", () =>
      enqueue(async () =>
      {
        await this.authenticationStore.saveCredentials();
        this.logger.debug({ event: "credentials_persisted", paired: Boolean(this.authentication?.creds.me) });
      }));
    socket.ev.on("connection.update", update =>
      enqueue(async () =>
      {
        this.logger.debug({
          event: "socket_connection_update",
          connection: update.connection,
          qrAvailable: Boolean(update.qr),
          paired: Boolean(this.authentication?.creds.me),
        });
        if (update.qr)
        {
          await this.events?.state("AWAITING_PAIRING", undefined, await QRCode.toDataURL(update.qr));
        }
        if (update.connection === "open")
        {
          clearTimeout(this.pairingTimer);
          this.retry = 0;
          this.reconnectStartedAt = undefined;
          const id = this.authentication?.creds.me?.id;
          if (!id) throw new Error("Connected WhatsApp identity unavailable");
          await this.authenticationStore.saveCredentials();
          await this.events?.state("CONNECTED", jidNormalizedUser(id));
        }
        if (update.connection === "close")
        {
          clearTimeout(this.pairingTimer);
          await this.authenticationStore.flush();
          const error = update.lastDisconnect?.error;
          const code = disconnectCode(error);
          const paired = Boolean(this.authentication?.creds.me);
          this.logger[code === DisconnectReason.restartRequired ? "info" : "warn"]({
            event: "socket_disconnected",
            paired,
            disconnectCode: code,
            failure: describeWhatsAppError(error),
          });
          this.socket = null;
          await closeBaileysSocket(socket, 15000);
          if (code === DisconnectReason.loggedOut)
          {
            await this.authenticationStore.clear();
            await this.events?.state("LOGGED_OUT");
            this.stopped = true;
            return;
          }
          if (code === DisconnectReason.restartRequired && paired)
          {
            this.createSocket();
            return;
          }
          if (!paired)
          {
            this.stopped = true;
            await this.events?.state("STOPPED");
            return;
          }
          this.reconnectStartedAt ??= Date.now();
          if (Date.now() - this.reconnectStartedAt >= 12 * 60 * 60 * 1000)
          {
            this.stopped = true;
            await this.events?.state("FAILED");
            return;
          }
          await this.events?.state("CONNECTING");
          const wait = Math.min(900000, 30000 * 2 ** Math.min(this.retry++, 10))
            * (0.8 + Math.random() * 0.4);
          this.timer = setTimeout(() => this.createSocket(), wait);
          this.timer.unref();
        }
      }));
    socket.ev.on("messages.upsert", update =>
      enqueue(async () =>
      {
        for (const message of update.messages) await this.receive(message);
      }));
    socket.ev.on("messages.update", updates =>
      enqueue(async () =>
      {
        for (const update of updates)
        {
          if (update.update.status !== undefined && update.update.status !== null && update.key.id)
          {
            await this.events?.receipt({
              channelMessageId: update.key.id,
              chatAddress: update.key.remoteJid ?? null,
              status: proto.WebMessageInfo.Status[update.update.status] ?? String(update.update.status),
            });
          }
          if (update.update.message)
          {
            const prior = this.cache.readMessage(update.key);
            await this.receive({ ...prior, ...update.update, key: update.key } as WAMessage);
          }
        }
      }));
  }
  private async expirePairing(socket: WASocket): Promise<void>
  {
    if (this.socket !== socket || this.authentication?.creds.me || this.stopped) return;
    this.stopped = true;
    this.socket = null;
    try
    {
      await closeBaileysSocket(socket, 15000);
      await this.events?.state("STOPPED");
    }
    catch (error)
    {
      this.failure = error;
    }
  }
  private async address(jid: string | null | undefined, alternate?: string | null): Promise<string>
  {
    const candidate = alternate ?? jid;
    if (!candidate) throw new Error("Native WhatsApp identity unavailable");
    if (candidate.endsWith("@lid"))
    {
      const number = await this.socket?.signalRepository.lidMapping.getPNForLID(candidate);
      return number ? jidNormalizedUser(number) : jidNormalizedUser(candidate);
    }
    return jidNormalizedUser(candidate);
  }
  private async receive(message: WAMessage): Promise<void>
  {
    const chat = message.key.remoteJid;
    if (!chat || !message.key.id || !message.message || isJidBroadcast(chat) || isJidNewsletter(chat)) return;
    const content = message.message.protocolMessage;
    if (
      content && content.type !== proto.Message.ProtocolMessage.Type.REVOKE
      && content.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
    ) return;
    const own = this.authentication?.creds.me?.id;
    if (!own) throw new Error("Receiving account identity unavailable");
    const receiving = jidNormalizedUser(own);
    const account = this.account;
    if (!account) throw new Error("Account unavailable");
    this.cache.rememberMessage(message);
    const context: InboundContentContext = {
      workspaceId: account.workspaceId,
      accountId: account.accountId,
      message,
      receivingAddress: receiving,
      address: (jid, alternate) => this.address(jid, alternate),
      cachedMessage: key => this.cache.readMessage(key),
    };
    const serialized = JSON.stringify(message, BufferJSON.replacer);
    let normalized: InboundMessage;
    try
    {
      const metadata = await inboundMessageContext(context);
      const timestamp = message.messageTimestamp;
      const seconds = typeof timestamp === "number" ? timestamp : timestamp?.toNumber();
      if (seconds === undefined || !Number.isSafeInteger(seconds))
      {
        throw new Error("Native message time unavailable");
      }
      normalized = InboundMessageSchema.parse({
        channel: "WHATSAPP",
        receivingAddress: receiving,
        chatAddress: await this.address(chat, message.key.remoteJidAlt),
        senderAddress: message.key.fromMe
          ? receiving
          : await this.address(
            message.key.participant ?? chat,
            message.key.participantAlt ?? message.key.remoteJidAlt,
          ),
        senderDisplayName: message.pushName ?? undefined,
        mentionsReceiver: (metadata.mentionedAddresses?.includes(receiving) ?? false)
          || metadata.quotedMessage?.senderAddress === receiving,
        channelMessageId: message.key.id,
        occurredAt: new Date(seconds * 1000).toISOString(),
        ...metadata,
        ...await new BaileysInboundContent(context).normalize(),
      });
    }
    catch (error)
    {
      await this.events?.rejected(serialized, describeWhatsAppError(error).errorName);
      return;
    }
    await this.events?.received(normalized, serialized);
  }
  async prepare(message: OutboundMessage, index: number, nativeId: string): Promise<PreparedWhatsAppSend>
  {
    const sender = this.authentication?.creds.me?.id;
    if (!sender) throw new Error("WhatsApp identity unavailable");
    const recipientJid = await this.recipient(message.recipientAddress);
    if (
      "quotedMessage" in message && message.quotedMessage?.chatAddress
      && await this.recipient(message.quotedMessage.chatAddress)
        !== recipientJid
    ) throw new Error("Quote chat differs from recipient");
    const prepared = await prepareOutboundContent(message, {
      media: this.media,
      recipientJid,
      senderJid: jidNormalizedUser(sender),
      addressJid: address => this.recipient(address),
      quote: reference => this.quote(reference),
    }, index);
    return {
      recipientAddress: prepared.recipientAddress,
      content: prepared.content,
      options: { ...prepared.options, messageId: nativeId },
    };
  }
  private async quote(reference: MessageReference): Promise<WAMessage>
  {
    const key: WAMessageKey = {
      id: reference.channelMessageId,
      ...(reference.chatAddress ? { remoteJid: reference.chatAddress } : {}),
    };
    const cached = this.cache.readMessage(key);
    const serialized = cached
      ? null
      : await this.store.native(this.lease.accountId, reference.channelMessageId, reference.chatAddress);
    const value = cached ?? proto.WebMessageInfo.fromObject(JSON.parse(serialized!, BufferJSON.reviver));
    if (!value.key || value.key.id !== reference.channelMessageId || !value.message)
    {
      throw new Error("Quote content unavailable");
    }
    if (
      reference.chatAddress
      && await this.address(value.key.remoteJid) !== await this.recipient(reference.chatAddress)
    ) throw new Error("Quote chat correlation differs");
    if (reference.senderAddress)
    {
      const sender = value.key.fromMe
        ? this.authentication?.creds.me?.id
        : value.key.participant ?? value.key.remoteJid;
      if (await this.address(sender) !== await this.recipient(reference.senderAddress))
      {
        throw new Error("Quote sender correlation differs");
      }
    }
    return { ...value, key: value.key };
  }
  private async recipient(address: string): Promise<string>
  {
    if (/^[0-9]+(?:-[0-9]+)?@g\.us$/u.test(address)) return address;
    if (address.endsWith("@s.whatsapp.net") || address.endsWith("@lid")) return jidNormalizedUser(address);
    if (!/^\+[1-9][0-9]{1,14}$/u.test(address)) throw new Error("WhatsApp recipient identity invalid");
    const registration = await this.lookupContactAddress(address);
    if (registration.status === "UNREGISTERED") throw new Error("WhatsApp recipient is not registered");
    if (registration.status !== "REGISTERED")
    {
      throw new Error("WhatsApp recipient registration is indeterminate");
    }
    return registration.resolvedAddress;
  }
  async lookupContactAddress(address: string): Promise<ContactRegistration>
  {
    const account = this.account;
    if (!account) throw new Error("WhatsApp account is not initialized");
    const socket = this.socket;
    if (!socket || this.stopped || !this.lease.alive || !this.authentication?.creds.me)
    {
      return {
        workspaceId: account.workspaceId,
        accountId: account.accountId,
        address,
        status: "INDETERMINATE",
        reason: "UNAVAILABLE",
      };
    }
    return lookupNativeContact(
      socket,
      account,
      address,
      this.abort.signal,
      () => this.socket === socket && !this.stopped && this.lease.alive,
      this.registrationTimeoutMs,
    );
  }

  async send(prepared: PreparedWhatsAppSend): Promise<WhatsAppSendReceipt>
  {
    const socket = this.socket;
    if (!socket || !this.lease.alive || this.stopped) throw new Error("WhatsApp socket unavailable");
    const pending = socket.sendMessage(prepared.recipientAddress, prepared.content, prepared.options);
    let interrupted: (() => void) | undefined;
    try
    {
      const sent = await withBaileysTimeout(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) =>
          {
            interrupted = () => reject(new Error("WhatsApp send interrupted; outcome UNKNOWN"));
            if (this.abort.signal.aborted) interrupted();
            else this.abort.signal.addEventListener("abort", interrupted, { once: true });
          }),
        ]),
        60000,
        "send",
      );
      if (sent) this.cache.rememberMessage(sent);
      const timestamp = sent?.messageTimestamp;
      const seconds = typeof timestamp === "number" ? timestamp : timestamp?.toNumber();
      return {
        native: sent ? JSON.stringify(sent, BufferJSON.replacer) : null,
        ...(seconds !== undefined && Number.isSafeInteger(seconds)
          ? { occurredAt: new Date(seconds * 1000).toISOString() }
          : {}),
      };
    }
    finally
    {
      if (interrupted) this.abort.signal.removeEventListener("abort", interrupted);
    }
  }
  async presence(chat: string, composing: boolean): Promise<void>
  {
    const socket = this.socket;
    if (!socket || !this.lease.alive || this.stopped) throw new Error("WhatsApp socket unavailable");
    await withBaileysTimeout(
      socket.sendPresenceUpdate(composing ? "composing" : "paused", await this.recipient(chat)),
      1000,
      "presence",
    );
  }
  async stop(): Promise<void>
  {
    this.logger.debug({ event: "socket_stopping" });
    this.stopping ??= (async () =>
    {
      this.stopped = true;
      this.abort.abort();
      clearTimeout(this.timer);
      clearTimeout(this.pairingTimer);
      const socket = this.socket;
      this.socket = null;
      if (socket) await closeBaileysSocket(socket, 15000);
      await this.queue;
      await this.authenticationStore.flush();
    })();
    await this.stopping;
  }
  async drainEvents(): Promise<void>
  {
    await this.queue;
    if (this.failure) throw this.failure;
  }
}
function disconnectCode(error: unknown): number | undefined
{
  if (typeof error !== "object" || error === null || !("output" in error)) return undefined;
  const output = error.output;
  if (typeof output !== "object" || output === null || !("statusCode" in output)) return undefined;
  return typeof output.statusCode === "number" ? output.statusCode : undefined;
}
