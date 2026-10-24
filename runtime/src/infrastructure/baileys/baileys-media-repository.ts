import { type MediaReference, type MediaSource, MediaSourceSchema } from "@digows/whatsapp-gateway-contracts";
import { BufferJSON, normalizeMessageContent, proto } from "baileys";
import { createHash, timingSafeEqual } from "node:crypto";
import { defaultMaximumMediaBytes, validateMediaLimit } from "../../domain/media-bytes.ts";
import { encodeWhatsAppMediaSource, type WhatsAppMediaSourceIdentity } from "../../domain/media-source.ts";
import type { IMediaRepository } from "../../domain/media-storage.ts";
import { downloadNativeMedia } from "./baileys-media-download.ts";

export type NativeMedia =
  | proto.Message.IImageMessage
  | proto.Message.IVideoMessage
  | proto.Message.IAudioMessage
  | proto.Message.IDocumentMessage
  | proto.Message.IStickerMessage;
type NativeMediaKind = "image" | "video" | "audio" | "document" | "sticker" | "thumbnail-link";

interface ResolvedNativeMedia
{
  readonly part: NativeMediaPart;
  readonly source: MediaSource;
}

interface NativeMediaPart
{
  readonly source: NativeMedia;
  readonly kind: NativeMediaKind;
  readonly inlineBytes?: Uint8Array;
}

export function nativeMediaSource(identity: WhatsAppMediaSourceIdentity, source: NativeMedia): MediaSource
{
  if (!source.mimetype) throw new Error("Native media content type is missing");
  const length = Object.hasOwn(source, "fileLength") ? source.fileLength : undefined;
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
  constructor(
    private readonly media?: IMediaRepository,
    private readonly maximumBytes = defaultMaximumMediaBytes,
    private readonly timeoutMs = 60000,
  )
  {
    validateMediaLimit(maximumBytes);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    {
      throw new Error("Media timeout must be a positive safe integer");
    }
  }

  private resolve(identity: WhatsAppMediaSourceIdentity, serializedMessage: string): ResolvedNativeMedia
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
    if (source.byteSize !== undefined && source.byteSize > this.maximumBytes)
    {
      throw new Error("Media exceeds configured byte limit");
    }
    return { part, source };
  }
  private async download(resolved: ResolvedNativeMedia): Promise<Uint8Array>
  {
    const { part, source } = resolved;
    const bytes = part.inlineBytes
      ?? await downloadNativeMedia(part.source, part.kind, this.maximumBytes, this.timeoutMs);
    if (bytes.byteLength > this.maximumBytes) throw new Error("Media exceeds configured byte limit");
    if (source.byteSize !== undefined && source.byteSize !== bytes.byteLength)
    {
      throw new Error("WhatsApp media size does not match its source");
    }
    const expectedHash = part.source.fileSha256;
    if (Object.hasOwn(part.source, "fileSha256") && expectedHash)
    {
      const hash = createHash("sha256").update(bytes).digest();
      if (expectedHash.byteLength !== hash.byteLength || !timingSafeEqual(hash, expectedHash))
      {
        throw new Error("WhatsApp media integrity check failed");
      }
    }
    return bytes;
  }
  async read(identity: WhatsAppMediaSourceIdentity, serializedMessage: string): Promise<Uint8Array>
  {
    return this.download(this.resolve(identity, serializedMessage));
  }
  async materialize(identity: WhatsAppMediaSourceIdentity, serializedMessage: string): Promise<MediaReference>
  {
    if (!this.media) throw new Error("Media materialization storage is not configured");
    const resolved = this.resolve(identity, serializedMessage);
    const bytes = await this.download(resolved);
    const storageKey = `media/whatsapp/${identity.workspaceId}/${identity.accountId}/${
      encodeURIComponent(identity.messageId)
    }/${identity.partId}`;
    return this.media.write(storageKey, bytes, resolved.source.contentType, resolved.source.fileName);
  }
}
