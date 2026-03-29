import {
  ChatType,
  IncomingMessage,
} from '../../shared/contracts/gateway.js';

type ResolvePhoneFn = (
  jid: string | null | undefined,
  altJid?: string | null,
) => Promise<string | null>;

export class BaileysMessageNormalizer {
  public static async normalize(
    message: any,
    workspaceId: number,
    sessionId: string,
    resolvePhone: ResolvePhoneFn,
  ): Promise<IncomingMessage | null> {
    const rawChatId = message?.key?.remoteJid;
    const messageId = message?.key?.id;
    if (!rawChatId || !messageId) {
      return null;
    }

    const chatType = this.getChatType(rawChatId);
    const rawParticipantId = message.key.participant || undefined;
    const rawSenderId = rawParticipantId || rawChatId;
    const altJid = message.key.participantAlt || message.key.remoteJidAlt;
    const senderPhone = await resolvePhone(rawSenderId, altJid);
    const chatPhone =
      chatType === 'direct'
        ? await resolvePhone(rawChatId, message.key.remoteJidAlt)
        : null;

    const chatId = chatPhone || rawChatId;
    const senderId = senderPhone || rawSenderId;
    const participantId = rawParticipantId
      ? senderPhone || rawParticipantId
      : undefined;

    const content = this.extractContent(message.message);
    if (!content) {
      return null;
    }

    return {
      messageId,
      chatId,
      senderId,
      participantId,
      workspaceId,
      sessionId,
      timestamp: new Date(
        Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      ).toISOString(),
      content,
      context: {
        chatType,
        remoteJid: rawChatId,
        participantId: rawParticipantId,
        senderPhone: senderPhone ?? undefined,
      },
    };
  }

  public static getSkipReason(message: any): string | null {
    const unwrapped = this.unwrapMessage(message);
    if (!unwrapped) {
      return 'empty_message';
    }

    return this.getInternalMessageReason(unwrapped);
  }

  private static getChatType(jid: string): ChatType {
    if (jid.endsWith('@g.us')) {
      return 'group';
    }

    if (jid.endsWith('@broadcast')) {
      return 'broadcast';
    }

    if (
      jid.endsWith('@s.whatsapp.net')
      || jid.endsWith('@lid')
      || jid.endsWith('@hosted.lid')
    ) {
      return 'direct';
    }

    return 'unknown';
  }

  private static extractContent(message: any): IncomingMessage['content'] | null {
    const unwrapped = this.unwrapMessage(message);
    if (!unwrapped) {
      return null;
    }

    if (this.getInternalMessageReason(unwrapped)) {
      return null;
    }

    if (unwrapped.conversation || unwrapped.extendedTextMessage?.text) {
      return {
        type: 'text',
        text: (unwrapped.conversation || unwrapped.extendedTextMessage?.text || '').trim(),
      };
    }

    if (unwrapped.imageMessage) {
      return {
        type: 'image',
        text: unwrapped.imageMessage.caption?.trim(),
      };
    }

    if (unwrapped.videoMessage) {
      return {
        type: 'video',
        text: unwrapped.videoMessage.caption?.trim(),
      };
    }

    if (unwrapped.audioMessage) {
      return {
        type: 'audio',
      };
    }

    if (unwrapped.documentMessage) {
      return {
        type: 'document',
        text: unwrapped.documentMessage.caption?.trim() || unwrapped.documentMessage.fileName,
      };
    }

    return { type: 'other' };
  }

  private static isInternalMessage(message: any): boolean {
    return Boolean(this.getInternalMessageReason(message));
  }

  private static getInternalMessageReason(message: any): string | null {
    if (message.protocolMessage) {
      return 'protocol_message';
    }

    if (message.senderKeyDistributionMessage) {
      return 'sender_key_distribution';
    }

    if (message.historySyncNotification) {
      return 'history_sync_notification';
    }

    return null;
  }

  private static unwrapMessage(message: any): any {
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
