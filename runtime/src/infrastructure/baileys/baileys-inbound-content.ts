import type { MediaSource, MessageContext, MessageTarget } from "@digows/whatsapp-gateway-contracts";
import { normalizeMessageContent, proto, type WAMessage, type WAMessageKey } from "baileys";
import { type NativeMedia, nativeMediaSource } from "./baileys-media-repository.ts";

type NativeMessageAddress = (jid: string | null | undefined, alternate?: string | null) => Promise<string>;

interface NativeInteger
{
  toNumber(): number;
}

export interface InboundContentContext
{
  readonly accountId: string;
  readonly workspaceId: string;
  readonly message: WAMessage;
  readonly receivingAddress: string;
  readonly address: NativeMessageAddress;
  readonly cachedMessage: (key: WAMessageKey) => WAMessage | undefined;
}

function numberValue(value: number | NativeInteger | null | undefined): number | undefined
{
  return value === null || value === undefined
    ? undefined
    : typeof value === "number"
    ? value
    : value.toNumber();
}

function timestamp(value: number | NativeInteger | null | undefined): string
{
  const seconds = numberValue(value);
  if (seconds === undefined || !Number.isFinite(seconds))
  {
    throw new Error("Native content timestamp is missing or invalid");
  }
  return new Date(seconds * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown>
{
  if (!isRecord(value)) throw new Error("Native selection parameters are invalid");
  return value;
}

function selectedText(value: unknown, field: string): string
{
  if (typeof value !== "string" || value.length === 0)
  {
    throw new Error(`Native selection ${field} is missing`);
  }
  return value;
}

function nativeContext(content: proto.IMessage): proto.IContextInfo | null | undefined
{
  return content.extendedTextMessage?.contextInfo ?? content.imageMessage?.contextInfo
    ?? content.videoMessage?.contextInfo ?? content.ptvMessage?.contextInfo
    ?? content.audioMessage?.contextInfo
    ?? content.documentMessage?.contextInfo ?? content.stickerMessage?.contextInfo
    ?? content.contactMessage?.contextInfo ?? content.contactsArrayMessage?.contextInfo
    ?? content.locationMessage?.contextInfo ?? content.pollCreationMessage?.contextInfo
    ?? content.pollCreationMessageV2?.contextInfo ?? content.pollCreationMessageV3?.contextInfo
    ?? content.eventMessage?.contextInfo ?? content.buttonsMessage?.contextInfo
    ?? content.listMessage?.contextInfo ?? content.interactiveMessage?.contextInfo;
}

export async function inboundMessageContext(context: InboundContentContext): Promise<MessageContext>
{
  const content = normalizeMessageContent(context.message.message);
  const native = content ? nativeContext(content) : undefined;
  if (!native) return {};
  const quotedMessage = native.stanzaId
    ? {
      channelMessageId: native.stanzaId,
      ...(native.participant ? { senderAddress: await context.address(native.participant) } : {}),
      ...(native.remoteJid ? { chatAddress: await context.address(native.remoteJid) } : {}),
    }
    : undefined;
  return {
    ...(quotedMessage ? { quotedMessage } : {}),
    ...(native.isForwarded === null || native.isForwarded === undefined
      ? {}
      : { forwarded: native.isForwarded }),
    ...(native.mentionedJid?.length
      ? { mentionedAddresses: await Promise.all(native.mentionedJid.map((jid) => context.address(jid))) }
      : {}),
    ...(native.expiration === null || native.expiration === undefined || native.expiration === 0
      ? {}
      : { lifetimeSeconds: native.expiration }),
  };
}

async function target(
  context: InboundContentContext,
  key: proto.IMessageKey | null | undefined,
  protocolAction = false,
): Promise<MessageTarget>
{
  if (!key?.id) throw new Error("Native action target ID is missing");
  const remoteJid = key.remoteJid ?? context.message.key.remoteJid;
  if (!remoteJid) throw new Error("Native action target chat is missing");
  const chatAddress = await context.address(remoteJid, context.message.key.remoteJidAlt);
  const envelopeChat = await context.address(context.message.key.remoteJid, context.message.key.remoteJidAlt);
  if (chatAddress !== envelopeChat) throw new Error("Native action target chat differs from its envelope");
  const cached = context.cachedMessage({ remoteJid, id: key.id });
  if (
    protocolAction
    && context.message.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE
    && remoteJid.endsWith("@g.us") && !cached && !key.participant
  )
  {
    throw new Error("Native group delete target sender correlation is unavailable");
  }
  // Raw protocol keys use the actor's perspective. Cached keys and native reaction keys
  // are already from this connection's perspective; never invert those a second time.
  const original = cached?.key ?? (protocolAction
    ? {
      ...key,
      fromMe: context.message.key.fromMe ?? null,
      participant: key.participant ?? context.message.key.participant ?? null,
    }
    : key);
  const senderAddress = original.fromMe
    ? context.receivingAddress
    : await context.address(
      original.participant ?? context.message.key.participant ?? remoteJid,
      cached?.key.participantAlt ?? context.message.key.participantAlt,
    );
  return {
    channelMessageId: key.id,
    senderAddress,
    chatAddress,
  };
}

export class BaileysInboundContent
{
  constructor(private readonly context: InboundContentContext)
  {}

  private media(source: NativeMedia, partId = "0"): MediaSource
  {
    const messageId = this.context.message.key.id;
    if (!messageId) throw new Error("Native media message ID is missing");
    const chatId = this.context.message.key.remoteJid;
    if (!chatId) throw new Error("Native media chat ID is missing");
    return nativeMediaSource({
      workspaceId: this.context.workspaceId,
      accountId: this.context.accountId,
      messageId,
      chatId,
      partId,
    }, source);
  }

  private selection(content: proto.IMessage): Record<string, unknown> | undefined
  {
    const buttons = content.buttonsResponseMessage;
    const template = content.templateButtonReplyMessage;
    const list = content.listResponseMessage;
    const interactive = content.interactiveResponseMessage;
    if (buttons)
    {
      return {
        contentKind: "SELECTION",
        optionId: selectedText(buttons.selectedButtonId, "ID"),
        ...(buttons.selectedDisplayText ? { label: buttons.selectedDisplayText } : {}),
        originatingChannelMessageId: selectedText(buttons.contextInfo?.stanzaId, "target"),
      };
    }
    if (template)
    {
      return {
        contentKind: "SELECTION",
        optionId: selectedText(template.selectedId, "ID"),
        ...(template.selectedDisplayText ? { label: template.selectedDisplayText } : {}),
        ...(!Object.hasOwn(template, "selectedIndex") || template.selectedIndex === null
            || template.selectedIndex === undefined
          ? {}
          : { optionIndex: template.selectedIndex }),
        ...(!Object.hasOwn(template, "selectedCarouselCardIndex")
            || template.selectedCarouselCardIndex === null || template.selectedCarouselCardIndex === undefined
          ? {}
          : { cardIndex: template.selectedCarouselCardIndex }),
        originatingChannelMessageId: selectedText(template.contextInfo?.stanzaId, "target"),
      };
    }
    if (list)
    {
      return {
        contentKind: "SELECTION",
        optionId: selectedText(list.singleSelectReply?.selectedRowId, "ID"),
        ...(list.title ? { label: list.title } : {}),
        originatingChannelMessageId: selectedText(list.contextInfo?.stanzaId, "target"),
      };
    }
    if (interactive)
    {
      const response: unknown = JSON.parse(
        selectedText(interactive.nativeFlowResponseMessage?.paramsJson, "parameters"),
      );
      const parameters = record(response);
      return {
        contentKind: "SELECTION",
        optionId: selectedText(parameters["id"] ?? parameters["selected_id"] ?? parameters["row_id"], "ID"),
        ...(parameters["display_text"] === undefined
          ? {}
          : { label: selectedText(parameters["display_text"], "label") }),
        ...(parameters["selected_index"] === undefined ? {} : { optionIndex: parameters["selected_index"] }),
        ...(parameters["selected_carousel_card_index"] === undefined
          ? {}
          : { cardIndex: parameters["selected_carousel_card_index"] }),
        originatingChannelMessageId: selectedText(interactive.contextInfo?.stanzaId, "target"),
      };
    }
    return undefined;
  }

  async normalize(): Promise<Record<string, unknown>>
  {
    const content = normalizeMessageContent(this.context.message.message);
    if (!content) throw new Error("Native content is missing");
    const original = this.context.message.message;
    if (
      (original?.viewOnceMessage || original?.viewOnceMessageV2 || original?.viewOnceMessageV2Extension)
      && (content.imageMessage || content.videoMessage || content.audioMessage)
    )
    {
      throw new Error("View-once media is outside the approved profiles");
    }
    const selection = this.selection(content);
    if (selection) return selection;
    if (content.reactionMessage)
    {
      return {
        contentKind: "REACTION",
        emoji: content.reactionMessage.text ?? "",
        target: await target(this.context, content.reactionMessage.key),
      };
    }
    const protocol = content.protocolMessage;
    if (protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE)
    {
      return { contentKind: "DELETE", target: await target(this.context, protocol.key, true) };
    }
    if (protocol?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT)
    {
      const edited = normalizeMessageContent(protocol.editedMessage);
      const text = edited?.conversation ?? edited?.extendedTextMessage?.text;
      return { contentKind: "EDIT", target: await target(this.context, protocol.key, true), text };
    }
    const albumMessageId = this.context.message.message?.messageContextInfo?.messageAssociation
      ?.parentMessageKey?.id;
    if (content.imageMessage)
    {
      return {
        contentKind: "IMAGE",
        media: this.media(content.imageMessage),
        ...(content.imageMessage.caption === null || content.imageMessage.caption === undefined
          ? {}
          : { caption: content.imageMessage.caption }),
        ...(albumMessageId ? { albumMessageId } : {}),
      };
    }
    const video = content.videoMessage ?? content.ptvMessage;
    if (video)
    {
      return {
        contentKind: "VIDEO",
        media: this.media(video),
        presentation: content.ptvMessage ? "VIDEO_NOTE" : video.gifPlayback ? "ANIMATION" : "VIDEO",
        ...(video.caption === null || video.caption === undefined ? {} : { caption: video.caption }),
        ...(albumMessageId ? { albumMessageId } : {}),
      };
    }
    if (content.audioMessage)
    {
      return {
        contentKind: "AUDIO",
        media: this.media(content.audioMessage),
        presentation: content.audioMessage.ptt ? "VOICE_NOTE" : "AUDIO",
      };
    }
    if (content.documentMessage)
    {
      return {
        contentKind: "FILE",
        media: this.media(content.documentMessage),
        ...(content.documentMessage.caption === null || content.documentMessage.caption === undefined
          ? {}
          : { caption: content.documentMessage.caption }),
      };
    }
    if (content.stickerMessage)
    {
      return {
        contentKind: "STICKER",
        media: this.media(content.stickerMessage),
        presentation: content.stickerMessage.isAnimated ? "ANIMATED" : "STATIC",
      };
    }
    const contacts = content.contactsArrayMessage?.contacts
      ?? (content.contactMessage ? [content.contactMessage] : undefined);
    if (contacts)
    {
      return {
        contentKind: "CONTACTS",
        contacts: contacts.map((contact) => ({ displayName: contact.displayName, vcard: contact.vcard })),
      };
    }
    if (content.locationMessage)
    {
      return {
        contentKind: "LOCATION",
        location: {
          latitude: content.locationMessage.degreesLatitude,
          longitude: content.locationMessage.degreesLongitude,
          ...(content.locationMessage.name ? { name: content.locationMessage.name } : {}),
          ...(content.locationMessage.address ? { address: content.locationMessage.address } : {}),
        },
      };
    }
    const poll = content.pollCreationMessage ?? content.pollCreationMessageV2
      ?? content.pollCreationMessageV3;
    if (poll)
    {
      return {
        contentKind: "POLL",
        question: poll.name,
        options: poll.options?.map((option) => option.optionName),
        selectionCount: poll.selectableOptionsCount,
      };
    }
    if (content.eventMessage)
    {
      return {
        contentKind: "EVENT",
        title: content.eventMessage.name,
        ...(content.eventMessage.description === null || content.eventMessage.description === undefined
          ? {}
          : { description: content.eventMessage.description }),
        startsAt: timestamp(content.eventMessage.startTime),
        ...(content.eventMessage.endTime === null || content.eventMessage.endTime === undefined
          ? {}
          : { endsAt: timestamp(content.eventMessage.endTime) }),
        ...(content.eventMessage.location?.name ? { location: content.eventMessage.location.name } : {}),
      };
    }
    if (content.albumMessage)
    {
      return {
        contentKind: "ALBUM",
        imageCount: content.albumMessage.expectedImageCount ?? 0,
        videoCount: content.albumMessage.expectedVideoCount ?? 0,
      };
    }
    if (content.buttonsMessage)
    {
      const buttons = content.buttonsMessage;
      const choices = buttons.buttons?.map((button) => ({
        id: button.buttonId,
        label: button.buttonText?.displayText,
      }));
      return {
        contentKind: buttons.imageMessage ? "CARD" : "BUTTONS",
        text: buttons.contentText,
        choices,
        ...(buttons.footerText === null || buttons.footerText === undefined
          ? {}
          : { footer: buttons.footerText }),
        ...(buttons.imageMessage
          ? { image: this.media(buttons.imageMessage, "thumbnail") }
          : {}),
      };
    }
    if (content.listMessage)
    {
      const list = content.listMessage;
      return {
        contentKind: "LIST",
        title: list.title,
        description: list.description,
        openingLabel: list.buttonText,
        ...(list.footerText === null || list.footerText === undefined ? {} : { footer: list.footerText }),
        sections: list.sections?.map((section) => ({
          title: section.title,
          rows: section.rows?.map((row) => ({
            id: row.rowId,
            label: row.title,
            ...(row.description === null || row.description === undefined
              ? {}
              : { description: row.description }),
          })),
        })),
      };
    }
    if (content.interactiveMessage) return this.interactive(content.interactiveMessage);
    const text = content.conversation ?? content.extendedTextMessage?.text;
    if (text !== null && text !== undefined)
    {
      const extended = content.extendedTextMessage;
      let linkPreview: Record<string, unknown> | undefined;
      if (extended?.title || extended?.matchedText || extended?.thumbnailDirectPath)
      {
        const thumbnail = (extended.jpegThumbnail?.byteLength || extended.thumbnailDirectPath)
          ? this.media(
            extended.jpegThumbnail?.byteLength
              ? { mimetype: "image/jpeg", fileLength: extended.jpegThumbnail.byteLength }
              : {
                mimetype: "image/jpeg",
                directPath: extended.thumbnailDirectPath ?? null,
                mediaKey: extended.mediaKey ?? null,
              },
            "thumbnail",
          )
          : undefined;
        linkPreview = {
          url: extended.matchedText,
          title: extended.title,
          description: extended.description,
          ...(thumbnail ? { thumbnail } : {}),
        };
      }
      return { contentKind: "TEXT", text, ...(linkPreview ? { linkPreview } : {}) };
    }
    return { contentKind: "NON_TEXT" };
  }

  private interactive(message: proto.Message.IInteractiveMessage): Record<string, unknown>
  {
    if (message.carouselMessage)
    {
      const cards = (message.carouselMessage.cards ?? []).map((card, index) =>
      {
        if (!card.header?.imageMessage) throw new Error("Native carousel card image is missing");
        return {
          title: card.header.title,
          text: card.body?.text,
          image: this.media(card.header.imageMessage, `card-${String(index)}`),
          ...(card.footer?.text === null || card.footer?.text === undefined
            ? {}
            : { footer: card.footer.text }),
          choices: this.choices(card.nativeFlowMessage?.buttons),
        };
      });
      return { contentKind: "CAROUSEL", text: message.body?.text, cards };
    }
    const buttons = message.nativeFlowMessage?.buttons;
    if (buttons?.length === 1 && buttons[0]?.name === "cta_url")
    {
      const parameters = record(JSON.parse(selectedText(buttons[0].buttonParamsJson, "parameters")));
      return {
        contentKind: "LINK",
        text: message.body?.text,
        label: parameters["display_text"],
        url: parameters["url"],
      };
    }
    if (buttons)
    {
      const choices = this.choices(buttons);
      return {
        contentKind: message.header?.imageMessage ? "CARD" : "BUTTONS",
        text: message.body?.text,
        choices,
        ...(message.footer?.text === null || message.footer?.text === undefined
          ? {}
          : { footer: message.footer.text }),
        ...(message.header?.imageMessage
          ? { image: this.media(message.header.imageMessage, "thumbnail") }
          : {}),
      };
    }
    return { contentKind: "NON_TEXT" };
  }

  private choices(
    buttons: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton[] | null | undefined,
  ): Record<string, unknown>[]
  {
    if (!buttons?.length) throw new Error("Native reply choices are missing");
    return buttons.map((button) =>
    {
      if (button.name !== "quick_reply") throw new Error("Native action is not a reply choice");
      const parameters = record(JSON.parse(selectedText(button.buttonParamsJson, "parameters")));
      return { id: parameters["id"], label: parameters["display_text"] };
    });
  }
}
