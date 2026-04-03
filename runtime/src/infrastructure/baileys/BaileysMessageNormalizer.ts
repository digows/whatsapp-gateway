import {proto} from 'baileys';
import {
  AudioMessageContent,
  ButtonReplyMessageContent,
  ButtonReplyType,
  ContactCard,
  ContactsMessageContent,
  DeleteMessageContent,
  DisappearingMessagesMessageContent,
  DocumentMessageContent,
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
  PinMessageDurationSeconds,
  PollMessageContent,
  PollOption,
  ProductMessageContent,
  ReactionMessageContent,
  RequestPhoneNumberMessageContent,
  SharePhoneNumberMessageContent,
  StickerMessageContent,
  TextMessageContent,
  VideoMessageContent,
} from '../../domain/entities/messaging/MessageContent.js';
import {ChatType, MessageContext,} from '../../domain/entities/messaging/MessageContext.js';
import {Message} from '../../domain/entities/messaging/Message.js';
import {MessageReference} from '../../domain/entities/messaging/MessageReference.js';
import {QuotedMessage} from '../../domain/entities/messaging/QuotedMessage.js';

type ResolvePhoneFn = (
  jid: string | null | undefined,
  altJid?: string | null,
) => Promise<string | null>;

export class BaileysMessageNormalizer {
  public static async normalize(
    message: any,
    resolvePhone: ResolvePhoneFn,
  ): Promise<Message | null> {
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
      chatType === ChatType.Direct
        ? await resolvePhone(rawChatId, message.key.remoteJidAlt)
        : null;

    const chatId = chatPhone || rawChatId;
    const senderId = senderPhone || rawSenderId;
    const participantId = rawParticipantId
      ? senderPhone || rawParticipantId
      : undefined;

    const unwrappedMessage = this.unwrapMessage(message.message);
    const content = this.extractContent(unwrappedMessage, rawChatId);
    if (!content) {
      return null;
    }

    const contextInfo = this.extractContextInfo(unwrappedMessage);

    return new Message(
      chatId,
      new Date(
        Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      ).toISOString(),
      content,
      messageId,
      senderId,
      participantId,
      new MessageContext(
        chatType,
        rawChatId,
        rawParticipantId,
        senderPhone ?? undefined,
        this.extractMentionedJids(contextInfo),
        this.extractQuotedMessage(contextInfo),
        this.extractEditTarget(message.message, rawChatId),
        contextInfo?.isForwarded === true,
        this.readOptionalNumber(contextInfo?.forwardingScore),
        this.readOptionalNumber(contextInfo?.expiration),
        this.isViewOnceEnvelope(message.message) || message?.key?.isViewOnce === true,
      ),
    );
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
      return ChatType.Group;
    }

    if (jid.endsWith('@broadcast')) {
      return ChatType.Broadcast;
    }

    if (
      jid.endsWith('@s.whatsapp.net')
      || jid.endsWith('@lid')
      || jid.endsWith('@hosted.lid')
    ) {
      return ChatType.Direct;
    }

