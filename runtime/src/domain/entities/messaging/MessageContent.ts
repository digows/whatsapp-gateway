import { MessageContentType } from './MessageContentType.js';
import { MessageReference } from './MessageReference.js';

export enum ButtonReplyType {
  Template = 'template',
  Plain = 'plain',
}

export function parseButtonReplyType(value: string): ButtonReplyType {
  switch (value) {
    case ButtonReplyType.Template:
      return ButtonReplyType.Template;
    case ButtonReplyType.Plain:
      return ButtonReplyType.Plain;
    default:
      throw new Error(`Unsupported button reply type "${value}".`);
  }
}

export enum EventCallType {
  Audio = 'audio',
  Video = 'video',
}

export function parseEventCallType(value: string): EventCallType {
  switch (value) {
    case EventCallType.Audio:
      return EventCallType.Audio;
    case EventCallType.Video:
      return EventCallType.Video;
    default:
      throw new Error(`Unsupported event call type "${value}".`);
  }
}

export enum PinMessageAction {
  PinForAll = 'pin_for_all',
  UnpinForAll = 'unpin_for_all',
}

export function parsePinMessageAction(value: string): PinMessageAction {
  switch (value) {
    case PinMessageAction.PinForAll:
      return PinMessageAction.PinForAll;
    case PinMessageAction.UnpinForAll:
      return PinMessageAction.UnpinForAll;
    default:
      throw new Error(`Unsupported pin message action "${value}".`);
  }
}

export enum PinMessageDurationSeconds {
  OneDay = 86400,
  SevenDays = 604800,
  ThirtyDays = 2592000,
}

export function parsePinMessageDurationSeconds(value: number): PinMessageDurationSeconds {
  switch (value) {
    case PinMessageDurationSeconds.OneDay:
      return PinMessageDurationSeconds.OneDay;
    case PinMessageDurationSeconds.SevenDays:
      return PinMessageDurationSeconds.SevenDays;
    case PinMessageDurationSeconds.ThirtyDays:
      return PinMessageDurationSeconds.ThirtyDays;
    default:
      throw new Error(`Unsupported pin duration "${value}".`);
  }
}

/**
 * Base class for one WhatsApp message payload.
 * Each subclass represents a concrete message shape instead of one bag of optional primitives.
 */
export abstract class MessageContent {
  protected constructor(public readonly type: MessageContentType) {}

  public getTextBody(): string | undefined {
    return undefined;
  }

  public canVaryText(): boolean {
    return false;
  }

  public withTextBody(_text: string): MessageContent {
    return this;
  }

  public getMediaUrl(): string | undefined {
    return undefined;
  }

  public getFileName(): string | undefined {
    return undefined;
  }

  public requiresMedia(): boolean {
    return false;
  }

  public fingerprint(): string {
    return [this.type, ...this.getFingerprintParts()].join(':');
  }

  protected getFingerprintParts(): readonly string[] {
    return [
      this.getMediaUrl() ?? '',
      this.getFileName() ?? '',
      this.getTextBody() ?? '',
    ];
  }
}

/**
 * Rich text message, including extended text metadata from WhatsApp when available.
 */
export class TextMessageContent extends MessageContent {
  constructor(
    public readonly text: string,
    public readonly matchedText?: string,
    public readonly title?: string,
    public readonly description?: string,
  ) {
    super(MessageContentType.Text);
  }

  public override getTextBody(): string {
    return this.text;
  }

  public override canVaryText(): boolean {
    return true;
  }

  public override withTextBody(text: string): TextMessageContent {
    return new TextMessageContent(text, this.matchedText, this.title, this.description);
  }

  protected override getFingerprintParts(): readonly string[] {
    return [this.text, this.matchedText ?? '', this.title ?? '', this.description ?? ''];
  }
}

/**
 * Image payload with caption and media source metadata.
 */
export class ImageMessageContent extends MessageContent {
  constructor(
    public readonly caption?: string,
    public readonly mediaUrl?: string,
    public readonly mimeType?: string,
    public readonly width?: number,
    public readonly height?: number,
  ) {
    super(MessageContentType.Image);
  }

  public override getTextBody(): string | undefined {
    return this.caption;
  }

  public override canVaryText(): boolean {
    return true;
  }

  public override withTextBody(text: string): ImageMessageContent {
    return new ImageMessageContent(text, this.mediaUrl, this.mimeType, this.width, this.height);
  }

  public override getMediaUrl(): string | undefined {
    return this.mediaUrl;
  }

