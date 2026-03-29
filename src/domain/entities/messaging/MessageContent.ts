import { MessageContentType } from './MessageContentType.js';

/**
 * Content payload for one WhatsApp message.
 * The same entity is reused for inbound normalization and outbound sending.
 */
export class MessageContent {
  constructor(
    public readonly type: MessageContentType,
    public readonly text?: string,
    public readonly mediaUrl?: string,
    public readonly fileName?: string,
  ) {}

  public static text(text: string): MessageContent {
    return new MessageContent(MessageContentType.Text, text);
  }

  public static image(caption?: string, mediaUrl?: string): MessageContent {
    return new MessageContent(MessageContentType.Image, caption, mediaUrl);
  }

  public static audio(mediaUrl?: string): MessageContent {
    return new MessageContent(MessageContentType.Audio, undefined, mediaUrl);
  }

  public static video(caption?: string, mediaUrl?: string): MessageContent {
    return new MessageContent(MessageContentType.Video, caption, mediaUrl);
  }

  public static document(
    caption?: string,
    mediaUrl?: string,
    fileName?: string,
  ): MessageContent {
    return new MessageContent(MessageContentType.Document, caption, mediaUrl, fileName);
  }

  public static other(): MessageContent {
    return new MessageContent(MessageContentType.Other);
  }

  public requiresMedia(): boolean {
    return this.type !== MessageContentType.Text && this.type !== MessageContentType.Other;
  }
}
