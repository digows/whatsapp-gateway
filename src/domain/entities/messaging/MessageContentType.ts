/**
 * Supported content kinds handled by the gateway today.
 */
export enum MessageContentType {
  Text = 'text',
  Image = 'image',
  Audio = 'audio',
  Video = 'video',
  Document = 'document',
  Other = 'other',
}

export function parseMessageContentType(value: string): MessageContentType {
  switch (value) {
    case MessageContentType.Text:
      return MessageContentType.Text;
    case MessageContentType.Image:
      return MessageContentType.Image;
    case MessageContentType.Audio:
      return MessageContentType.Audio;
    case MessageContentType.Video:
      return MessageContentType.Video;
    case MessageContentType.Document:
      return MessageContentType.Document;
    case MessageContentType.Other:
      return MessageContentType.Other;
    default:
      throw new Error(`Unsupported message content type "${value}".`);
  }
}