  public override requiresMedia(): boolean {
    return true;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.mediaUrl ?? '',
      this.caption ?? '',
      this.mimeType ?? '',
      String(this.width ?? ''),
      String(this.height ?? ''),
    ];
  }
}

/**
 * Video payload with optional caption and video-specific flags.
 */
export class VideoMessageContent extends MessageContent {
  constructor(
    public readonly caption?: string,
    public readonly mediaUrl?: string,
    public readonly mimeType?: string,
    public readonly width?: number,
    public readonly height?: number,
    public readonly gifPlayback = false,
    public readonly videoNote = false,
  ) {
    super(MessageContentType.Video);
  }

  public override getTextBody(): string | undefined {
    return this.caption;
  }

  public override canVaryText(): boolean {
    return true;
  }

  public override withTextBody(text: string): VideoMessageContent {
    return new VideoMessageContent(
      text,
      this.mediaUrl,
      this.mimeType,
      this.width,
      this.height,
      this.gifPlayback,
      this.videoNote,
    );
  }

  public override getMediaUrl(): string | undefined {
    return this.mediaUrl;
  }

  public override requiresMedia(): boolean {
    return true;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.mediaUrl ?? '',
      this.caption ?? '',
      this.mimeType ?? '',
      String(this.width ?? ''),
      String(this.height ?? ''),
      String(this.gifPlayback),
      String(this.videoNote),
    ];
  }
}

/**
 * Audio payload, including voice note metadata when available.
 */
export class AudioMessageContent extends MessageContent {
  constructor(
    public readonly mediaUrl?: string,
    public readonly mimeType?: string,
    public readonly durationSeconds?: number,
    public readonly voiceNote = false,
  ) {
    super(MessageContentType.Audio);
  }

  public override getMediaUrl(): string | undefined {
    return this.mediaUrl;
  }

  public override requiresMedia(): boolean {
    return true;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.mediaUrl ?? '',
      this.mimeType ?? '',
      String(this.durationSeconds ?? ''),
      String(this.voiceNote),
    ];
  }
}

/**
 * File/document payload with optional caption.
 */
export class DocumentMessageContent extends MessageContent {
  constructor(
    public readonly caption?: string,
    public readonly mediaUrl?: string,
    public readonly fileName?: string,
    public readonly mimeType?: string,
  ) {
    super(MessageContentType.Document);
  }

  public override getTextBody(): string | undefined {
    return this.caption;
  }

  public override canVaryText(): boolean {
    return true;
  }

  public override withTextBody(text: string): DocumentMessageContent {
    return new DocumentMessageContent(text, this.mediaUrl, this.fileName, this.mimeType);
  }

  public override getMediaUrl(): string | undefined {
    return this.mediaUrl;
  }

  public override getFileName(): string | undefined {
    return this.fileName;
  }

  public override requiresMedia(): boolean {
    return true;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.mediaUrl ?? '',
      this.fileName ?? '',
      this.caption ?? '',
      this.mimeType ?? '',
    ];
  }
}

/**
 * Sticker payload. Animated stickers are explicitly tracked because they change rendering and media generation.
 */
export class StickerMessageContent extends MessageContent {
  constructor(
    public readonly mediaUrl?: string,
    public readonly mimeType?: string,
    public readonly animated = false,
    public readonly width?: number,
    public readonly height?: number,
  ) {
    super(MessageContentType.Sticker);
  }

  public override getMediaUrl(): string | undefined {
    return this.mediaUrl;
  }

  public override requiresMedia(): boolean {
    return true;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.mediaUrl ?? '',
      this.mimeType ?? '',
      String(this.animated),
      String(this.width ?? ''),
      String(this.height ?? ''),
    ];
  }
}

/**
 * One contact card inside a contacts payload.
 */
export class ContactCard {
  constructor(
    public readonly displayName?: string,
    public readonly vcard?: string,
  ) {}

  public fingerprint(): string {
    return `${this.displayName ?? ''}:${this.vcard ?? ''}`;
  }
}

/**
 * Single or multi-contact message payload.
 */
export class ContactsMessageContent extends MessageContent {
  constructor(
    public readonly contacts: readonly ContactCard[],
    public readonly displayName?: string,
  ) {
    super(MessageContentType.Contacts);
  }

  public override getTextBody(): string | undefined {
    return this.displayName ?? this.contacts[0]?.displayName;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.displayName ?? '',
      ...this.contacts.map(contact => contact.fingerprint()),
    ];
  }
}

