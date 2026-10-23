import {
  type AccountScope,
  AccountScopeSchema,
  type GatewayOperations,
  type InboundMessage,
  InboundMessageSchema,
  type MediaSource,
  type OperationResult,
  type OutboundMessage,
} from "@digows/whatsapp-gateway-contracts";
import {
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type FormattedContent,
  Message,
  stringifyMarkdown,
} from "chat";
import { randomUUID } from "node:crypto";

export interface GatewayThread extends AccountScope
{
  readonly chatId: string;
}
export class GatewayOutcomeError extends Error
{
  constructor(readonly operation: OperationResult)
  {
    super(
      `Gateway operation ${operation.key} is ${operation.state}; inspect its original status before any further action`,
    );
    this.name = "GatewayOutcomeError";
  }
}
/** Actual SDK projection and send mapping; remote request/event bindings await the wire decision. */
export class GatewayChatMapping implements
  Pick<
    Adapter<GatewayThread, InboundMessage>,
    | "parseMessage"
    | "encodeThreadId"
    | "decodeThreadId"
    | "channelIdFromThreadId"
    | "renderFormatted"
    | "startTyping"
    | "endTyping"
  >
{
  constructor(
    readonly scope: AccountScope,
    private readonly nativeJid: string,
    readonly gateway: GatewayOperations,
  )
  {
    AccountScopeSchema.parse(scope);
  }
  encodeThreadId(value: GatewayThread): string
  {
    this.assertScope(value);
    return `whatsapp-gateway:${
      Buffer.from(JSON.stringify([value.workspaceId, value.accountId, value.chatId])).toString("base64url")
    }`;
  }
  decodeThreadId(value: string): GatewayThread
  {
    if (!value.startsWith("whatsapp-gateway:")) throw new Error("Invalid gateway thread");
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(17), "base64url").toString());
    if (
      !Array.isArray(parsed) || parsed.length !== 3
      || parsed.some(item => typeof item !== "string" || item.length === 0)
    ) throw new Error("Invalid gateway thread");
    const workspaceId: unknown = parsed[0];
    const accountId: unknown = parsed[1];
    const chatId: unknown = parsed[2];
    if (typeof workspaceId !== "string" || typeof accountId !== "string" || typeof chatId !== "string")
    {
      throw new Error("Invalid gateway thread");
    }
    const thread = { workspaceId, accountId, chatId };
    this.assertScope(thread);
    if (this.encodeThreadId(thread) !== value) throw new Error("Noncanonical gateway thread");
    return thread;
  }
  channelIdFromThreadId(threadId: string): string
  {
    this.decodeThreadId(threadId);
    return threadId;
  }
  private assertScope(value: AccountScope): void
  {
    if (value.workspaceId !== this.scope.workspaceId || value.accountId !== this.scope.accountId)
    {
      throw new Error("Gateway thread scope mismatch");
    }
  }
  parseMessage(input: InboundMessage): Message<InboundMessage>
  {
    const raw = InboundMessageSchema.parse(input);
    if (raw.receivingAddress !== this.nativeJid)
    {
      throw new Error("Receiving identity does not match adapter account");
    }
    const text = "text" in raw ? raw.text ?? "" : "caption" in raw ? raw.caption ?? "" : "";
    const attachments: Attachment[] = [];
    if ("media" in raw && "sourceId" in raw.media)
    {
      attachments.push(this.attachment(
        raw.media,
        raw.contentKind === "IMAGE"
          ? "image"
          : raw.contentKind === "VIDEO"
          ? "video"
          : raw.contentKind === "AUDIO"
          ? "audio"
          : "file",
      ));
    }
    if ("image" in raw && "sourceId" in raw.image) attachments.push(this.attachment(raw.image, "image"));
    if (raw.contentKind === "CAROUSEL")
    {
      for (const card of raw.cards)
      {
        if ("sourceId" in card.image)
        {
          attachments.push(this.attachment(card.image, "image"));
        }
      }
    }
    return new Message({
      id: raw.channelMessageId,
      threadId: this.encodeThreadId({ ...this.scope, chatId: raw.chatAddress }),
      text,
      formatted: {
        type: "root",
        children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
      },
      raw,
      attachments,
      isMention: raw.mentionsReceiver,
      author: {
        userId: raw.senderAddress,
        userName: raw.senderDisplayName ?? raw.senderAddress,
        fullName: raw.senderDisplayName ?? raw.senderAddress,
        isMe: false,
        isBot: "unknown",
      },
      metadata: { dateSent: new Date(raw.occurredAt), edited: raw.contentKind === "EDIT" },
    });
  }
  private attachment(source: MediaSource, type: Attachment["type"]): Attachment
  {
    return {
      type,
      mimeType: source.contentType,
      ...(source.byteSize === undefined ? {} : { size: source.byteSize }),
      ...(source.fileName === undefined ? {} : { name: source.fileName }),
      fetchMetadata: { ...this.scope, sourceId: source.sourceId },
      fetchData: async () => Buffer.from(await this.gateway.readMedia(this.scope.accountId, source.sourceId)),
    };
  }
  rehydrateAttachment(attachment: Attachment): Attachment
  {
    const metadata = attachment.fetchMetadata;
    if (!metadata) throw new Error("Media fetch identity unavailable");
    if (
      metadata["workspaceId"] !== this.scope.workspaceId || metadata["accountId"] !== this.scope.accountId
      || !metadata["sourceId"]
    ) throw new Error("Media fetch scope mismatch");
    const sourceId = metadata["sourceId"];
    return {
      ...attachment,
      fetchData: async () => Buffer.from(await this.gateway.readMedia(this.scope.accountId, sourceId)),
    };
  }
  renderFormatted(content: FormattedContent): string
  {
    return stringifyMarkdown(content);
  }
  async postMessage(threadId: string, message: AdapterPostableMessage)
  {
    return this.postWithKey(threadId, message, randomUUID());
  }
  async postWithKey(threadId: string, message: AdapterPostableMessage, key: string)
  {
    const thread = this.decodeThreadId(threadId);
    const text = typeof message === "string"
      ? message
      : "raw" in message
      ? message.raw
      : "markdown" in message
      ? message.markdown
      : "ast" in message
      ? this.renderFormatted(message.ast)
      : undefined;
    if (text === undefined)
    {
      throw new Error(
        "This rich card requires the explicit gateway rich-content operation; it cannot be flattened into text",
      );
    }
    if (
      typeof message !== "string"
      && (("attachments" in message && message.attachments?.length)
        || ("files" in message && message.files?.length))
    ) throw new Error("Use a materialized media reference through the rich-content operation");
    const outbound: OutboundMessage = {
      channel: "WHATSAPP",
      senderAddress: this.nativeJid,
      recipientAddress: thread.chatId,
      idempotencyKey: key,
      contentKind: "TEXT",
      text,
    };
    const operation = await this.gateway.send(this.scope.accountId, outbound);
    if (operation.state !== "ACCEPTED") throw new GatewayOutcomeError(operation);
    const id = operation.nativeIds[0];
    if (!id) throw new Error("Accepted operation has no native identity");
    return {
      id,
      threadId,
      raw: operation,
    };
  }
  async startTyping(threadId: string): Promise<void>
  {
    await this.gateway.presence(this.scope.accountId, this.decodeThreadId(threadId).chatId, true);
  }
  async endTyping(threadId: string): Promise<void>
  {
    await this.gateway.presence(this.scope.accountId, this.decodeThreadId(threadId).chatId, false);
  }
}
