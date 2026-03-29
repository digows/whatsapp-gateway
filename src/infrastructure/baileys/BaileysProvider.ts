import makeWASocket, { DisconnectReason, proto } from 'baileys';
import {
  ChannelDeliveryResultEvent,
  ChannelIncomingMessageEvent,
  ChannelOutgoingMessageCommand,
  ChannelSessionRuntimeCallbacks,
  ChannelSessionStatusEvent,
  IChannelSessionRuntime,
} from '@jarvix/ts-channel-provider';
import { HttpsProxyAgent } from 'https-proxy-agent';
import qrcode from 'qrcode-terminal';
import { env } from '../../application/config/env.js';
import { SessionDescriptor } from '../../domain/entities/SessionDescriptor.js';
import { AntiBanService } from '../../domain/services/AntiBanService.js';
import { PgSignalKeyRepository } from '../pg/PgSignalKeyRepository.js';
import { RedisAntiBanWarmUpStateRepository } from '../redis/RedisAntiBanWarmUpStateRepository.js';
import { RedisConnection } from '../redis/RedisConnection.js';
import { BaileysAuthStateStore } from './BaileysAuthStateStore.js';
import { createBaileysLogger } from './BaileysLogger.js';
import { BaileysMessageNormalizer } from './BaileysMessageNormalizer.js';

export interface BaileysProviderCallbacks {
  onIncomingMessage?: (event: ChannelIncomingMessageEvent) => Promise<void>;
  onSessionStatus?: (event: ChannelSessionStatusEvent) => Promise<void>;
}

/**
 * Single-session Baileys runtime.
 * It owns the WhatsApp socket, auth state, message normalization and anti-ban behavior.
 */
export class BaileysProvider implements IChannelSessionRuntime {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private isStopping = false;
  private readonly loggedCiphertextIssues = new Set<string>();

  private readonly proxyAgent?: HttpsProxyAgent<string>;
  private readonly antiBan: AntiBanService;
  private readonly authStateStore: BaileysAuthStateStore;

  constructor(
    private readonly session: SessionDescriptor,
    private readonly callbacks: ChannelSessionRuntimeCallbacks & Partial<BaileysProviderCallbacks>,
  ) {
    const proxyUrl = env.RESIDENTIAL_PROXY_URL;
    if (proxyUrl) {
      console.log('[PROXY] Routing provider traffic via residential proxy');
      this.proxyAgent = new HttpsProxyAgent(proxyUrl);
    } else {
      console.log('[PROXY] No residential proxy configured. Running via local IP.');
    }

    this.authStateStore = new BaileysAuthStateStore(
      this.session.workspaceId,
      this.session.sessionId,
      new PgSignalKeyRepository(),
      RedisConnection.getClient(),
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

    const { state, saveCreds } = await this.authStateStore.getAuthState();

    this.sock = makeWASocket({
      auth: state,
      agent: this.proxyAgent,
      fetchAgent: this.proxyAgent as any,
      logger: createBaileysLogger() as any,
      syncFullHistory: false,
    });

    this.setupEventListeners(saveCreds);
  }

  public async stop(): Promise<void> {
    this.isStopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.sock) {
      this.sock.end(new Error('Intentional Shutdown'));
      this.sock = null;
    }
  }