/**
 * Static or live location payload.
 * Live-location-specific fields stay optional so inbound and outbound can share one entity cleanly.
 */
export class LocationMessageContent extends MessageContent {
  constructor(
    public readonly latitude: number,
    public readonly longitude: number,
    public readonly name?: string,
    public readonly address?: string,
    public readonly url?: string,
    public readonly comment?: string,
    public readonly live = false,
    public readonly accuracyInMeters?: number,
    public readonly speedInMetersPerSecond?: number,
    public readonly degreesClockwiseFromMagneticNorth?: number,
    public readonly sequenceNumber?: number,
    public readonly timeOffsetSeconds?: number,
  ) {
    super(MessageContentType.Location);
  }

  public override getTextBody(): string | undefined {
    return this.comment ?? this.name ?? this.address;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      String(this.latitude),
      String(this.longitude),
      this.name ?? '',
      this.address ?? '',
      this.url ?? '',
      this.comment ?? '',
      String(this.live),
      String(this.accuracyInMeters ?? ''),
      String(this.speedInMetersPerSecond ?? ''),
      String(this.degreesClockwiseFromMagneticNorth ?? ''),
      String(this.sequenceNumber ?? ''),
      String(this.timeOffsetSeconds ?? ''),
    ];
  }
}

/**
 * Reaction payload targeting an existing message.
 */
export class ReactionMessageContent extends MessageContent {
  constructor(
    public readonly targetMessage: MessageReference,
    public readonly reactionText?: string,
    public readonly removed = false,
  ) {
    super(MessageContentType.Reaction);
  }

  public override getTextBody(): string | undefined {
    return this.reactionText;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.targetMessage.messageId,
      this.targetMessage.remoteJid ?? '',
      this.targetMessage.participantId ?? '',
      this.reactionText ?? '',
      String(this.removed),
    ];
  }
}

/**
 * Poll option carried inside a poll creation message.
 */
export class PollOption {
  constructor(public readonly name: string) {
    if (!name.trim()) {
      throw new Error('PollOption requires a non-empty name.');
    }
  }
}

/**
 * Poll creation payload.
 */
export class PollMessageContent extends MessageContent {
  constructor(
    public readonly name: string,
    public readonly options: readonly PollOption[],
    public readonly selectableCount = 1,
  ) {
    super(MessageContentType.Poll);

    if (!name.trim()) {
      throw new Error('PollMessageContent requires a non-empty name.');
    }
  }

  public override getTextBody(): string {
    return this.name;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.name,
      String(this.selectableCount),
      ...this.options.map(option => option.name),
    ];
  }
}

/**
 * Reply to a button-based interactive message.
 */
export class ButtonReplyMessageContent extends MessageContent {
  constructor(
    public readonly buttonId: string,
    public readonly displayText: string,
    public readonly replyType: ButtonReplyType,
    public readonly buttonIndex?: number,
  ) {
    super(MessageContentType.ButtonReply);
  }

  public override getTextBody(): string {
    return this.displayText;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.buttonId,
      this.displayText,
      this.replyType,
      String(this.buttonIndex ?? ''),
    ];
  }
}

/**
 * Reply to a list selection message.
 */
export class ListReplyMessageContent extends MessageContent {
  constructor(
    public readonly selectedRowId: string,
    public readonly title?: string,
    public readonly description?: string,
  ) {
    super(MessageContentType.ListReply);
  }

  public override getTextBody(): string | undefined {
    return this.title ?? this.description;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [this.selectedRowId, this.title ?? '', this.description ?? ''];
  }
}

/**
 * Invite payload for a WhatsApp group.
 */
export class GroupInviteMessageContent extends MessageContent {
  constructor(
    public readonly groupJid: string,
    public readonly inviteCode: string,
    public readonly groupName?: string,
    public readonly caption?: string,
    public readonly inviteExpiration?: number,
  ) {
    super(MessageContentType.GroupInvite);
  }

  public override getTextBody(): string | undefined {
    return this.caption ?? this.groupName;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.groupJid,
      this.inviteCode,
      this.groupName ?? '',
      this.caption ?? '',
      String(this.inviteExpiration ?? ''),
    ];
  }
}

/**
 * Event creation payload used by WhatsApp scheduling/event messages.
 */
