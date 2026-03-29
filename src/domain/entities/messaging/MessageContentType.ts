/**
 * Supported message content kinds represented by the gateway domain.
 */
export enum MessageContentType {
  Text = 'text',
  Image = 'image',
  Audio = 'audio',
  Video = 'video',
  Document = 'document',
  Sticker = 'sticker',
  Contacts = 'contacts',
  Location = 'location',
  Reaction = 'reaction',
  Poll = 'poll',
  ButtonReply = 'button_reply',
  ListReply = 'list_reply',
  GroupInvite = 'group_invite',
  Event = 'event',
  Product = 'product',
  InteractiveResponse = 'interactive_response',
  RequestPhoneNumber = 'request_phone_number',
  SharePhoneNumber = 'share_phone_number',
  Delete = 'delete',
  Pin = 'pin',
  DisappearingMessages = 'disappearing_messages',
  LimitSharing = 'limit_sharing',
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
    case MessageContentType.Sticker:
      return MessageContentType.Sticker;
    case MessageContentType.Contacts:
      return MessageContentType.Contacts;
    case MessageContentType.Location:
      return MessageContentType.Location;
    case MessageContentType.Reaction:
      return MessageContentType.Reaction;
    case MessageContentType.Poll:
      return MessageContentType.Poll;
    case MessageContentType.ButtonReply:
      return MessageContentType.ButtonReply;
    case MessageContentType.ListReply:
      return MessageContentType.ListReply;
    case MessageContentType.GroupInvite:
      return MessageContentType.GroupInvite;
    case MessageContentType.Event:
      return MessageContentType.Event;
    case MessageContentType.Product:
      return MessageContentType.Product;
    case MessageContentType.InteractiveResponse:
      return MessageContentType.InteractiveResponse;
    case MessageContentType.RequestPhoneNumber:
      return MessageContentType.RequestPhoneNumber;
    case MessageContentType.SharePhoneNumber:
      return MessageContentType.SharePhoneNumber;
    case MessageContentType.Delete:
      return MessageContentType.Delete;
    case MessageContentType.Pin:
      return MessageContentType.Pin;
    case MessageContentType.DisappearingMessages:
      return MessageContentType.DisappearingMessages;
    case MessageContentType.LimitSharing:
      return MessageContentType.LimitSharing;
    case MessageContentType.Other:
      return MessageContentType.Other;
    default:
      throw new Error(`Unsupported message content type "${value}".`);
  }
}