  public async send(command: ChannelOutgoingMessageCommand): Promise<ChannelDeliveryResultEvent> {
    if (!this.sock) {
      return this.buildDeliveryResult(command, 'failed', undefined, 'no active socket');
    }

    const recipientJid = this.normalizeRecipientId(command.message.recipientId);
    const decision = await this.antiBan.beforeSend(recipientJid, command.message.content);
    if (!decision.allowed) {
      console.warn(`[ANTIBAN] Outbound message blocked for ${recipientJid}: ${decision.reason}`);
      return this.buildDeliveryResult(command, 'blocked', undefined, decision.reason);
    }

    const isGroup = recipientJid.endsWith('@g.us');
    await this.sleep(decision.preSendDelayMs);

    if (decision.content.type === 'text' && !isGroup) {
      await this.sock.presenceSubscribe(recipientJid).catch(() => {});
      await this.sock.sendPresenceUpdate('composing', recipientJid).catch(() => {});
    }

    await this.sleep(decision.typingDelayMs);

    try {
      const response = await this.sock.sendMessage(
        recipientJid,
        this.toBaileysContent(decision.content),
      );
      await this.antiBan.afterSend(recipientJid, decision.content, decision.trackingKey);
      return this.buildDeliveryResult(command, 'sent', response?.key?.id ?? undefined);
    } catch (error) {
      this.antiBan.afterSendFailed(error);
      return this.buildDeliveryResult(
        command,
        'failed',
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (decision.content.type === 'text' && !isGroup && this.sock) {
        await this.sock.sendPresenceUpdate('paused' as any, recipientJid).catch(() => {});
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
      console.log(
        `\n[QR CODE] Scan below to connect WhatsApp for ${this.session.toLogLabel()}:`,
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log(`[BaileysProvider] Connection opened for ${this.session.toLogLabel()}.`);
      this.antiBan.onReconnect();
      await this.publishStatus('connected');
      return;
    }

    if (connection !== 'close') {
      return;
    }

    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
    const errorMsg = (lastDisconnect?.error as any)?.message || '';
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
    this.sock = null;

    if (statusCode === DisconnectReason.loggedOut && !isIntentional) {
      console.error(
        `[BaileysProvider] Permanent logout detected for ${this.session.toLogLabel()}. Cleaning up session state.`,
      );
      await this.authStateStore.clearSession().catch(error => {
        console.error('[BaileysProvider] Fatal error cleaning session:', error);
      });
      await this.publishStatus('logged_out', `disconnect:${statusCode}`);
    }

    if (shouldReconnect) {
      await this.publishStatus('reconnecting', `disconnect:${statusCode}`);
      this.scheduleReconnect();
      return;
    }

    this.isStopping = false;
    if (!isIntentional) {
      await this.publishStatus('failed', `disconnect:${statusCode}`);
    }
    console.log(
      `[BaileysProvider] ${this.session.toLogLabel()} stopped (${isIntentional ? 'requested' : 'logged out'}).`,
    );
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
        this.session.workspaceId,
        this.session.sessionId,
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

      await this.callbacks.onIncomingMessage({
        session: this.session,
        message: normalized,
      });
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

      const { chatLabel, senderLabel } = await this.describeMessageKey(key);
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
    }
  }

  private async handleMessagesReaction(reactions: any[]): Promise<void> {
    for (const entry of reactions ?? []) {
      const key = entry?.key;
      if (!key) {
        continue;
      }

      const { chatLabel, senderLabel } = await this.describeMessageKey(key);
      const reactionText = entry?.reaction?.text || 'removed';
      console.log(
        `\n[MSG REACTION] chat=${chatLabel} sender=${senderLabel} text=${reactionText}`,
      );
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
    normalized: ChannelIncomingMessageEvent['message'],
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
    normalized: ChannelIncomingMessageEvent['message'],
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
    command: ChannelOutgoingMessageCommand,
    status: ChannelDeliveryResultEvent['status'],
    providerMessageId?: string,
    reason?: string,
  ): ChannelDeliveryResultEvent {
    return {
      commandId: command.commandId,
      session: this.session,
      recipientId: command.message.recipientId,
      status,
      providerMessageId,
      reason,
      timestamp: new Date().toISOString(),
    };
  }

  private async publishStatus(
    status: ChannelSessionStatusEvent['status'],
    reason?: string,
  ): Promise<void> {
    await this.callbacks.onSessionStatus({
      session: this.session,
      status,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  private toBaileysContent(content: ChannelOutgoingMessageCommand['message']['content']): any {
    switch (content.type) {
      case 'text':
        return { text: content.text ?? '' };
      case 'image':
        if (!content.mediaUrl) {
          throw new Error('image content requires mediaUrl');
        }
        return { image: { url: content.mediaUrl }, caption: content.text };
      case 'audio':
        if (!content.mediaUrl) {
          throw new Error('audio content requires mediaUrl');
        }
        return { audio: { url: content.mediaUrl } };
      case 'video':
        if (!content.mediaUrl) {
          throw new Error('video content requires mediaUrl');
        }
        return { video: { url: content.mediaUrl }, caption: content.text };
      case 'document':
        if (!content.mediaUrl) {
          throw new Error('document content requires mediaUrl');
        }
        return {
          document: { url: content.mediaUrl },
          fileName: content.text ?? 'document',
        };
      default:
        throw new Error(`Unsupported outbound content type: ${(content as any).type}`);
    }
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
          const redisKey = `wa:${this.session.workspaceId}:lid-mapping:${lid}`;
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
        const mappedPn = await redis.get(`wa:${this.session.workspaceId}:lid-mapping:${jid}`);
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

    return {
      chatLabel: chatPhone || rawChatId || 'unknown',
      senderLabel: senderName
        ? `${senderName}${senderPhone ? ` <${senderPhone}>` : ''}`
        : senderPhone || rawSenderId || 'unknown',
    };
  }

  private describeMessageContentType(message: any): string {
    const content = this.unwrapMessage(message);

    if (!content || typeof content !== 'object') {
      return 'unknown';
    }

    const contentKeys = Object.keys(content).filter(key => Boolean((content as any)[key]));
    return contentKeys[0] ?? 'unknown';
  }

  private buildDebugContentSuffix(
    rawMessage: any,
    normalized?: ChannelIncomingMessageEvent['message'],
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
    content: ChannelIncomingMessageEvent['message']['content'],
  ): Record<string, unknown> | null {
    switch (content.type) {
      case 'text':
        return {
          type: 'text',
          text: this.truncateDebugText(content.text),
        };
      case 'image':
      case 'video':
      case 'document':
        return {
          type: content.type,
          text: this.truncateDebugText(content.text),
        };
      case 'audio':
        return {
          type: 'audio',
        };
      default:
        return {
          type: content.type,
        };
    }
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