export class EventMessageContent extends MessageContent {
  constructor(
    public readonly name: string,
    public readonly startTimestamp?: number,
    public readonly description?: string,
    public readonly endTimestamp?: number,
    public readonly location?: LocationMessageContent,
    public readonly joinLink?: string,
    public readonly callType?: EventCallType,
    public readonly cancelled = false,
    public readonly scheduledCall = false,
    public readonly extraGuestsAllowed = false,
    public readonly hasReminder = false,
    public readonly reminderOffsetSeconds?: number,
  ) {
    super(MessageContentType.Event);
  }

  public override getTextBody(): string {
    return this.name;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.name,
      String(this.startTimestamp ?? ''),
      this.description ?? '',
      String(this.endTimestamp ?? ''),
      this.location?.fingerprint() ?? '',
      this.joinLink ?? '',
      this.callType ?? '',
      String(this.cancelled),
      String(this.scheduledCall),
      String(this.extraGuestsAllowed),
      String(this.hasReminder),
      String(this.reminderOffsetSeconds ?? ''),
    ];
  }
}

/**
 * Product payload used in catalog/business messages.
 */
export class ProductMessageContent extends MessageContent {
  constructor(
    public readonly productId?: string,
    public readonly title?: string,
    public readonly description?: string,
    public readonly currencyCode?: string,
    public readonly priceAmount1000?: number,
    public readonly retailerId?: string,
    public readonly url?: string,
    public readonly productImageUrl?: string,
    public readonly businessOwnerJid?: string,
    public readonly body?: string,
    public readonly footer?: string,
    public readonly catalogTitle?: string,
    public readonly catalogDescription?: string,
  ) {
    super(MessageContentType.Product);
  }

  public override getTextBody(): string | undefined {
    return this.title ?? this.body ?? this.description;
  }

  public override getMediaUrl(): string | undefined {
    return this.productImageUrl;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.productId ?? '',
      this.title ?? '',
      this.description ?? '',
      this.currencyCode ?? '',
      String(this.priceAmount1000 ?? ''),
      this.retailerId ?? '',
      this.url ?? '',
      this.productImageUrl ?? '',
      this.businessOwnerJid ?? '',
      this.body ?? '',
      this.footer ?? '',
      this.catalogTitle ?? '',
      this.catalogDescription ?? '',
    ];
  }
}

/**
 * Native flow / interactive response payload.
 */
export class InteractiveResponseMessageContent extends MessageContent {
  constructor(
    public readonly bodyText?: string,
    public readonly flowName?: string,
    public readonly parametersJson?: string,
    public readonly version?: number,
  ) {
    super(MessageContentType.InteractiveResponse);
  }

  public override getTextBody(): string | undefined {
    return this.bodyText;
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.bodyText ?? '',
      this.flowName ?? '',
      this.parametersJson ?? '',
      String(this.version ?? ''),
    ];
  }
}

function isSupportedInteractiveCarouselHeaderMediaType(type: MessageContentType): boolean {
  switch (type) {
    case MessageContentType.Image:
    case MessageContentType.Video:
    case MessageContentType.Document:
    case MessageContentType.Location:
    case MessageContentType.Product:
      return true;
    default:
      return false;
  }
}

/**
 * Button definition used by a native-flow interactive carousel card.
 */
export class InteractiveCarouselNativeFlowButton {
  constructor(
    public readonly name: string,
    public readonly buttonParamsJson: string,
  ) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('InteractiveCarouselNativeFlowButton requires a non-empty name.');
    }

    if (typeof buttonParamsJson !== 'string' || !buttonParamsJson.trim()) {
      throw new Error('InteractiveCarouselNativeFlowButton requires buttonParamsJson.');
    }
  }

  public fingerprint(): string {
    return [this.name, this.buttonParamsJson].join(':');
  }
}

/**
 * Native flow actions attached to a carousel card.
 */
export class InteractiveCarouselNativeFlowMessageContent {
  constructor(
    public readonly buttons: readonly InteractiveCarouselNativeFlowButton[],
    public readonly messageParamsJson?: string,
    public readonly messageVersion = 1,
  ) {
    if (!Array.isArray(buttons) || !buttons.length) {
      throw new Error('InteractiveCarouselNativeFlowMessageContent requires at least one button.');
    }
  }

  public fingerprint(): string {
    return [
      String(this.messageVersion),
      this.messageParamsJson ?? '',
      ...this.buttons.map(button => button.fingerprint()),
    ].join('|');
  }
}

/**
 * One interactive carousel card.
 */
