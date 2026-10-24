import {
  type AccountScope,
  type DeleteContent,
  type EditContent,
  GatewayCloudEventSchema,
  type GatewayObservedMessage,
  GatewayObservedMessageSchema,
  type InboundMessage,
  materializedMessageMediaParts,
  type MediaReference,
  type MessageReference,
  type MessageTarget,
  type OperationResult,
  type OutboundMessage,
  OutboundMessageSchema,
  type ReactionContent,
  verifyGatewayWebhook,
} from "@digows/whatsapp-gateway-contracts";
import {
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type ChatInstance,
  defaultEmojiResolver,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  Message,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { randomUUID } from "node:crypto";
import { decodeGatewayAction, postableText, projectCard, renderWhatsAppFormatted } from "./formatting.ts";
import { GatewayChatMapping, GatewayOutcomeError, type GatewayThread } from "./mapping.ts";
import { GatewayRemoteClient } from "./remote-client.ts";
export interface GatewayAdapterConfiguration extends AccountScope
{
  readonly client: GatewayRemoteClient;
  readonly nativeJid: string;
  readonly userName?: string;
  readonly webhookSecret?: string;
  readonly maximumWebhookBytes?: number;
  readonly webhookBodyTimeoutMs?: number;
  readonly completedEventRetentionMs?: number;
}
export class WhatsAppGatewayAdapter implements Adapter<GatewayThread, GatewayObservedMessage>
{
  readonly name = "whatsapp-gateway";
  readonly userName: string;
  readonly botUserId: string;
  readonly lockScope = "channel" as const;
  private readonly mapping: GatewayChatMapping;
  private chat: ChatInstance | undefined;
  private closed = false;
  private readonly active = new Set<Promise<void>>();
  constructor(private readonly configuration: GatewayAdapterConfiguration)
  {
    this.mapping = new GatewayChatMapping(
      { workspaceId: configuration.workspaceId, accountId: configuration.accountId },
      configuration.nativeJid,
      configuration.client,
    );
    if (
      configuration.client.scope.workspaceId !== this.mapping.scope.workspaceId
      || configuration.client.scope.accountId !== this.mapping.scope.accountId
    ) throw new Error("Adapter client scope mismatch");
    this.userName = configuration.userName ?? "whatsapp-agent";
    this.botUserId = configuration.nativeJid;
    if (!this.botUserId) throw new Error("Adapter requires its authoritative native account identity");
    if (
      configuration.webhookSecret !== undefined
      && (configuration.webhookSecret.length < 32 || configuration.webhookSecret.length > 4096)
    )
    {
      throw new Error("Webhook secret must contain at least 32 characters");
    }
    const maximum = configuration.maximumWebhookBytes ?? 1024 * 1024;
    const bodyTimeout = configuration.webhookBodyTimeoutMs ?? 15000;
    if (!Number.isSafeInteger(bodyTimeout) || bodyTimeout < 1 || bodyTimeout > 60000)
    {
      throw new Error("Invalid webhook body deadline");
    }
    const retention = configuration.completedEventRetentionMs ?? 7 * 86400000;
    if (
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024
      || !Number.isSafeInteger(retention) || retention < 1
    ) throw new Error("Invalid adapter intake bounds");
  }
  async initialize(chat: ChatInstance): Promise<void>
  {
    if (this.closed) throw new Error("Adapter is closed");
    if (this.chat && this.chat !== chat) throw new Error("Adapter is already initialized");
    this.chat = chat;
  }
  getConcurrencyScope(): string
  {
    return `${this.mapping.scope.workspaceId}:${this.mapping.scope.accountId}`;
  }
  encodeThreadId(value: GatewayThread): string
  {
    return this.mapping.encodeThreadId(value);
  }
  decodeThreadId(value: string): GatewayThread
  {
    return this.mapping.decodeThreadId(value);
  }
  channelIdFromThreadId(value: string): string
  {
    return this.mapping.channelIdFromThreadId(value);
  }
  isDM(threadId: string): boolean
  {
    return !this.decodeThreadId(threadId).chatId.endsWith("@g.us");
  }
  async openDM(address: string): Promise<string>
  {
    if (address.endsWith("@g.us")) throw new Error("A group is not a direct message");
    if (address.endsWith("@lid")) return this.encodeThreadId({ ...this.mapping.scope, chatId: address });
    const registration = await this.configuration.client.lookupContactAddress(
      this.mapping.scope.accountId,
      address,
    );
    if (registration.status !== "REGISTERED")
    {
      throw new Error(`Contact registration is ${registration.status}`);
    }
    return this.encodeThreadId({ ...this.mapping.scope, chatId: registration.resolvedAddress });
  }
  parseMessage(input: GatewayObservedMessage): Message<GatewayObservedMessage>
  {
    const observation = GatewayObservedMessageSchema.parse(input);
    if (
      observation.workspaceId !== this.mapping.scope.workspaceId
      || observation.accountId !== this.mapping.scope.accountId
    ) throw new Error("Message observation scope mismatch");
    const raw = observation.message;
    const parsed = this.mapping.parseMessage(raw);
    const stored = materializedMessageMediaParts(raw).map(part =>
    {
      const reference = part.media;
      const attachment: Attachment = {
        type: reference.contentType.startsWith("image/")
          ? "image"
          : reference.contentType.startsWith("video/")
          ? "video"
          : reference.contentType.startsWith("audio/")
          ? "audio"
          : "file",
        mimeType: reference.contentType,
        size: reference.byteSize,
        ...(reference.fileName ? { name: reference.fileName } : {}),
        fetchMetadata: { ...this.mapping.scope, storageReference: JSON.stringify(reference) },
        fetchData: async () => Buffer.from(await this.configuration.client.readStoredMedia(reference)),
      };
      return attachment;
    });
    return new Message({
      id: parsed.id,
      threadId: parsed.threadId,
      text: parsed.text,
      formatted: parsed.formatted,
      isMention: raw.mentionsReceiver,
      raw: observation,
      attachments: [...parsed.attachments, ...stored],
      author: {
        ...parsed.author,
        isMe: parsed.author.isMe || observation.direction === "OUTBOUND",
        isBot: observation.direction === "OUTBOUND" ? true : parsed.author.isBot,
      },
      metadata: { ...parsed.metadata, edited: observation.edited },
    });
  }
  renderFormatted(content: FormattedContent): string
  {
    return renderWhatsAppFormatted(content);
  }
  async startTyping(threadId: string): Promise<void>
  {
    await this.mapping.startTyping(threadId);
  }
  async endTyping(threadId: string): Promise<void>
  {
    await this.mapping.endTyping(threadId);
  }
  async fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<GatewayObservedMessage>>
  {
    const page = await this.configuration.client.history(this.decodeThreadId(threadId).chatId, options);
    return {
      messages: page.messages.map(value => this.parseMessage(value)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  async fetchMessage(threadId: string, messageId: string): Promise<Message<GatewayObservedMessage> | null>
  {
    const value = await this.configuration.client.message(this.decodeThreadId(threadId).chatId, messageId);
    return value && !value.deleted ? this.parseMessage(value) : null;
  }
  async fetchThread(threadId: string): Promise<ThreadInfo>
  {
    const thread = this.decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: threadId,
      isDM: this.isDM(threadId),
      metadata: { ...this.mapping.scope, chatAddress: thread.chatId, historyCoverage: "GATEWAY_OBSERVED" },
    };
  }
  rehydrateAttachment(attachment: Attachment): Attachment
  {
    const metadata = attachment.fetchMetadata;
    if (metadata?.["storageReference"])
    {
      if (
        metadata["workspaceId"] !== this.mapping.scope.workspaceId
        || metadata["accountId"] !== this.mapping.scope.accountId
      ) throw new Error("Attachment scope mismatch");
      const reference: unknown = JSON.parse(metadata["storageReference"]);
      return {
        ...attachment,
        fetchData: async () =>
          Buffer.from(await this.configuration.client.readStoredMedia(parseMediaReference(reference))),
      };
    }
    return this.mapping.rehydrateAttachment(attachment);
  }
  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<GatewayObservedMessage>>
  {
    return this.postWithKey(threadId, message, randomUUID());
  }
  async postWithKey(
    threadId: string,
    message: AdapterPostableMessage,
    key: string,
    quotedMessage?: MessageReference,
  ): Promise<RawMessage<GatewayObservedMessage>>
  {
    const chatAddress = this.decodeThreadId(threadId).chatId;
    const base = {
      channel: "WHATSAPP" as const,
      senderAddress: this.botUserId,
      recipientAddress: chatAddress,
      idempotencyKey: key,
      ...(quotedMessage ? { quotedMessage } : {}),
    };
    const text = postableText(message);
    const files = typeof message === "object" && "files" in message ? message.files ?? [] : [];
    const attachments = typeof message === "object" && "attachments" in message
      ? message.attachments ?? []
      : [];
    let outbound: OutboundMessage;
    if (files.length || attachments.length)
    {
      if (text === undefined) throw new Error("Files cannot be combined with an interactive card");
      const media: MediaReference[] = [];
      for (const file of files)
      {
        const bytes = file.data instanceof Blob
          ? new Uint8Array(await file.data.arrayBuffer())
          : new Uint8Array(file.data);
        media.push(
          await this.configuration.client.upload(
            bytes,
            file.mimeType ?? "application/octet-stream",
            file.filename,
          ),
        );
      }
      for (const attachment of attachments)
      {
        if (!attachment.fetchData)
        {
          throw new Error(
            "An outgoing attachment requires fetchData; external URLs are not silently fetched",
          );
        }
        const bytes = await attachment.fetchData();
        media.push(
          await this.configuration.client.upload(
            new Uint8Array(bytes),
            attachment.mimeType ?? "application/octet-stream",
            attachment.name,
          ),
        );
      }
      const first = media[0];
      if (!first) throw new Error("Media content is missing");
      if (media.length === 1)
      {
        outbound = OutboundMessageSchema.parse({
          ...base,
          contentKind: mediaKind(first),
          media: first,
          ...(text ? { caption: text } : {}),
        });
      }
      else
      {
        if (media.some(reference => !["IMAGE", "VIDEO"].includes(mediaKind(reference))))
        {
          throw new Error("Multiple attachments must be image/video album parts");
        }
        outbound = OutboundMessageSchema.parse({
          ...base,
          contentKind: "ALBUM",
          parts: media.map((reference, index) => ({
            contentKind: mediaKind(reference),
            media: reference,
            ...(index === 0 && text ? { caption: text } : {}),
          })),
        });
      }
    }
    else if (text !== undefined) outbound = { ...base, contentKind: "TEXT", text };
    else
    {
      const card = projectCard(message);
      const image = card.imageUrl ? await this.uploadCardImage(card.imageUrl) : undefined;
      outbound = OutboundMessageSchema.parse({
        ...base,
        contentKind: image ? "CARD" : "BUTTONS",
        text: card.text,
        choices: card.choices,
        ...(image ? { image } : {}),
      });
    }
    return this.postGatewayWithKey(threadId, outbound);
  }
  private async uploadCardImage(value: string): Promise<MediaReference>
  {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    {
      throw new Error("Expected an HTTP(S) card image URL without credentials");
    }
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Card image body is unavailable");
    const maximum = 32 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try
    {
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/jpeg")
      {
        throw new Error("A reply card requires a JPEG image");
      }
      if (Number(response.headers.get("content-length")) > maximum)
      {
        throw new Error("Card image exceeds the byte limit");
      }
      for (;;)
      {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) throw new Error("Card image exceeds the byte limit");
        chunks.push(chunk.value);
      }
      return this.configuration.client.upload(Buffer.concat(chunks, size), "image/jpeg");
    }
    finally
    {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async executeWithKey(threadId: string, input: OutboundMessage): Promise<OperationResult>
  {
    const message = OutboundMessageSchema.parse(input);
    const thread = this.decodeThreadId(threadId);
    if (message.recipientAddress !== thread.chatId || message.senderAddress !== this.botUserId)
    {
      throw new Error("Outbound message correlation mismatch");
    }
    return this.configuration.client.send(this.mapping.scope.accountId, message);
  }
  async postGatewayWithKey(
    threadId: string,
    input: OutboundMessage,
  ): Promise<RawMessage<GatewayObservedMessage>>
  {
    const message = OutboundMessageSchema.parse(input);
    const thread = this.decodeThreadId(threadId);
    if (message.recipientAddress !== thread.chatId || message.senderAddress !== this.botUserId)
    {
      throw new Error("Outbound message correlation mismatch");
    }
    if (["EDIT", "DELETE", "REACTION"].includes(message.contentKind))
    {
      throw new Error("Lifecycle operations return an outcome through executeWithKey");
    }
    const operation = await this.executeWithKey(threadId, message);
    if (operation.state !== "ACCEPTED") throw new GatewayOutcomeError(operation);
    const id = operation.nativeIds[0];
    if (!id) throw new Error("Accepted message has no native identity");
    const observation = await this.configuration.client.message(thread.chatId, id);
    if (!observation)
    {
      throw new Error("Accepted message snapshot is unavailable; preserve its original operation key");
    }
    return { id, threadId, raw: observation };
  }
  private async target(threadId: string, messageId: string): Promise<MessageTarget>
  {
    const thread = this.decodeThreadId(threadId);
    const message = await this.configuration.client.message(thread.chatId, messageId);
    if (!message) throw new Error("Message target is not in observed history");
    return {
      channelMessageId: messageId,
      chatAddress: thread.chatId,
      senderAddress: message.message.senderAddress,
    };
  }
  async reply(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<GatewayObservedMessage>>
  {
    return this.postWithKey(threadId, message, randomUUID(), await this.target(threadId, messageId));
  }
  private async action(threadId: string, content: GatewayActionContent): Promise<void>
  {
    const thread = this.decodeThreadId(threadId);
    const result = await this.configuration.client.send(
      this.mapping.scope.accountId,
      OutboundMessageSchema.parse({
        channel: "WHATSAPP",
        senderAddress: this.botUserId,
        recipientAddress: thread.chatId,
        idempotencyKey: randomUUID(),
        ...content,
      }),
    );
    if (result.state !== "ACCEPTED") throw new GatewayOutcomeError(result);
  }
  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<GatewayObservedMessage>>
  {
    const text = postableText(message);
    if (
      text === undefined
      || (typeof message === "object"
        && (("files" in message && message.files?.length)
          || ("attachments" in message && message.attachments?.length)))
    ) throw new Error("Only text edits are qualified");
    const target = await this.target(threadId, messageId);
    if (target.senderAddress !== this.botUserId) throw new Error("Cannot edit another sender's message");
    await this.action(threadId, { contentKind: "EDIT", target, text });
    const edited = await this.configuration.client.message(target.chatAddress, messageId);
    if (!edited) throw new Error("Edited message snapshot unavailable");
    return { id: messageId, threadId, raw: edited };
  }
  async deleteMessage(threadId: string, messageId: string): Promise<void>
  {
    await this.action(threadId, { contentKind: "DELETE", target: await this.target(threadId, messageId) });
  }
  async addReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void>
  {
    await this.action(threadId, {
      contentKind: "REACTION",
      target: await this.target(threadId, messageId),
      emoji: defaultEmojiResolver.toGChat(emoji),
    });
  }
  async removeReaction(threadId: string, messageId: string, _emoji: EmojiValue | string): Promise<void>
  {
    await this.action(threadId, {
      contentKind: "REACTION",
      target: await this.target(threadId, messageId),
      emoji: "",
    });
  }
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response>
  {
    if (!this.configuration.webhookSecret)
    {
      return new Response("Webhook intake is not configured", { status: 503 });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body: Uint8Array | null;
    try
    {
      body = await boundedWebhookBody(
        request,
        this.configuration.maximumWebhookBytes ?? 1024 * 1024,
        this.configuration.webhookBodyTimeoutMs ?? 15000,
      );
    }
    catch (error)
    {
      return new Response(null, { status: error instanceof GatewayWebhookBodyTimeout ? 408 : 400 });
    }
    if (!body) return new Response(null, { status: 413 });
    const eventId = request.headers.get("x-gateway-event-id") ?? "";
    const valid = await verifyGatewayWebhook(this.configuration.webhookSecret, {
      eventId,
      timestamp: request.headers.get("x-gateway-timestamp") ?? "",
      signature: request.headers.get("x-gateway-signature") ?? "",
    }, body);
    if (!valid) return new Response(null, { status: 401 });
    let input: unknown;
    try
    {
      input = JSON.parse(new TextDecoder().decode(body));
    }
    catch
    {
      return new Response(null, { status: 400 });
    }
    const parsed = GatewayCloudEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.id !== eventId) return new Response(null, { status: 400 });
    const event = parsed.data;
    if (
      event.workspaceid !== this.mapping.scope.workspaceId || event.accountid !== this.mapping.scope.accountId
    ) return new Response(null, { status: 403 });
    try
    {
      await this.processGatewayEvent(event, options);
      return new Response(null, { status: 204 });
    }
    catch
    {
      return new Response(null, { status: 503 });
    }
  }
  async processGatewayEvent(input: unknown, options?: WebhookOptions): Promise<void>
  {
    if (this.closed || !this.chat) throw new Error("Adapter is not initialized or is closed");
    const event = GatewayCloudEventSchema.parse(input);
    if (
      event.workspaceid !== this.mapping.scope.workspaceId || event.accountid !== this.mapping.scope.accountId
    ) throw new Error("Event account scope mismatch");
    if (event.type !== "com.digows.whatsapp.message.received.v1") return;
    const task = this.processReceived(event.id, event.data.message, options);
    this.active.add(task);
    try
    {
      await task;
    }
    finally
    {
      this.active.delete(task);
    }
  }
  private async processReceived(eventId: string, raw: InboundMessage, options?: WebhookOptions): Promise<void>
  {
    const chat = this.chat;
    if (!chat) throw new Error("Adapter is not initialized");
    const state = chat.getState();
    const threadId = this.encodeThreadId({ ...this.mapping.scope, chatId: raw.chatAddress });
    const completedKey = `${this.getConcurrencyScope()}:gateway-completed:${eventId}`;
    if (await state.get(completedKey)) return;
    const lock = await state.acquireLock(`${this.getConcurrencyScope()}:gateway-intake:${threadId}`, 30000);
    if (!lock) throw new Error("Gateway conversation handler is busy; retry delivery");
    let lost = false;
    let renewal: Promise<void> = Promise.resolve();
    const timer = setInterval(() =>
    {
      renewal = renewal.then(async () =>
      {
        if (!await state.extendLock(lock, 30000)) lost = true;
      }).catch(() =>
      {
        lost = true;
      });
    }, 10000);
    timer.unref();
    try
    {
      if (await state.get(completedKey)) return;
      const webhookOptions: WebhookOptions = { ...options, deduplicate: false, propagateHandlerErrors: true };
      const observation: GatewayObservedMessage = {
        workspaceId: this.mapping.scope.workspaceId,
        accountId: this.mapping.scope.accountId,
        direction: "INBOUND",
        message: raw,
        observedAt: new Date().toISOString(),
        timestampSource: "PROVIDER",
        edited: raw.contentKind === "EDIT",
        deleted: false,
      };
      const parsed = this.parseMessage(observation);
      const user = parsed.author;
      if (raw.contentKind === "SELECTION")
      {
        const action = decodeGatewayAction(raw.optionId);
        await chat.processAction({
          adapter: this,
          actionId: action.id,
          messageId: raw.originatingChannelMessageId,
          threadId,
          user,
          raw,
          ...(action.value !== undefined ? { value: action.value } : {}),
        }, webhookOptions);
      }
      else if (raw.contentKind === "REACTION")
      {
        await chat.processReaction({
          adapter: this,
          added: raw.emoji !== "",
          emoji: defaultEmojiResolver.fromGChat(raw.emoji),
          rawEmoji: raw.emoji,
          messageId: raw.target.channelMessageId,
          threadId,
          user,
          raw,
        }, webhookOptions);
      }
      else if (raw.contentKind === "DELETE")
      {
        await chat.processMessageDeleted({
          adapter: this,
          channelId: threadId,
          messageId: raw.target.channelMessageId,
          threadId,
          deletedAt: new Date(raw.occurredAt),
          raw,
        }, webhookOptions);
      }
      else if (raw.contentKind === "EDIT")
      {
        const { target, ...content } = raw;
        const retained = await this.configuration.client.message(target.chatAddress, target.channelMessageId);
        const edited = this.parseMessage({
          ...observation,
          direction: retained?.message.senderAddress === target.senderAddress
            ? retained.direction
            : observation.direction,
          message: {
            ...content,
            contentKind: "TEXT",
            channelMessageId: target.channelMessageId,
            senderAddress: target.senderAddress,
            chatAddress: target.chatAddress,
          },
        });
        await chat.processMessageUpdated({ adapter: this, threadId, message: edited }, webhookOptions);
      }
      else await chat.processMessage(this, threadId, parsed, webhookOptions);
      await renewal;
      if (lost || !await state.extendLock(lock, 30000))
      {
        throw new Error("Gateway event ownership was lost during the handler");
      }
      await state.set(completedKey, true, this.configuration.completedEventRetentionMs ?? 7 * 86400000);
    }
    finally
    {
      clearInterval(timer);
      await renewal;
      await state.releaseLock(lock);
    }
  }
  async disconnect(): Promise<void>
  {
    this.closed = true;
    await Promise.allSettled([...this.active]);
    await this.configuration.client.close();
  }
}
type GatewayActionContent = EditContent | DeleteContent | ReactionContent;
function mediaKind(reference: MediaReference): "IMAGE" | "VIDEO" | "AUDIO" | "FILE"
{
  return reference.contentType.startsWith("image/")
    ? "IMAGE"
    : reference.contentType.startsWith("video/")
    ? "VIDEO"
    : reference.contentType.startsWith("audio/")
    ? "AUDIO"
    : "FILE";
}
import { MediaReferenceSchema } from "@digows/whatsapp-gateway-contracts";
function parseMediaReference(input: unknown): MediaReference
{
  return MediaReferenceSchema.parse(input);
}
class GatewayWebhookBodyTimeout extends Error
{}
async function boundedWebhookBody(
  request: Request,
  maximumBytes: number,
  timeoutMs: number,
): Promise<Uint8Array | null>
{
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const cancel = (): void =>
  {
    expired = true;
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(cancel, timeoutMs);
  request.signal.addEventListener("abort", cancel, { once: true });
  try
  {
    for (;;)
    {
      const chunk = await reader.read();
      if (expired || request.signal.aborted) throw new GatewayWebhookBodyTimeout();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > maximumBytes)
      {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  }
  finally
  {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
