import type { MessageReference, OutboundMessage } from "@digows/whatsapp-gateway-contracts";
import {
  type AnyMessageContent,
  jidNormalizedUser,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WAMessageKey,
} from "baileys";
import type { IMediaRepository } from "../../domain/media-storage.ts";
import { outboundPartCount, outboundPartId } from "../../domain/outbound-parts.ts";

import type { PreparedWhatsAppSend } from "../../domain/connection.ts";

export interface OutboundContentContext
{
  readonly media: IMediaRepository | null;
  readonly recipientJid: string;
  readonly senderJid: string;
  readonly addressJid: (address: string) => Promise<string>;
  readonly quote: (reference: MessageReference) => Promise<WAMessage>;
}

export async function prepareOutboundContent(
  message: OutboundMessage,
  context: OutboundContentContext,
  partIndex = 0,
): Promise<PreparedWhatsAppSend>
{
  if (!Number.isSafeInteger(partIndex) || partIndex < 0 || partIndex >= outboundPartCount(message))
  {
    throw new Error("Outbound media part index is invalid");
  }
  const interactive = message.contentKind === "BUTTONS" || message.contentKind === "CARD"
    || message.contentKind === "LINK" || message.contentKind === "LIST" || message.contentKind === "CAROUSEL";
  if (
    interactive && (("mentionedAddresses" in message && message.mentionedAddresses?.length)
      || ("forwarded" in message && message.forwarded))
  )
  {
    throw new Error("The selected interactive profiles do not support mentions or forwarding metadata");
  }
  if (message.contentKind === "CAROUSEL")
  {
    // N47 has disabled choices on observed iOS clients; no alternative device recipe is selected.
    if (
      message.quotedMessage || message.lifetimeSeconds
      || message.cards.some((card) => card.footer !== undefined)
    )
    {
      throw new Error("The selected carousel does not support quotes, expiration or custom card footers");
    }
  }
  // These release builders call prepareMedia({ image }) and therefore always declare image/jpeg.
  // Reject a different stored type instead of mislabelling it or replacing the selected builder.
  if (
    (message.contentKind === "CARD" && message.image.contentType !== "image/jpeg")
    || (message.contentKind === "CAROUSEL"
      && message.cards.some((card) => card.image.contentType !== "image/jpeg"))
  )
  {
    throw new Error("The selected image card/carousel profiles require image/jpeg media");
  }
  if (
    message.contentKind === "TEXT"
    && message.linkPreview && message.linkPreview.thumbnail.contentType !== "image/jpeg"
  )
  {
    throw new Error("The native link preview requires an image/jpeg thumbnail");
  }
  const options: MiscMessageGenerationOptions = { messageId: outboundPartId(message, partIndex) };
  if ("quotedMessage" in message && message.quotedMessage)
  {
    options.quoted = await context.quote(message.quotedMessage);
  }
  if ("lifetimeSeconds" in message && message.lifetimeSeconds !== undefined)
  {
    options.ephemeralExpiration = message.lifetimeSeconds;
  }
  const mentions = "mentionedAddresses" in message && message.mentionedAddresses
    ? await Promise.all(message.mentionedAddresses.map(context.addressJid))
    : undefined;
  const contextInfo = "forwarded" in message && message.forwarded
    ? { isForwarded: true, forwardingScore: 1 }
    : undefined;
  const metadata = {
    ...(mentions === undefined ? {} : { mentions }),
    ...(contextInfo === undefined ? {} : { contextInfo }),
  };
  const read = async (reference: Parameters<IMediaRepository["read"]>[0]): Promise<Buffer> =>
  {
    if (context.media === null) throw new Error("Media repository is not configured");
    return Buffer.from(await context.media.read(reference));
  };
  const target = async (reference: MessageReference): Promise<WAMessageKey> =>
  {
    if (!reference.chatAddress || !reference.senderAddress)
    {
      throw new Error("Action target correlation is missing");
    }
    const remoteJid = await context.addressJid(reference.chatAddress);
    if (remoteJid !== context.recipientJid) throw new Error("Action target chat differs from recipient");
    const sender = jidNormalizedUser(await context.addressJid(reference.senderAddress));
    return {
      id: reference.channelMessageId,
      remoteJid,
      fromMe: sender === jidNormalizedUser(context.senderJid),
      ...(remoteJid.endsWith("@g.us") ? { participant: sender } : {}),
    };
  };
  let content: AnyMessageContent;
  switch (message.contentKind)
  {
    case "TEXT":
      content = {
        text: message.text,
        ...metadata,
        ...(message.linkPreview
          ? {
            linkPreview: {
              "canonical-url": message.linkPreview.url,
              "matched-text": message.linkPreview.url,
              title: message.linkPreview.title,
              description: message.linkPreview.description,
              jpegThumbnail: await read(message.linkPreview.thumbnail),
            },
          }
          : {}),
      };
      break;
    case "IMAGE":
      content = {
        image: await read(message.media),
        mimetype: message.media.contentType,
        ...(message.caption === undefined ? {} : { caption: message.caption }),
        ...metadata,
      };
      break;
    case "VIDEO":
      content = {
        video: await read(message.media),
        mimetype: message.media.contentType,
        ...(message.caption === undefined ? {} : { caption: message.caption }),
        gifPlayback: message.presentation === "ANIMATION",
        ptv: message.presentation === "VIDEO_NOTE",
        ...metadata,
      };
      break;
    case "AUDIO":
      content = {
        audio: await read(message.media),
        mimetype: message.media.contentType,
        ptt: message.presentation === "VOICE_NOTE",
        ...metadata,
      };
      break;
    case "FILE":
      content = {
        document: await read(message.media),
        mimetype: message.media.contentType,
        ...(message.media.fileName === undefined ? {} : { fileName: message.media.fileName }),
        ...(message.caption === undefined ? {} : { caption: message.caption }),
        ...metadata,
      };
      break;
    case "STICKER":
      content = {
        sticker: await read(message.media),
        mimetype: message.media.contentType,
        isAnimated: message.presentation === "ANIMATED",
        ...metadata,
      };
      break;
    case "CONTACTS":
      content = { contacts: { contacts: message.contacts }, ...metadata };
      break;
    case "LOCATION":
      content = {
        location: {
          degreesLatitude: message.location.latitude,
          degreesLongitude: message.location.longitude,
          ...(message.location.name === undefined ? {} : { name: message.location.name }),
          ...(message.location.address === undefined ? {} : { address: message.location.address }),
        },
        ...metadata,
      };
      break;
    case "POLL":
      content = {
        poll: { name: message.question, values: message.options, selectableCount: message.selectionCount },
        ...metadata,
      };
      break;
    case "EVENT":
      content = {
        event: {
          name: message.title,
          ...(message.description === undefined ? {} : { description: message.description }),
          startDate: new Date(message.startsAt),
          ...(message.endsAt === undefined ? {} : { endDate: new Date(message.endsAt) }),
          ...(message.location === undefined ? {} : { location: { name: message.location } }),
        },
        ...metadata,
      };
      break;
    case "BUTTONS":
      content = {
        replyButtons: {
          text: message.text,
          ...(message.footer === undefined ? {} : { footer: message.footer }),
          buttons: message.choices.map((choice) => ({ id: choice.id, displayText: choice.label })),
        },
      };
      break;
    case "CARD":
      content = {
        replyButtons: {
          text: message.text,
          ...(message.footer === undefined ? {} : { footer: message.footer }),
          image: await read(message.image),
          buttons: message.choices.map((choice) => ({ id: choice.id, displayText: choice.label })),
        },
      };
      break;
    case "LINK":
      content = { urlButton: { text: message.text, displayText: message.label, url: message.url } };
      break;
    case "LIST":
      content = {
        list: {
          title: message.title,
          description: message.description,
          buttonText: message.openingLabel,
          ...(message.footer === undefined ? {} : { footer: message.footer }),
          sections: message.sections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({
              rowId: row.id,
              title: row.label,
              ...(row.description === undefined ? {} : { description: row.description }),
            })),
          })),
        },
      };
      break;
    case "CAROUSEL":
      content = {
        carousel: {
          text: message.text,
          cards: await Promise.all(message.cards.map(async (card) => ({
            image: await read(card.image),
            title: card.title,
            text: card.text,
            buttons: card.choices.map((choice) => ({ id: choice.id, displayText: choice.label })),
          }))),
        },
      };
      break;
    case "REACTION":
      content = { react: { key: await target(message.target), text: message.emoji } };
      break;
    case "EDIT":
    {
      const editedTarget = await target(message.target);
      if (!editedTarget.fromMe) throw new Error("Cannot edit another sender's message");
      content = { text: message.text, edit: editedTarget };
      break;
    }
    case "DELETE":
      content = { delete: await target(message.target) };
      break;
    case "ALBUM":
      if (partIndex === 0)
      {
        content = {
          album: {
            expectedImageCount: message.parts.filter((part) => part.contentKind === "IMAGE").length,
            expectedVideoCount: message.parts.filter((part) => part.contentKind === "VIDEO").length,
          },
          ...metadata,
        };
      }
      else
      {
        const part = message.parts[partIndex - 1];
        if (part === undefined) throw new Error("Album part is unavailable");
        const albumParentKey: WAMessageKey = {
          remoteJid: context.recipientJid,
          id: message.idempotencyKey,
          fromMe: true,
        };
        content = part.contentKind === "IMAGE"
          ? {
            image: await read(part.media),
            ...(part.caption === undefined ? {} : { caption: part.caption }),
            mimetype: part.media.contentType,
            albumParentKey,
            ...metadata,
          }
          : {
            video: await read(part.media),
            ...(part.caption === undefined ? {} : { caption: part.caption }),
            mimetype: part.media.contentType,
            albumParentKey,
            gifPlayback: part.presentation === "ANIMATION",
            ptv: part.presentation === "VIDEO_NOTE",
            ...metadata,
          };
      }
      break;
  }
  return { recipientAddress: context.recipientJid, content, options };
}