export class InteractiveCarouselCardContent {
  constructor(
    public readonly headerTitle: string | undefined,
    public readonly headerSubtitle: string | undefined,
    public readonly headerMedia: MessageContent | undefined,
    public readonly bodyText: string | undefined,
    public readonly footerText: string | undefined,
    public readonly nativeFlowMessage: InteractiveCarouselNativeFlowMessageContent,
  ) {
    if (!nativeFlowMessage) {
      throw new Error('InteractiveCarouselCardContent requires nativeFlowMessage.');
    }

    if (!headerTitle?.trim() && !headerMedia) {
      throw new Error('InteractiveCarouselCardContent requires a headerTitle or headerMedia.');
    }

    if (headerMedia && !isSupportedInteractiveCarouselHeaderMediaType(headerMedia.type)) {
      throw new Error(`Unsupported interactive carousel header media type "${headerMedia.type}".`);
    }
  }

  public fingerprint(): string {
    return [
      this.headerTitle ?? '',
      this.headerSubtitle ?? '',
      this.headerMedia?.fingerprint() ?? '',
      this.bodyText ?? '',
      this.footerText ?? '',
      this.nativeFlowMessage.fingerprint(),
    ].join('|');
  }
}

/**
 * Carousel of interactive cards rendered by WhatsApp.
 */
export class InteractiveCarouselMessageContent extends MessageContent {
  constructor(
    public readonly bodyText?: string,
    public readonly footerText?: string,
    public readonly cards: readonly InteractiveCarouselCardContent[] = [],
    public readonly messageVersion = 1,
  ) {
    super(MessageContentType.InteractiveCarousel);

    if (!Array.isArray(cards) || !cards.length) {
      throw new Error('InteractiveCarouselMessageContent requires at least one card.');
    }
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      String(this.messageVersion),
      this.bodyText ?? '',
      this.footerText ?? '',
      ...this.cards.map(card => card.fingerprint()),
    ];
  }
}

/**
 * Request for the remote party to share a phone number.
 */
export class RequestPhoneNumberMessageContent extends MessageContent {
  constructor() {
    super(MessageContentType.RequestPhoneNumber);
  }
}

/**
 * Explicit share-phone-number message.
 */
export class SharePhoneNumberMessageContent extends MessageContent {
  constructor() {
    super(MessageContentType.SharePhoneNumber);
  }
}

/**
 * Delete/revoke an existing message from a chat.
 */
export class DeleteMessageContent extends MessageContent {
  constructor(public readonly targetMessage: MessageReference) {
    super(MessageContentType.Delete);
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.targetMessage.messageId,
      this.targetMessage.remoteJid ?? '',
      this.targetMessage.participantId ?? '',
    ];
  }
}

/**
 * Pin or unpin an existing message inside a chat.
 */
export class PinMessageContent extends MessageContent {
  constructor(
    public readonly targetMessage: MessageReference,
    public readonly action: PinMessageAction,
    public readonly durationSeconds?: PinMessageDurationSeconds,
  ) {
    super(MessageContentType.Pin);
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      this.targetMessage.messageId,
      this.targetMessage.remoteJid ?? '',
      this.targetMessage.participantId ?? '',
      this.action,
      String(this.durationSeconds ?? ''),
    ];
  }
}

/**
 * Change chat disappearing-message retention for subsequent messages.
 * A value of 0 disables the setting.
 */
export class DisappearingMessagesMessageContent extends MessageContent {
  constructor(public readonly expirationSeconds: number) {
    super(MessageContentType.DisappearingMessages);
  }

  protected override getFingerprintParts(): readonly string[] {
    return [String(this.expirationSeconds)];
  }
}

/**
 * Change the chat limit-sharing setting.
 */
export class LimitSharingMessageContent extends MessageContent {
  constructor(
    public readonly sharingLimited: boolean,
    public readonly updatedTimestamp?: number,
    public readonly initiatedByMe?: boolean,
  ) {
    super(MessageContentType.LimitSharing);
  }

  protected override getFingerprintParts(): readonly string[] {
    return [
      String(this.sharingLimited),
      String(this.updatedTimestamp ?? ''),
      String(this.initiatedByMe ?? ''),
    ];
  }
}

/**
 * Unsupported or not-yet-modeled WhatsApp payload.
 * The description is preserved so the boundary can still communicate what arrived.
 */
export class OtherMessageContent extends MessageContent {
  constructor(public readonly description?: string) {
    super(MessageContentType.Other);
  }

  protected override getFingerprintParts(): readonly string[] {
    return [this.description ?? ''];
  }
}