    return ChatType.Unknown;
  }

  private static extractContent(message: any, rawChatId?: string): MessageContent | null {
    const unwrapped = this.unwrapMessage(message);
    if (!unwrapped) {
      return null;
    }

    const protocolMessageContent = this.extractProtocolMessageContent(unwrapped, rawChatId);
    if (protocolMessageContent) {
      return protocolMessageContent;
    }

    if (this.getInternalMessageReason(unwrapped)) {
      return null;
    }

    if (unwrapped.conversation || unwrapped.extendedTextMessage?.text) {
      return new TextMessageContent(
        (unwrapped.conversation || unwrapped.extendedTextMessage?.text || '').trim(),
        unwrapped.extendedTextMessage?.matchedText,
        unwrapped.extendedTextMessage?.title,
        unwrapped.extendedTextMessage?.description,
      );
    }

    if (unwrapped.imageMessage) {
      return new ImageMessageContent(
        unwrapped.imageMessage.caption?.trim(),
        undefined,
        unwrapped.imageMessage.mimetype,
        this.readOptionalNumber(unwrapped.imageMessage.width),
        this.readOptionalNumber(unwrapped.imageMessage.height),
      );
    }

    if (unwrapped.videoMessage) {
      return new VideoMessageContent(
        unwrapped.videoMessage.caption?.trim(),
        undefined,
        unwrapped.videoMessage.mimetype,
        this.readOptionalNumber(unwrapped.videoMessage.width),
        this.readOptionalNumber(unwrapped.videoMessage.height),
        unwrapped.videoMessage.gifPlayback === true,
        unwrapped.videoMessage.ptv === true,
      );
    }

    if (unwrapped.audioMessage) {
      return new AudioMessageContent(
        undefined,
        unwrapped.audioMessage.mimetype,
        this.readOptionalNumber(unwrapped.audioMessage.seconds),
        unwrapped.audioMessage.ptt === true,
      );
    }

    if (unwrapped.documentMessage) {
      return new DocumentMessageContent(
        unwrapped.documentMessage.caption?.trim(),
        undefined,
        unwrapped.documentMessage.fileName,
        unwrapped.documentMessage.mimetype,
      );
    }

    if (unwrapped.stickerMessage) {
      return new StickerMessageContent(
        undefined,
        unwrapped.stickerMessage.mimetype,
        unwrapped.stickerMessage.isAnimated === true,
        this.readOptionalNumber(unwrapped.stickerMessage.width),
        this.readOptionalNumber(unwrapped.stickerMessage.height),
      );
    }

    if (unwrapped.locationMessage) {
      return this.buildLocationContent(unwrapped.locationMessage);
    }

    if (unwrapped.liveLocationMessage) {
      return this.buildLocationContent(unwrapped.liveLocationMessage, true);
    }

    if (unwrapped.contactMessage) {
      return new ContactsMessageContent(
        [
          new ContactCard(
            unwrapped.contactMessage.displayName,
            unwrapped.contactMessage.vcard,
          ),
        ],
        unwrapped.contactMessage.displayName,
      );
    }

    if (unwrapped.contactsArrayMessage) {
      const contacts = Array.isArray(unwrapped.contactsArrayMessage.contacts)
        ? unwrapped.contactsArrayMessage.contacts.map((contact: any) => new ContactCard(
          contact?.displayName,
          contact?.vcard,
        ))
        : [];

      return new ContactsMessageContent(
        contacts,
        unwrapped.contactsArrayMessage.displayName,
      );
    }

    if (unwrapped.reactionMessage?.key?.id) {
      return new ReactionMessageContent(
        new MessageReference(
          unwrapped.reactionMessage.key.id,
          unwrapped.reactionMessage.key.remoteJid ?? undefined,
          unwrapped.reactionMessage.key.participant ?? undefined,
        ),
        unwrapped.reactionMessage.text || undefined,
        !unwrapped.reactionMessage.text,
      );
    }

    const pollMessage =
      unwrapped.pollCreationMessage
      || unwrapped.pollCreationMessageV2
      || unwrapped.pollCreationMessageV3
      || unwrapped.pollCreationMessageV5;
    if (pollMessage?.name) {
      return new PollMessageContent(
        pollMessage.name,
        Array.isArray(pollMessage.options)
          ? pollMessage.options
            .map((option: any) => option?.optionName)
            .filter((optionName: unknown): optionName is string => typeof optionName === 'string' && optionName.trim().length > 0)
            .map(optionName => new PollOption(optionName))
          : [],
        this.readOptionalNumber(pollMessage.selectableOptionsCount) ?? 1,
      );
    }

    if (unwrapped.buttonsResponseMessage?.selectedButtonId) {
      return new ButtonReplyMessageContent(
        unwrapped.buttonsResponseMessage.selectedButtonId,
        unwrapped.buttonsResponseMessage.selectedDisplayText ?? '',
        ButtonReplyType.Plain,
      );
    }

    if (unwrapped.templateButtonReplyMessage?.selectedId) {
      return new ButtonReplyMessageContent(
        unwrapped.templateButtonReplyMessage.selectedId,
        unwrapped.templateButtonReplyMessage.selectedDisplayText ?? '',
        ButtonReplyType.Template,
        this.readOptionalNumber(unwrapped.templateButtonReplyMessage.selectedIndex),
      );
    }

    if (unwrapped.listResponseMessage?.singleSelectReply?.selectedRowId) {
      return new ListReplyMessageContent(
        unwrapped.listResponseMessage.singleSelectReply.selectedRowId,
        unwrapped.listResponseMessage.title,
        unwrapped.listResponseMessage.description,
      );
    }

    if (
      unwrapped.interactiveResponseMessage?.body?.text
      || unwrapped.interactiveResponseMessage?.nativeFlowResponseMessage?.name
    ) {
      return new InteractiveResponseMessageContent(
        unwrapped.interactiveResponseMessage.body?.text ?? undefined,
        unwrapped.interactiveResponseMessage.nativeFlowResponseMessage?.name ?? undefined,
        unwrapped.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson ?? undefined,
        this.readOptionalNumber(unwrapped.interactiveResponseMessage.nativeFlowResponseMessage?.version),
      );
    }

    if (unwrapped.groupInviteMessage?.inviteCode && unwrapped.groupInviteMessage?.groupJid) {
      return new GroupInviteMessageContent(
        unwrapped.groupInviteMessage.groupJid,
        unwrapped.groupInviteMessage.inviteCode,
        unwrapped.groupInviteMessage.groupName ?? undefined,
        unwrapped.groupInviteMessage.caption ?? undefined,
        this.readOptionalNumber(unwrapped.groupInviteMessage.inviteExpiration),
      );
    }

    if (unwrapped.eventMessage?.name) {
      return new EventMessageContent(
        unwrapped.eventMessage.name,
        this.readOptionalNumber(unwrapped.eventMessage.startTime),
        unwrapped.eventMessage.description ?? undefined,
        this.readOptionalNumber(unwrapped.eventMessage.endTime),
        this.buildLocationContent(unwrapped.eventMessage.location),
        unwrapped.eventMessage.joinLink ?? undefined,
        undefined,
        unwrapped.eventMessage.isCanceled === true,
        unwrapped.eventMessage.isScheduleCall === true,
        unwrapped.eventMessage.extraGuestsAllowed === true,
        unwrapped.eventMessage.hasReminder === true,
        this.readOptionalNumber(unwrapped.eventMessage.reminderOffsetSec),
      );
    }

    if (unwrapped.productMessage) {
      return new ProductMessageContent(
        unwrapped.productMessage.product?.productId ?? undefined,
        unwrapped.productMessage.product?.title ?? undefined,
        unwrapped.productMessage.product?.description ?? undefined,
        unwrapped.productMessage.product?.currencyCode ?? undefined,
        this.readOptionalNumber(unwrapped.productMessage.product?.priceAmount1000),
        unwrapped.productMessage.product?.retailerId ?? undefined,
        unwrapped.productMessage.product?.url ?? undefined,
        undefined,
        unwrapped.productMessage.businessOwnerJid ?? undefined,
        unwrapped.productMessage.body ?? undefined,
        unwrapped.productMessage.footer ?? undefined,
        unwrapped.productMessage.catalog?.title ?? undefined,
        unwrapped.productMessage.catalog?.description ?? undefined,
      );
    }

    if (unwrapped.requestPhoneNumberMessage) {
      return new RequestPhoneNumberMessageContent();
    }

    if (unwrapped.pinInChatMessage?.key?.id) {
      return this.extractPinMessageContent(unwrapped.pinInChatMessage, unwrapped, rawChatId);
    }

    if (unwrapped.templateMessage) {
      return new OtherMessageContent('template_message');
    }

    if (unwrapped.buttonsMessage) {
      return new OtherMessageContent('buttons_message');
    }

    if (unwrapped.listMessage) {
      return new OtherMessageContent('list_message');
    }

    if (unwrapped.interactiveMessage) {
      return new OtherMessageContent('interactive_message');
    }

    return new OtherMessageContent(this.describeFirstContentKey(unwrapped));
  }

  private static extractProtocolMessageContent(
    message: any,
    rawChatId?: string,
  ): MessageContent | null {
    const protocolMessage = message?.protocolMessage;
    if (!this.isRecord(protocolMessage)) {
      return null;
    }

    switch (protocolMessage.type) {
      case proto.Message.ProtocolMessage.Type.REVOKE:
        if (!protocolMessage.key?.id) {
          return null;
        }

        return new DeleteMessageContent(
          new MessageReference(
            protocolMessage.key.id,
            protocolMessage.key.remoteJid ?? rawChatId,
            protocolMessage.key.participant ?? undefined,
          ),
        );
      case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
        return new DisappearingMessagesMessageContent(
          this.readOptionalNumber(protocolMessage.ephemeralExpiration) ?? 0,
        );
      case proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER:
        return new SharePhoneNumberMessageContent();
      case proto.Message.ProtocolMessage.Type.LIMIT_SHARING:
        return new LimitSharingMessageContent(
          protocolMessage.limitSharing?.sharingLimited === true,
          this.readOptionalNumber(protocolMessage.limitSharing?.limitSharingSettingTimestamp),
          protocolMessage.limitSharing?.initiatedByMe === true,
        );
      default:
        return null;
    }
  }

  private static extractPinMessageContent(
    pinInChatMessage: any,
    message: any,
    rawChatId?: string,
  ): PinMessageContent | null {
    if (!pinInChatMessage?.key?.id) {
      return null;
    }

    const pinAction = this.parsePinMessageAction(pinInChatMessage.type);
    if (!pinAction) {
      return null;
    }
    const rawDuration =
      this.readOptionalNumber(pinInChatMessage.messageAddOnContextInfo?.messageAddOnDurationInSecs)
      ?? this.readOptionalNumber(message?.messageContextInfo?.messageAddOnDurationInSecs);

    return new PinMessageContent(
      new MessageReference(
        pinInChatMessage.key.id,
        pinInChatMessage.key.remoteJid ?? rawChatId,
        pinInChatMessage.key.participant ?? undefined,
      ),
      pinAction,
      rawDuration == null || rawDuration === 0
        ? undefined
        : this.parsePinMessageDuration(rawDuration),
    );
  }

  private static buildLocationContent(
    locationMessage: any,
    forceLive = false,
  ): LocationMessageContent | null {
    const latitude = this.readOptionalNumber(locationMessage?.degreesLatitude);
    const longitude = this.readOptionalNumber(locationMessage?.degreesLongitude);

    if (latitude == null || longitude == null) {
      return null;
    }

    return new LocationMessageContent(
      latitude,
      longitude,
      locationMessage?.name ?? undefined,
      locationMessage?.address ?? undefined,
      locationMessage?.url ?? undefined,
      locationMessage?.comment ?? locationMessage?.caption ?? undefined,
      forceLive || locationMessage?.isLive === true,
      this.readOptionalNumber(locationMessage?.accuracyInMeters),
      this.readOptionalNumber(locationMessage?.speedInMps),
      this.readOptionalNumber(locationMessage?.degreesClockwiseFromMagneticNorth),
      this.readOptionalNumber(locationMessage?.sequenceNumber),
      this.readOptionalNumber(locationMessage?.timeOffset),
    );
  }

  private static extractContextInfo(message: any): any | undefined {
    if (!this.isRecord(message)) {
      return undefined;
    }

    if (this.isRecord(message.contextInfo)) {
      return message.contextInfo;
    }

    for (const value of Object.values(message)) {
      if (this.isRecord(value) && this.isRecord(value.contextInfo)) {
        return value.contextInfo;
      }
    }

    return undefined;
  }

  private static extractMentionedJids(contextInfo: any): string[] {
    if (!Array.isArray(contextInfo?.mentionedJid)) {
      return [];
    }

    return contextInfo.mentionedJid.filter(
      (jid: unknown): jid is string => typeof jid === 'string' && jid.length > 0,
    );
  }

  private static extractQuotedMessage(contextInfo: any): QuotedMessage | undefined {
    if (typeof contextInfo?.stanzaId !== 'string' || !contextInfo.stanzaId.trim()) {
      return undefined;
    }

    return new QuotedMessage(
      new MessageReference(
        contextInfo.stanzaId,
        typeof contextInfo.remoteJid === 'string' ? contextInfo.remoteJid : undefined,
        typeof contextInfo.participant === 'string' ? contextInfo.participant : undefined,
      ),
      contextInfo.quotedMessage
        ? this.extractContent(contextInfo.quotedMessage) ?? undefined
        : undefined,
    );
  }

  private static extractEditTarget(
    message: any,
    rawChatId?: string,
  ): MessageReference | undefined {
    const protocolMessage = message?.editedMessage?.message?.protocolMessage;
    if (!this.isRecord(protocolMessage) || protocolMessage.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
      return undefined;
    }

    if (!protocolMessage.key?.id) {
      return undefined;
    }

    return new MessageReference(
      protocolMessage.key.id,
      protocolMessage.key.remoteJid ?? rawChatId,
      protocolMessage.key.participant ?? undefined,
    );
  }

  private static getInternalMessageReason(message: any): string | null {
    if (message.protocolMessage && !this.extractProtocolMessageContent(message)) {
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

  private static isViewOnceEnvelope(message: any): boolean {
    if (!message || typeof message !== 'object') {
      return false;
    }

    return Boolean(
      message.viewOnceMessage?.message
      || message.viewOnceMessageV2?.message,
    );
  }

  private static parsePinMessageAction(value: unknown): PinMessageAction | undefined {
    switch (value) {
      case proto.PinInChat.Type.PIN_FOR_ALL:
        return PinMessageAction.PinForAll;
      case proto.PinInChat.Type.UNPIN_FOR_ALL:
        return PinMessageAction.UnpinForAll;
      default:
        return undefined;
    }
  }

  private static parsePinMessageDuration(value: number): PinMessageDurationSeconds | undefined {
    switch (value) {
      case PinMessageDurationSeconds.OneDay:
        return PinMessageDurationSeconds.OneDay;
      case PinMessageDurationSeconds.SevenDays:
        return PinMessageDurationSeconds.SevenDays;
      case PinMessageDurationSeconds.ThirtyDays:
        return PinMessageDurationSeconds.ThirtyDays;
      default:
        return undefined;
    }
  }

  private static describeFirstContentKey(message: Record<string, unknown>): string | undefined {
    const keys = Object.keys(message).filter(key => Boolean(message[key]));
    return keys[0];
  }

  private static readOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : undefined;
  }

  private static isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
