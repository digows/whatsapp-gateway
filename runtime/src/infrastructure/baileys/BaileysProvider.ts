import makeWASocket, { DisconnectReason, proto } from 'baileys';
import crypto from 'crypto';
import {
  ActivationCancelledEvent,
  ActivationCompletedEvent,
  ActivationEvent,
  ActivationFailedEvent,
  ActivationPairingCodeUpdatedEvent,
  ActivationQrCodeUpdatedEvent,
  ActivationStartedEvent,
} from '../../domain/entities/activation/ActivationEvent.js';
import { ActivationMode } from '../../domain/entities/activation/ActivationMode.js';
import { DeliveryResult, DeliveryStatus } from '../../domain/entities/messaging/DeliveryResult.js';
import {
  InboundEvent,
  MessageReactionEvent,
  MessageUpdatedEvent,
  ReceivedMessageEvent,
} from '../../domain/entities/messaging/InboundEvent.js';
import { Message } from '../../domain/entities/messaging/Message.js';
import {
  AudioMessageContent,
  ButtonReplyMessageContent,
  ContactsMessageContent,
  DeleteMessageContent,
  DisappearingMessagesMessageContent,
  DocumentMessageContent,
  EventCallType,
  EventMessageContent,
  GroupInviteMessageContent,
  ImageMessageContent,
  InteractiveResponseMessageContent,
  LimitSharingMessageContent,
  ListReplyMessageContent,
  LocationMessageContent,
  MessageContent,
  OtherMessageContent,
  PinMessageAction,
  PinMessageContent,
  PollMessageContent,
  ProductMessageContent,
  ReactionMessageContent,
  RequestPhoneNumberMessageContent,
  SharePhoneNumberMessageContent,
  StickerMessageContent,
  TextMessageContent,
  VideoMessageContent,
} from '../../domain/entities/messaging/MessageContent.js';
import { MessageContentType } from '../../domain/entities/messaging/MessageContentType.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
import {
  SessionStatus,
  SessionStatusEvent,
} from '../../domain/entities/operational/SessionStatus.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import qrcode from 'qrcode-terminal';
import { env } from '../../application/config/env.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { AntiBanService } from '../../domain/services/AntiBanService.js';
import { PgSignalKeyRepository } from '../pg/PgSignalKeyRepository.js';
import { RedisAntiBanWarmUpStateRepository } from '../redis/RedisAntiBanWarmUpStateRepository.js';
import { RedisConnection } from '../redis/RedisConnection.js';
import { RedisKeyBuilder } from '../redis/RedisKeyBuilder.js';
import { BaileysAuthenticationStateStore } from './BaileysAuthenticationStateStore.js';
import { createBaileysLogger } from './BaileysLogger.js';
import { BaileysMessageNormalizer } from './BaileysMessageNormalizer.js';

interface ActiveActivation {
  commandId: string;
  correlationId: string;
  activationId: string;
  mode: ActivationMode;
  phoneNumber?: string;
  qrSequence: number;
  pairingCodeSequence: number;
}

interface PendingActivationFirstResult {
  activationId: string;
  resolve: (event: ActivationEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Callback contract implemented by the host that owns one Baileys session instance.
 */
export interface BaileysProviderCallbacks {
  onActivationEvent(event: ActivationEvent): Promise<void>;
  onInboundEvent(event: InboundEvent): Promise<void>;
  onPersistedCredentialsChanged(
    hasPersistedCredentials: boolean,
    timestamp: string,
  ): Promise<void>;
  onSessionStatus(event: SessionStatusEvent): Promise<void>;
}

/**
 * Single-session Baileys runtime.
 * It owns the WhatsApp socket, auth state, message normalization and anti-ban behavior.
 */
export class BaileysProvider {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private isStopping = false;
  private isConnected = false;
  private readonly loggedCiphertextIssues = new Set<string>();
  private activeActivation?: ActiveActivation;
  private latestQrCode?: string;
  private pendingActivationFirstResult?: PendingActivationFirstResult;

  private readonly proxyAgent?: HttpsProxyAgent<string>;
  private readonly antiBan: AntiBanService;
  private readonly authenticationStateStore: BaileysAuthenticationStateStore;

  constructor(
    private readonly session: SessionReference,
    private readonly callbacks: BaileysProviderCallbacks,
  ) {
    const proxyUrl = env.RESIDENTIAL_PROXY_URL;
    if (proxyUrl) {
      console.log('[PROXY] Routing provider traffic via residential proxy');
      this.proxyAgent = new HttpsProxyAgent(proxyUrl);
    } else {
      console.log('[PROXY] No residential proxy configured. Running via local IP.');
    }

    this.authenticationStateStore = new BaileysAuthenticationStateStore(
      this.session,
      new PgSignalKeyRepository(),
      RedisConnection.getClient(),
      {
        onPersistedCredentialsChanged: async (hasPersistedCredentials, timestamp) => {
          await this.callbacks.onPersistedCredentialsChanged(
            hasPersistedCredentials,
            timestamp,
          );
        },
      },
    );
    this.antiBan = new AntiBanService(
      this.session,
      new RedisAntiBanWarmUpStateRepository(RedisConnection.getClient()),
    );
  }

  public async start(): Promise<void> {
    this.isStopping = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.sock) {
      return;
    }

    const { state, saveCreds } = await this.authenticationStateStore.getAuthenticationState();

    this.sock = makeWASocket({
      auth: state,
      agent: this.proxyAgent,
      fetchAgent: this.proxyAgent,
      logger: createBaileysLogger(),
      syncFullHistory: false,
    });

    this.setupEventListeners(saveCreds);
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    this.isConnected = false;

    if (this.activeActivation) {
      await this.publishActivationCancelled(this.activeActivation, 'session_stopped');
      this.activeActivation = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.sock) {
      this.sock.end(new Error('Intentional Shutdown'));
      this.sock = null;
    }
  }

  public async requestQrCodeActivation(waitTimeoutMs = 30000): Promise<ActivationEvent> {
    return this.requestActivation(
      this.createActiveActivation(
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        ActivationMode.QrCode,
      ),
      waitTimeoutMs,
    );
  }

  public async requestPairingCodeActivation(
    phoneNumber: string,
    customPairingCode?: string,
    waitTimeoutMs = 30000,
  ): Promise<ActivationEvent> {
    if (!phoneNumber.trim()) {
      throw new Error('Pairing code activation requires a non-empty phoneNumber.');
    }

    return this.requestActivation(
      this.createActiveActivation(
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        ActivationMode.PairingCode,
        phoneNumber,
      ),
      waitTimeoutMs,
      customPairingCode,
    );
  }

  public async send(command: SendMessageCommand): Promise<DeliveryResult> {
    if (!this.sock) {
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Failed,
        undefined,
        'no active socket',
      );
    }

    const recipientJid = this.normalizeRecipientId(command.message.chatId);
    const decision = await this.antiBan.beforeSend(recipientJid, command.message.content);
    if (!decision.allowed) {
      console.warn(`[ANTIBAN] Outbound message blocked for ${recipientJid}: ${decision.reason}`);
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Blocked,
        undefined,
        decision.reason,
      );
    }

