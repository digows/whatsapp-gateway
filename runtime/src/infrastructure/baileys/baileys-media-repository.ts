import { type MediaReference, type MediaSource, MediaSourceSchema } from "@digows/whatsapp-gateway-contracts";
import {
  BufferJSON,
  DEF_MEDIA_HOST,
  downloadContentFromMessage,
  normalizeMessageContent,
  proto,
  toBuffer,
} from "baileys";
import { encodeWhatsAppMediaSource, type WhatsAppMediaSourceIdentity } from "../../domain/media-source.ts";
import type { IMediaRepository } from "../../domain/media-storage.ts";

export type NativeMedia =
  | proto.Message.IImageMessage
  | proto.Message.IVideoMessage
  | proto.Message.IAudioMessage
  | proto.Message.IDocumentMessage
  | proto.Message.IStickerMessage;
type NativeMediaKind = "image" | "video" | "audio" | "document" | "sticker" | "thumbnail-link";

interface NativeMediaPart
{
  readonly source: NativeMedia;
  readonly kind: NativeMediaKind;
  readonly inlineBytes?: Uint8Array;
}

export function nativeMediaSource(identity: WhatsAppMediaSourceIdentity, source: NativeMedia): MediaSource
{
  if (!source.mimetype) throw new Error("Native media content type is missing");
  const length = source.fileLength;
  return MediaSourceSchema.parse({
    sourceId: encodeWhatsAppMediaSource(identity),
    contentType: source.mimetype,
    ...(length === null || length === undefined
      ? {}
      : { byteSize: typeof length === "number" ? length : length.toNumber() }),
    ...("fileName" in source && source.fileName ? { fileName: source.fileName } : {}),
  });
}

function nativeMediaPart(content: proto.IMessage, partId: string): NativeMediaPart
{
  if (partId === "0")
  {
    if (content.imageMessage) return { source: content.imageMessage, kind: "image" };
    const video = content.videoMessage ?? content.ptvMessage;
    if (video) return { source: video, kind: "video" };
    if (content.audioMessage) return { source: content.audioMessage, kind: "audio" };
    if (content.documentMessage) return { source: content.documentMessage, kind: "document" };
    if (content.stickerMessage) return { source: content.stickerMessage, kind: "sticker" };
  }
  if (partId === "thumbnail")
  {
    const image = content.buttonsMessage?.imageMessage ?? content.interactiveMessage?.header?.imageMessage;
    if (image) return { source: image, kind: "image" };
    const extended = content.extendedTextMessage;
    if (extended?.jpegThumbnail?.byteLength)
    {
      return {
        source: { mimetype: "image/jpeg", fileLength: extended.jpegThumbnail.byteLength },
        kind: "thumbnail-link",
        inlineBytes: extended.jpegThumbnail,
      };
    }
    if (extended?.thumbnailDirectPath)
    {
      return {
        source: {
          directPath: extended.thumbnailDirectPath,
          mediaKey: extended.mediaKey ?? null,
          mimetype: "image/jpeg",
        },
        kind: "thumbnail-link",
      };
    }
  }
  if (/^card-(?:0|[1-9][0-9]*)$/u.test(partId))
  {
    const image = content.interactiveMessage?.carouselMessage?.cards?.[Number(partId.slice(5))]?.header
      ?.imageMessage;
    if (image) return { source: image, kind: "image" };
  }
  throw new Error("WhatsApp media source part is unavailable");
}

export class BaileysMediaRepository
{
  constructor(private readonly media: IMediaRepository)
  {}

  async materialize(identity: WhatsAppMediaSourceIdentity, serializedMessage: string): Promise<MediaReference>
  {
    const value: unknown = JSON.parse(serializedMessage, BufferJSON.reviver);
    if (typeof value !== "object" || value === null || Array.isArray(value))
    {
      throw new Error("WhatsApp media source input is invalid");
    }
    const message = proto.WebMessageInfo.fromObject(value);
    if (message.key?.id !== identity.messageId)
    {
      throw new Error("WhatsApp media source message differs from its input");
    }
    const original = message.message;
    const content = normalizeMessageContent(original);
    if (!content) throw new Error("WhatsApp media source content is unavailable");
    if (original?.viewOnceMessage || original?.viewOnceMessageV2 || original?.viewOnceMessageV2Extension)
    {
      throw new Error("View-once media is outside the approved profiles");
    }
    const part = nativeMediaPart(content, identity.partId);
    const source = nativeMediaSource(identity, part.source);
    const legacyMediaHost = part.source.directPath && part.source.url && URL.canParse(part.source.url)
      && new URL(part.source.url).hostname === "a.whatsapp.net";
    const bytes = part.inlineBytes
      ?? await toBuffer(
        await downloadContentFromMessage(part.source, part.kind, {
          ...(legacyMediaHost ? { host: DEF_MEDIA_HOST } : {}),
          options: { signal: AbortSignal.timeout(60000) },
        }),
      );
    const storageKey = `media/whatsapp/${identity.workspaceId}/${identity.accountId}/${
      encodeURIComponent(identity.messageId)
    }/${identity.partId}`;
    return this.media.write(storageKey, bytes, source.contentType, source.fileName);
  }
}