    const isGroup = recipientJid.endsWith('@g.us');
    await this.sleep(decision.preSendDelayMs);

    if (decision.content instanceof TextMessageContent && !isGroup) {
      await this.sock.presenceSubscribe(recipientJid).catch(() => {});
      await this.sock.sendPresenceUpdate('composing', recipientJid).catch(() => {});
    }

    await this.sleep(decision.typingDelayMs);

    try {
      const response = await this.sock.sendMessage(
        recipientJid,
        this.toBaileysContent(command.message),
      );
      await this.antiBan.afterSend(recipientJid, decision.content, decision.trackingKey);
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Sent,
        response?.key?.id ?? undefined,
      );
    } catch (error) {
      this.antiBan.afterSendFailed(error);
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Failed,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (decision.content instanceof TextMessageContent && !isGroup && this.sock) {
        await this.sock.sendPresenceUpdate('paused', recipientJid).catch(() => {});
      }
    }
  }

  private setupEventListeners(saveCreds: () => Promise<void>): void {
    if (!this.sock) {
      return;
    }

    const socket = this.sock;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', update => {
      void this.handleConnectionUpdate(update);
    });

    socket.ev.on('messages.upsert', event => {
      void this.handleMessagesUpsert(event);
    });

    socket.ev.on('messages.update', updates => {
      void this.handleMessagesUpdate(updates);
    });

    socket.ev.on('messages.reaction', reactions => {
      void this.handleMessagesReaction(reactions);
    });

    socket.ev.on('messaging-history.set', event => {
      this.logMessagingHistorySet(event);
    });

    socket.ev.on('contacts.upsert', contacts => {
      void this.cacheContactLidMappings(contacts);
    });

    socket.ev.on('contacts.update', contacts => {
      void this.cacheContactLidMappings(contacts);
    });
  }

  private async handleConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.latestQrCode = qr;
      console.log(
        `\n[QR CODE] Scan below to connect WhatsApp for ${this.session.toLogLabel()}:`,
      );
      qrcode.generate(qr, { small: true });

      if (this.activeActivation?.mode === ActivationMode.QrCode) {
        await this.publishCurrentQrCode(this.activeActivation);
      }
    }

    if (connection === 'open') {
      this.isConnected = true;
      this.latestQrCode = undefined;
      console.log(`[BaileysProvider] Connection opened for ${this.session.toLogLabel()}.`);
      this.antiBan.onReconnect();

      if (this.activeActivation) {
        await this.publishActivationCompleted(this.activeActivation);
        this.activeActivation = undefined;
      }

      await this.publishStatus(SessionStatus.Connected);
      return;
    }

    if (connection !== 'close') {
      return;
    }

    const statusCode = this.extractDisconnectStatusCode(lastDisconnect?.error);
    const errorMsg = this.extractErrorMessage(lastDisconnect?.error);
    const isIntentional =
      this.isStopping
      || errorMsg.includes('Intentional Logout')
      || errorMsg.includes('Intentional Shutdown');
    const shouldReconnect =
      statusCode !== DisconnectReason.loggedOut && !isIntentional;

    console.log(
      `[BaileysProvider] Connection closed for ${this.session.toLogLabel()} (reason: ${statusCode}). Reconnecting: ${shouldReconnect}.`,
    );

    this.antiBan.onDisconnect(statusCode);
    this.isConnected = false;
    this.sock = null;

    if (statusCode === DisconnectReason.loggedOut && !isIntentional) {
      console.error(
        `[BaileysProvider] Permanent logout detected for ${this.session.toLogLabel()}. Cleaning up session state.`,
      );
      await this.authenticationStateStore.clearSession().catch(error => {
        console.error('[BaileysProvider] Fatal error cleaning session:', error);
      });
      await this.publishStatus(SessionStatus.LoggedOut, `disconnect:${statusCode}`);
    }

    if (shouldReconnect) {
      await this.publishStatus(SessionStatus.Reconnecting, `disconnect:${statusCode}`);
      this.scheduleReconnect();
      return;
    }

    this.isStopping = false;
    if (!isIntentional) {
      if (this.activeActivation) {
        await this.publishActivationFailed(
          this.activeActivation,
          `disconnect:${statusCode ?? 'unknown'}`,
        );
        this.activeActivation = undefined;
      }
      await this.publishStatus(SessionStatus.Failed, `disconnect:${statusCode}`);
    }
    console.log(
      `[BaileysProvider] ${this.session.toLogLabel()} stopped (${isIntentional ? 'requested' : 'logged out'}).`,
    );
  }

  private async requestActivation(
    activation: ActiveActivation,
    waitTimeoutMs: number,
    customPairingCode?: string,
  ): Promise<ActivationEvent> {
    if (waitTimeoutMs <= 0) {
      throw new Error('Activation wait timeout must be greater than zero.');
    }

    if (this.activeActivation) {
      await this.cancelActivation(this.activeActivation, 'superseded_by_new_request');
    }

    const firstResultPromise = this.createPendingActivationFirstResult(
      activation.activationId,
      waitTimeoutMs,
    );

    try {
      await this.startActivation(activation, customPairingCode);
      return await firstResultPromise;
    } catch (error) {
      this.rejectPendingActivationFirstResult(
        activation.activationId,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async startActivation(
    activation: ActiveActivation,
    customPairingCode?: string,
  ): Promise<void> {
    this.activeActivation = activation;

    await this.emitActivationEvent(
      new ActivationStartedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        activation.mode,
        activation.phoneNumber,
      ),
    );

    await this.start();

    if (!this.isCurrentActivation(activation)) {
      return;
    }

    if (this.isConnected) {
      await this.publishActivationCompleted(activation);
      if (this.isCurrentActivation(activation)) {
        this.activeActivation = undefined;
      }
      return;
    }

    if (activation.mode === ActivationMode.QrCode) {
      await this.publishCurrentQrCode(activation);
      return;
    }

    if (!this.sock) {
      await this.publishActivationFailed(activation, 'activation socket unavailable');
      if (this.isCurrentActivation(activation)) {
        this.activeActivation = undefined;
      }
      return;
    }

    try {
      const pairingCode = await this.sock.requestPairingCode(
        this.normalizePhoneNumberForPairingCode(activation.phoneNumber ?? ''),
        customPairingCode,
      );

      if (!this.isCurrentActivation(activation)) {
        return;
      }

      activation.pairingCodeSequence += 1;
      await this.emitActivationEvent(
        new ActivationPairingCodeUpdatedEvent(
          activation.commandId,
          activation.correlationId,
          activation.activationId,
          this.session,
          new Date().toISOString(),
          pairingCode,
          activation.pairingCodeSequence,
          activation.phoneNumber,
        ),
      );
    } catch (error) {
      await this.publishActivationFailed(
        activation,
        error instanceof Error ? error.message : String(error),
      );

      if (this.isCurrentActivation(activation)) {
        this.activeActivation = undefined;
      }
    }
  }

  private async cancelActivation(
    activation: ActiveActivation,
    reason = 'cancelled_by_request',
  ): Promise<void> {
    await this.publishActivationCancelled(activation, reason);

    if (this.isCurrentActivation(activation)) {
      this.activeActivation = undefined;
    }
  }

  private async handleMessagesUpsert(event: any): Promise<void> {
    const upsertType = event?.type ?? 'unknown';
    const messages = Array.isArray(event?.messages) ? event.messages : [];

    if (upsertType !== 'notify' && messages.length > 0) {
      console.log(`\n[UPSERT] type=${upsertType} count=${messages.length}`);
    }

    for (const msg of messages) {
      const isFromMe = Boolean(msg.key.fromMe);

      if (!isFromMe && this.isCiphertextStub(msg)) {
        await this.logCiphertextIssue(msg, upsertType);
        continue;
      }

      const normalized = await BaileysMessageNormalizer.normalize(
        msg,
        this.resolveJidToE164.bind(this),
      );

      if (!normalized) {
        await this.logSkippedMessage(
          upsertType,
          isFromMe,
          msg,
          BaileysMessageNormalizer.getSkipReason(msg?.message) ?? 'no_normalized_content',
        );
        continue;
      }

      this.logNormalizedMessage(
        this.getMessageLogTag(upsertType, isFromMe),
        msg,
        normalized,
      );

      if (isFromMe || upsertType !== 'notify') {
        continue;
      }

      const inboundEvent = new ReceivedMessageEvent(
        this.session,
        normalized.timestamp,
        normalized,
      );

      await this.callbacks.onInboundEvent(inboundEvent);
    }
  }

  private async handleMessagesUpdate(updates: any[]): Promise<void> {
    for (const entry of updates ?? []) {
      const key = entry?.key;
      const update = entry?.update ?? {};

      if (!key) {
        continue;
      }

      const hasMessage = Boolean(update.message);
      const pollUpdateCount = Array.isArray(update.pollUpdates) ? update.pollUpdates.length : 0;
      const status = update.status;
      const stubType = update.messageStubType;

      if (!hasMessage && !pollUpdateCount && status == null && stubType == null) {
        continue;
      }

      const messageId = key.id;
      if (!messageId) {
        continue;
      }

      const { chatId, senderId, chatLabel, senderLabel } = await this.describeMessageKey(key);
      const parts = [
        `chat=${chatLabel}`,
        `sender=${senderLabel}`,
      ];

      if (status != null) {
        parts.push(`status=${status}`);
      }

      if (stubType != null) {
        parts.push(`stubType=${stubType}`);
      }

      if (hasMessage) {
        const contentType = this.describeMessageContentType(update.message);
        parts.push(`message=${contentType}`);
      }

      if (pollUpdateCount > 0) {
        parts.push(`pollUpdates=${pollUpdateCount}`);
      }

      console.log(`\n[MSG UPDATE] ${parts.join(' ')}`);

      const inboundEvent = new MessageUpdatedEvent(
        this.session,
        new Date().toISOString(),
        messageId,
        chatId,
        senderId,
        Boolean(key.fromMe),
        typeof status === 'number' ? status : undefined,
        typeof stubType === 'number' ? stubType : undefined,
        hasMessage ? this.describeMessageContentType(update.message) : undefined,
        pollUpdateCount > 0 ? pollUpdateCount : undefined,
      );

      await this.callbacks.onInboundEvent(inboundEvent);
    }
  }

  private async handleMessagesReaction(reactions: any[]): Promise<void> {
    for (const entry of reactions ?? []) {
      const key = entry?.key;
      if (!key) {
        continue;
      }

      const { chatId, senderId, chatLabel, senderLabel } = await this.describeMessageKey(key);
      const reactionText = entry?.reaction?.text || 'removed';
      console.log(
        `\n[MSG REACTION] chat=${chatLabel} sender=${senderLabel} text=${reactionText}`,
      );

      const inboundEvent = new MessageReactionEvent(
        this.session,
        new Date().toISOString(),
        chatId,
        senderId,
        Boolean(key.fromMe),
        !entry?.reaction?.text,
        key.id || undefined,
        entry?.reaction?.text || undefined,
      );

      await this.callbacks.onInboundEvent(inboundEvent);
    }
  }

  private logMessagingHistorySet(event: any): void {
    const messageCount = Array.isArray(event?.messages) ? event.messages.length : 0;
    const contactCount = Array.isArray(event?.contacts) ? event.contacts.length : 0;
    const chatCount = Array.isArray(event?.chats) ? event.chats.length : 0;
    const syncType = event?.syncType ?? 'unknown';
    const progress = event?.progress ?? 'n/a';
    const latest = event?.isLatest ?? 'n/a';

    console.log(
      `\n[HISTORY] syncType=${syncType} progress=${progress} latest=${latest} messages=${messageCount} contacts=${contactCount} chats=${chatCount}`,
    );
  }

  private logNormalizedMessage(
    direction: string,
    rawMessage: any,
    normalized: Message,
  ): void {
    const senderLabel = direction === 'OUT'
      ? 'self'
      : this.buildSenderLabel(rawMessage, normalized);

    const debugSuffix = this.buildDebugContentSuffix(rawMessage, normalized);

    console.log(
      `\n[MSG ${direction}] chat=${normalized.chatId} sender=${senderLabel} type=${normalized.content.type}${debugSuffix}`,
    );
  }

  private getMessageLogTag(upsertType: string, isFromMe: boolean): string {
    if (isFromMe) {
      return 'OUT';
    }

    return upsertType === 'notify' ? 'IN' : upsertType.toUpperCase();
  }

  private async logSkippedMessage(
    upsertType: string,
    isFromMe: boolean,
    rawMessage: any,
    reason: string,
  ): Promise<void> {
    const { chatLabel, senderLabel } = await this.describeRawMessage(rawMessage);
    const direction = isFromMe ? 'OUT' : 'IN';

    const debugSuffix = this.buildDebugContentSuffix(rawMessage);

    console.log(
      `\n[MSG SKIP] upsert=${upsertType} direction=${direction} chat=${chatLabel} sender=${senderLabel} reason=${reason}${debugSuffix}`,
    );
  }

  private buildSenderLabel(
    rawMessage: any,
    normalized: Message,
  ): string {
    const senderPhone = normalized.context?.senderPhone;
    const senderName =
      rawMessage.pushName || rawMessage.verifiedBizName || rawMessage.verifiedName || undefined;

    return senderName
      ? `${senderName}${senderPhone ? ` <${senderPhone}>` : ''}`
      : senderPhone || normalized.senderId;
  }

  private isCiphertextStub(message: any): boolean {
    return message?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
  }

  private async logCiphertextIssue(message: any, upsertType = 'notify'): Promise<void> {
    const messageId = message?.key?.id;
    if (!messageId || this.loggedCiphertextIssues.has(messageId)) {
      return;
    }

    this.loggedCiphertextIssues.add(messageId);
    setTimeout(() => {
      this.loggedCiphertextIssues.delete(messageId);
    }, 10 * 60 * 1000);

    const { chatLabel, senderLabel } = await this.describeRawMessage(message);
    const reason = this.mapCiphertextReason(message?.messageStubParameters?.[0]);

    const debugSuffix = this.buildDebugContentSuffix(message);

    console.warn(
      `\n[MSG WAIT] upsert=${upsertType} chat=${chatLabel} sender=${senderLabel} reason=${reason}${debugSuffix}`,
    );
  }

  private mapCiphertextReason(rawReason: unknown): string {
    const reason = typeof rawReason === 'string' ? rawReason : '';

    if (reason.includes('PreKey')) {
      return 'decrypt_retry_pending';
    }

    if (reason.includes('No message found')) {
      return 'message_retry_requested';
    }

    if (reason.includes('Missing')) {
      return 'keys_pending';
    }

    return 'ciphertext_pending';
  }

  private scheduleReconnect(): void {
    if (this.isStopping || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      if (this.isStopping) {
        return;
      }

      void this.start().catch(error => {
        console.error(
          `[BaileysProvider] Failed to restart ${this.session.toLogLabel()}:`,
          error,
        );
        this.scheduleReconnect();
      });
    }, 2000);
  }

  private buildDeliveryResult(
    command: SendMessageCommand,
    status: DeliveryStatus,
    providerMessageId?: string,
    reason?: string,
  ): DeliveryResult {
    return new DeliveryResult(
      command.commandId,
      this.session,
      command.message.chatId,
      status,
      new Date().toISOString(),
      providerMessageId,
      reason,
    );
  }

  private async publishStatus(
    status: SessionStatus,
    reason?: string,
  ): Promise<void> {
    await this.callbacks.onSessionStatus(
      new SessionStatusEvent(
        this.session,
        status,
        new Date().toISOString(),
        undefined,
        reason,
      ),
    );
  }

  private toBaileysContent(message: Message): any {
    const { content } = message;
    let payload: Record<string, unknown>;

    if (content instanceof TextMessageContent) {
      payload = { text: content.text };
    } else if (content instanceof ImageMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('image content requires mediaUrl');
      }

      payload = {
        image: { url: content.mediaUrl },
        caption: content.caption,
        mimetype: content.mimeType,
        width: content.width,
        height: content.height,
      };
    } else if (content instanceof AudioMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('audio content requires mediaUrl');
      }

      payload = {
        audio: { url: content.mediaUrl },
        mimetype: content.mimeType,
        seconds: content.durationSeconds,
        ptt: content.voiceNote,
      };
    } else if (content instanceof VideoMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('video content requires mediaUrl');
      }

      payload = {
        video: { url: content.mediaUrl },
        caption: content.caption,
        mimetype: content.mimeType,
        width: content.width,
        height: content.height,
        gifPlayback: content.gifPlayback,
        ptv: content.videoNote,
      };
    } else if (content instanceof DocumentMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('document content requires mediaUrl');
      }

      payload = {
        document: { url: content.mediaUrl },
        mimetype: content.mimeType,
        fileName: content.fileName ?? content.caption ?? 'document',
        caption: content.caption,
      };
    } else if (content instanceof StickerMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('sticker content requires mediaUrl');
      }

      payload = {
        sticker: { url: content.mediaUrl },
        mimetype: content.mimeType,
        isAnimated: content.animated,
        width: content.width,
        height: content.height,
      };
    } else if (content instanceof ContactsMessageContent) {
      payload = {
        contacts: {
          displayName: content.displayName ?? content.contacts[0]?.displayName,
          contacts: content.contacts.map(contact => ({
            displayName: contact.displayName,
            vcard: contact.vcard,
          })),
        },
      };
    } else if (content instanceof LocationMessageContent) {
      payload = {
        location: {
          degreesLatitude: content.latitude,
          degreesLongitude: content.longitude,
          name: content.name,
          address: content.address,
          url: content.url,
          comment: content.comment,
          isLive: content.live,
          accuracyInMeters: content.accuracyInMeters,
          speedInMps: content.speedInMetersPerSecond,
          degreesClockwiseFromMagneticNorth: content.degreesClockwiseFromMagneticNorth,
        },
      };
    } else if (content instanceof ReactionMessageContent) {
      payload = {
        react: {
          key: {
            id: content.targetMessage.messageId,
            remoteJid: content.targetMessage.remoteJid
              ?? this.normalizeRecipientId(message.chatId),
            participant: content.targetMessage.participantId,
          },
          text: content.removed ? '' : content.reactionText,
        },
      };
    } else if (content instanceof PollMessageContent) {
      payload = {
        poll: {
          name: content.name,
          values: content.options.map(option => option.name),
          selectableCount: content.selectableCount,
        },
      };
    } else if (content instanceof ButtonReplyMessageContent) {
      payload = {
        buttonReply: {
          displayText: content.displayText,
          id: content.buttonId,
          index: content.buttonIndex ?? 0,
        },
        type: content.replyType,
      };
    } else if (content instanceof ListReplyMessageContent) {
      payload = {
        listReply: {
          title: content.title,
          description: content.description,
          singleSelectReply: {
            selectedRowId: content.selectedRowId,
          },
        },
      };
    } else if (content instanceof GroupInviteMessageContent) {
      if (!content.groupJid.trim() || !content.inviteCode.trim()) {
        throw new Error('group invite content requires groupJid and inviteCode');
      }

      payload = {
        groupInvite: {
          jid: content.groupJid,
          inviteCode: content.inviteCode,
          inviteExpiration: content.inviteExpiration ?? 0,
          subject: content.groupName ?? '',
          text: content.caption ?? '',
        },
      };
    } else if (content instanceof EventMessageContent) {
      payload = {
        event: {
          name: content.name,
          description: content.description,
          startDate: content.startTimestamp ? new Date(content.startTimestamp) : new Date(),
          endDate: content.endTimestamp ? new Date(content.endTimestamp) : undefined,
          location: content.location
            ? {
                degreesLatitude: content.location.latitude,
                degreesLongitude: content.location.longitude,
                name: content.location.name,
                address: content.location.address,
                url: content.location.url,
              }
            : undefined,
          call: content.callType === EventCallType.Audio
            ? 'audio'
            : content.callType === EventCallType.Video
              ? 'video'
              : undefined,
          isCancelled: content.cancelled,
          isScheduleCall: content.scheduledCall,
          extraGuestsAllowed: content.extraGuestsAllowed,
        },
      };
    } else if (content instanceof ProductMessageContent) {
      if (!content.productImageUrl) {
        throw new Error('product content requires productImageUrl');
      }

      payload = {
        product: {
          productId: content.productId,
          title: content.title,
          description: content.description,
          currencyCode: content.currencyCode,
          priceAmount1000: content.priceAmount1000,
          retailerId: content.retailerId,
          url: content.url,
          productImage: { url: content.productImageUrl },
        },
        businessOwnerJid: content.businessOwnerJid,
        body: content.body,
        footer: content.footer,
      };
    } else if (content instanceof RequestPhoneNumberMessageContent) {
      payload = { requestPhoneNumber: true };
    } else if (content instanceof SharePhoneNumberMessageContent) {
      payload = { sharePhoneNumber: true };
    } else if (content instanceof DeleteMessageContent) {
      payload = {
        delete: {
          id: content.targetMessage.messageId,
          remoteJid: content.targetMessage.remoteJid ?? this.normalizeRecipientId(message.chatId),
          participant: content.targetMessage.participantId,
        },
      };
    } else if (content instanceof PinMessageContent) {
      payload = {
        pin: {
          id: content.targetMessage.messageId,
          remoteJid: content.targetMessage.remoteJid ?? this.normalizeRecipientId(message.chatId),
          participant: content.targetMessage.participantId,
        },
        type: content.action === PinMessageAction.UnpinForAll
          ? proto.PinInChat.Type.UNPIN_FOR_ALL
          : proto.PinInChat.Type.PIN_FOR_ALL,
        time: content.durationSeconds,
      };
    } else if (content instanceof DisappearingMessagesMessageContent) {
      payload = {
        disappearingMessagesInChat: content.expirationSeconds,
      };
    } else if (content instanceof LimitSharingMessageContent) {
      payload = {
        limitSharing: content.sharingLimited,
      };
    } else if (content instanceof InteractiveResponseMessageContent) {
      throw new Error('interactive response content is inbound-only in this gateway');
    } else if (content instanceof OtherMessageContent) {
      throw new Error(
        `Unsupported outbound content type: ${content.description ?? MessageContentType.Other}`,
      );
    } else {
      throw new Error(`Unsupported outbound content type: ${String(content.type)}`);
    }

    return this.applyCommonOutboundOptions(message, payload);
  }

  private applyCommonOutboundOptions(
    message: Message,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const mentionedJids = message.context?.mentionedJids
      .map(jid => this.normalizeRecipientId(jid))
      .filter(Boolean);

    if (
      mentionedJids?.length
      && (
        payload.text
        || payload.image
        || payload.video
        || payload.document
        || payload.poll
      )
    ) {
      payload.mentions = mentionedJids;
    }

    if (message.context?.viewOnce) {
      payload.viewOnce = true;
    }

    if (message.context?.editTarget) {
      payload.edit = {
        id: message.context.editTarget.messageId,
        remoteJid: message.context.editTarget.remoteJid ?? this.normalizeRecipientId(message.chatId),
        participant: message.context.editTarget.participantId,
      };
    }

    return payload;
  }

  private normalizeRecipientId(recipientId: string): string {
    if (recipientId.includes('@')) {
      return recipientId;
    }

    const digits = recipientId.replace(/\D/g, '');
    if (digits) {
      return `${digits}@s.whatsapp.net`;
    }

    return recipientId;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private async cacheContactLidMappings(contacts: any[]): Promise<void> {
    const redis = RedisConnection.getClient();
    for (const contact of contacts) {
      const id1 = contact.id;
      const id2 = contact.lidJid || contact.pnJid;

      if (id1 && id2 && id1 !== id2) {
        const jids = [id1, id2];
        const lid = jids.find((jid: string) => jid.includes('@lid') || jid.includes('hosted.lid'));
        const pn = jids.find((jid: string) => jid.includes('@s.whatsapp.net'));

        if (lid && pn) {
          const redisKey = RedisKeyBuilder.getLidMappingKey(
            this.session,
            lid,
          );
          await redis.setex(redisKey, 86400 * 30, pn);
        }
      }
    }
  }

  private normalizeE164(phoneNumber: string): string {
    const digits = phoneNumber.replace(/\D/g, '');
    if (!digits) {
      return '';
    }

    return `+${digits}`;
  }

  private normalizePhoneNumberForPairingCode(phoneNumber: string): string {
    const digits = phoneNumber.replace(/\D/g, '');
    if (!digits) {
      throw new Error('Pairing code activation requires a numeric phone number.');
    }

    return digits;
  }

  private async resolveJidToE164(
    jid: string | null | undefined,
    altJid?: string | null,
  ): Promise<string | null> {
    if (!jid) {
      return null;
    }

    if (altJid && altJid.includes('@s.whatsapp.net')) {
      return this.normalizeE164(altJid.split('@')[0]);
    }

    const phoneMatch = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
    if (phoneMatch) {
      return this.normalizeE164(phoneMatch[1]);
    }

    const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
    if (lidMatch) {
      try {
        const redis = RedisConnection.getClient();
        const mappedPn = await redis.get(
          RedisKeyBuilder.getLidMappingKey(this.session, jid),
        );
        if (mappedPn) {
          return this.resolveJidToE164(mappedPn);
        }
      } catch (error) {
        console.warn(`[BaileysProvider] LID Redis lookup failed for ${jid}:`, error);
      }

      return null;
    }

    return null;
  }

  private async describeRawMessage(rawMessage: any): Promise<{
    chatId: string;
    senderId: string;
    chatLabel: string;
    senderLabel: string;
  }> {
    return this.describeMessageKey(
      rawMessage?.key,
      rawMessage?.pushName || rawMessage?.verifiedBizName || rawMessage?.verifiedName || undefined,
    );
  }

  private async describeMessageKey(
    key: any,
    senderName?: string,
  ): Promise<{
    chatId: string;
    senderId: string;
    chatLabel: string;
    senderLabel: string;
  }> {
    const rawChatId = key?.remoteJid;
    const rawParticipantId = key?.participant || undefined;
    const rawSenderId = rawParticipantId || rawChatId;
    const altJid = key?.participantAlt || key?.remoteJidAlt;
    const senderPhone = await this.resolveJidToE164(rawSenderId, altJid);
    const chatPhone = rawChatId
      ? await this.resolveJidToE164(rawChatId, key?.remoteJidAlt)
      : null;

    const chatId = chatPhone || rawChatId || 'unknown';
    const senderId = senderPhone || rawSenderId || 'unknown';

    return {
      chatId,
      senderId,
      chatLabel: chatId,
      senderLabel: senderName
        ? `${senderName}${senderPhone ? ` <${senderPhone}>` : ''}`
        : senderId,
    };
  }

  private describeMessageContentType(message: any): string {
    const content = this.unwrapMessage(message);

    if (!this.isRecord(content)) {
      return 'unknown';
    }

    const contentKeys = Object.keys(content).filter(key => Boolean(content[key]));
    return contentKeys[0] ?? 'unknown';
  }

  private createActiveActivation(
    commandId: string,
    correlationId: string,
    activationId: string,
    mode: ActivationMode,
    phoneNumber?: string,
  ): ActiveActivation {
    return {
      commandId,
      correlationId,
      activationId,
      mode,
      phoneNumber,
      qrSequence: 0,
      pairingCodeSequence: 0,
    };
  }

  private isCurrentActivation(activation: ActiveActivation): boolean {
    return this.activeActivation?.activationId === activation.activationId;
  }

  private createPendingActivationFirstResult(
    activationId: string,
    waitTimeoutMs: number,
  ): Promise<ActivationEvent> {
    if (this.pendingActivationFirstResult) {
      clearTimeout(this.pendingActivationFirstResult.timer);
      this.pendingActivationFirstResult.reject(
        new Error('Activation first result waiter was replaced before completion.'),
      );
      this.pendingActivationFirstResult = undefined;
    }

    return new Promise<ActivationEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingActivationFirstResult?.activationId === activationId) {
          this.pendingActivationFirstResult = undefined;
        }

        reject(
          new Error(`Activation ${activationId} did not produce an initial result within ${waitTimeoutMs}ms.`),
        );
      }, waitTimeoutMs);
      timer.unref();

      this.pendingActivationFirstResult = {
        activationId,
        resolve,
        reject,
        timer,
      };
    });
  }

  private resolvePendingActivationFirstResult(event: ActivationEvent): void {
    if (!this.pendingActivationFirstResult) {
      return;
    }

    if (this.pendingActivationFirstResult.activationId !== event.activationId) {
      return;
    }

    if (event instanceof ActivationStartedEvent) {
      return;
    }

    clearTimeout(this.pendingActivationFirstResult.timer);
    const { resolve } = this.pendingActivationFirstResult;
    this.pendingActivationFirstResult = undefined;
    resolve(event);
  }

  private rejectPendingActivationFirstResult(activationId: string, error: Error): void {
    if (!this.pendingActivationFirstResult) {
      return;
    }

    if (this.pendingActivationFirstResult.activationId !== activationId) {
      return;
    }

    clearTimeout(this.pendingActivationFirstResult.timer);
    const { reject } = this.pendingActivationFirstResult;
    this.pendingActivationFirstResult = undefined;
    reject(error);
  }

  private async emitActivationEvent(event: ActivationEvent): Promise<void> {
    try {
      await this.callbacks.onActivationEvent(event);
    } finally {
      this.resolvePendingActivationFirstResult(event);
    }
  }

  private async publishCurrentQrCode(activation: ActiveActivation): Promise<void> {
    if (!this.latestQrCode || !this.isCurrentActivation(activation)) {
      return;
    }

    activation.qrSequence += 1;
    await this.emitActivationEvent(
      new ActivationQrCodeUpdatedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        this.latestQrCode,
        activation.qrSequence,
      ),
    );
  }

  private async publishActivationCompleted(activation: ActiveActivation): Promise<void> {
    await this.emitActivationEvent(
      new ActivationCompletedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        activation.mode,
      ),
    );
  }

  private async publishActivationFailed(
    activation: ActiveActivation,
    reason: string,
  ): Promise<void> {
    await this.emitActivationEvent(
      new ActivationFailedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        reason,
      ),
    );
  }

  private async publishActivationCancelled(
    activation: ActiveActivation,
    reason: string,
  ): Promise<void> {
    await this.emitActivationEvent(
      new ActivationCancelledEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        reason,
      ),
    );
  }

  private extractDisconnectStatusCode(error: unknown): number | undefined {
    if (!this.isRecord(error)) {
      return undefined;
    }

    const output = error.output;
    if (!this.isRecord(output) || typeof output.statusCode !== 'number') {
      return undefined;
    }

    return output.statusCode;
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (this.isRecord(error) && typeof error.message === 'string') {
      return error.message;
    }

    return '';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private buildDebugContentSuffix(
    rawMessage: any,
    normalized?: Message,
  ): string {
    if (!this.isDebugLoggingEnabled()) {
      return '';
    }

    const contentSummary = normalized?.content
      ? this.summarizeNormalizedContent(normalized.content)
      : this.summarizeRawContent(this.unwrapMessage(rawMessage?.message));

    if (!contentSummary) {
      return '';
    }

    return ` content=${JSON.stringify(contentSummary)}`;
  }

  private summarizeRawContent(content: any): Record<string, unknown> | null {
    if (!content || typeof content !== 'object') {
      return null;
    }

    if (content.conversation) {
      return {
        type: 'conversation',
        text: this.truncateDebugText(content.conversation),
      };
    }

    if (content.extendedTextMessage?.text) {
      return {
        type: 'extendedTextMessage',
        text: this.truncateDebugText(content.extendedTextMessage.text),
      };
    }

    if (content.imageMessage) {
      return {
        type: 'imageMessage',
        caption: this.truncateDebugText(content.imageMessage.caption),
        mimetype: content.imageMessage.mimetype,
      };
    }

    if (content.videoMessage) {
      return {
        type: 'videoMessage',
        caption: this.truncateDebugText(content.videoMessage.caption),
        mimetype: content.videoMessage.mimetype,
      };
    }

    if (content.documentMessage) {
      return {
        type: 'documentMessage',
        fileName: content.documentMessage.fileName,
        caption: this.truncateDebugText(content.documentMessage.caption),
        mimetype: content.documentMessage.mimetype,
      };
    }

    if (content.audioMessage) {
      return {
        type: 'audioMessage',
        seconds: content.audioMessage.seconds,
        mimetype: content.audioMessage.mimetype,
        ptt: content.audioMessage.ptt,
      };
    }

    if (content.stickerMessage) {
      return {
        type: 'stickerMessage',
        mimetype: content.stickerMessage.mimetype,
        isAnimated: content.stickerMessage.isAnimated,
      };
    }

    if (content.locationMessage) {
      return {
        type: 'locationMessage',
        name: content.locationMessage.name,
        address: content.locationMessage.address,
      };
    }

    if (content.contactMessage) {
      return {
        type: 'contactMessage',
        displayName: content.contactMessage.displayName,
      };
    }

    if (content.contactsArrayMessage) {
      return {
        type: 'contactsArrayMessage',
        count: Array.isArray(content.contactsArrayMessage.contacts)
          ? content.contactsArrayMessage.contacts.length
          : undefined,
      };
    }

    if (content.reactionMessage) {
      return {
        type: 'reactionMessage',
        text: content.reactionMessage.text,
      };
    }

    if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) {
      const pollMessage =
        content.pollCreationMessage
        || content.pollCreationMessageV2
        || content.pollCreationMessageV3;

      return {
        type: 'pollCreationMessage',
        name: pollMessage.name,
        options: Array.isArray(pollMessage.options) ? pollMessage.options.length : undefined,
      };
    }

    return {
      type: this.describeMessageContentType(content),
    };
  }

  private summarizeNormalizedContent(
    content: MessageContent,
  ): Record<string, unknown> | null {
    if (content instanceof TextMessageContent) {
      return {
        type: MessageContentType.Text,
        text: this.truncateDebugText(content.text),
        title: this.truncateDebugText(content.title),
      };
    }

    if (
      content instanceof ImageMessageContent
      || content instanceof VideoMessageContent
      || content instanceof DocumentMessageContent
    ) {
      return {
        type: content.type,
        text: this.truncateDebugText(content.getTextBody()),
        mimeType: content.mimeType,
      };
    }

    if (content instanceof AudioMessageContent) {
      return {
        type: MessageContentType.Audio,
        durationSeconds: content.durationSeconds,
        voiceNote: content.voiceNote,
      };
    }

    if (content instanceof StickerMessageContent) {
      return {
        type: MessageContentType.Sticker,
        animated: content.animated,
      };
    }

    if (content instanceof ContactsMessageContent) {
      return {
        type: MessageContentType.Contacts,
        count: content.contacts.length,
        displayName: content.displayName,
      };
    }

    if (content instanceof LocationMessageContent) {
      return {
        type: MessageContentType.Location,
        latitude: content.latitude,
        longitude: content.longitude,
        live: content.live,
        name: content.name,
      };
    }

    if (content instanceof ReactionMessageContent) {
      return {
        type: MessageContentType.Reaction,
        messageId: content.targetMessage.messageId,
        text: content.reactionText,
        removed: content.removed,
      };
    }

    if (content instanceof PollMessageContent) {
      return {
        type: MessageContentType.Poll,
        name: this.truncateDebugText(content.name),
        options: content.options.length,
      };
    }

    if (content instanceof ButtonReplyMessageContent) {
      return {
        type: MessageContentType.ButtonReply,
        buttonId: content.buttonId,
        displayText: this.truncateDebugText(content.displayText),
        replyType: content.replyType,
      };
    }

    if (content instanceof ListReplyMessageContent) {
      return {
        type: MessageContentType.ListReply,
        selectedRowId: content.selectedRowId,
        title: this.truncateDebugText(content.title),
      };
    }

    if (content instanceof GroupInviteMessageContent) {
      return {
        type: MessageContentType.GroupInvite,
        groupJid: content.groupJid,
        groupName: content.groupName,
      };
    }

    if (content instanceof EventMessageContent) {
      return {
        type: MessageContentType.Event,
        name: this.truncateDebugText(content.name),
        startTimestamp: content.startTimestamp,
      };
    }

    if (content instanceof ProductMessageContent) {
      return {
        type: MessageContentType.Product,
        productId: content.productId,
        title: this.truncateDebugText(content.title),
      };
    }

    if (content instanceof InteractiveResponseMessageContent) {
      return {
        type: MessageContentType.InteractiveResponse,
        bodyText: this.truncateDebugText(content.bodyText),
        flowName: content.flowName,
      };
    }

    if (content instanceof DeleteMessageContent) {
      return {
        type: MessageContentType.Delete,
        messageId: content.targetMessage.messageId,
      };
    }

    if (content instanceof PinMessageContent) {
      return {
        type: MessageContentType.Pin,
        messageId: content.targetMessage.messageId,
        action: content.action,
        durationSeconds: content.durationSeconds,
      };
    }

    if (content instanceof DisappearingMessagesMessageContent) {
      return {
        type: MessageContentType.DisappearingMessages,
        expirationSeconds: content.expirationSeconds,
      };
    }

    if (content instanceof LimitSharingMessageContent) {
      return {
        type: MessageContentType.LimitSharing,
        sharingLimited: content.sharingLimited,
      };
    }

    return {
      type: content.type,
    };
  }

  private isDebugLoggingEnabled(): boolean {
    return env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace';
  }

  private truncateDebugText(value: unknown, maxLength = 280): string | undefined {
    if (typeof value !== 'string' || !value.length) {
      return undefined;
    }

    return value.length > maxLength
      ? `${value.slice(0, maxLength)}...`
      : value;
  }

  private unwrapMessage(message: any): any {
    if (!message) {
      return null;
    }

    if (message.ephemeralMessage?.message) {
      return this.unwrapMessage(message.ephemeralMessage.message);
    }

    if (message.viewOnceMessageV2?.message) {
      return this.unwrapMessage(message.viewOnceMessageV2.message);
    }

    if (message.viewOnceMessage?.message) {
      return this.unwrapMessage(message.viewOnceMessage.message);
    }

    if (message.documentWithCaptionMessage?.message) {
      return this.unwrapMessage(message.documentWithCaptionMessage.message);
    }

    if (message.editedMessage?.message?.protocolMessage?.editedMessage) {
      return this.unwrapMessage(message.editedMessage.message.protocolMessage.editedMessage);
    }

    return message;
  }
}
