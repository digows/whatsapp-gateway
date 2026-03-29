import { Codec, JSONCodec, Subscription } from 'nats';
import { WorkerTransport } from '../../application/contracts/WorkerTransport.js';
import {
  DeliveryResult,
  DeliveryStatus,
} from '../../domain/entities/messaging/DeliveryResult.js';
import {
  InboundEvent,
  InboundEventType,
  MessageReactionEvent,
  MessageUpdatedEvent,
  ReceivedMessageEvent,
} from '../../domain/entities/messaging/InboundEvent.js';
import { Message } from '../../domain/entities/messaging/Message.js';
import { MessageContent } from '../../domain/entities/messaging/MessageContent.js';
import {
  MessageContentType,
  parseMessageContentType,
} from '../../domain/entities/messaging/MessageContentType.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
import {
  ChatType,
  MessageContext,
  parseChatType,
} from '../../domain/entities/messaging/MessageContext.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { SessionStatusEvent } from '../../domain/entities/operational/SessionStatus.js';
import {
  WorkerCommand,
  parseWorkerCommandAction,
} from '../../domain/entities/operational/WorkerCommand.js';
import { NatsConnection } from './NatsConnection.js';
import { NatsSubjectBuilder } from './NatsSubjectBuilder.js';

type WorkerCommandHandler = (command: WorkerCommand) => Promise<void>;
type OutgoingHandler = (command: SendMessageCommand) => Promise<void>;

/**
 * NATS implementation of the worker transport contract.
 * The wire format is parsed explicitly so invalid broker payloads never become
 * invalid domain entities by unchecked casts.
 */
export class NatsChannelTransport implements WorkerTransport {
  private readonly workerCommandCodec = JSONCodec<unknown>();
  private readonly inboundCodec = JSONCodec<unknown>();
  private readonly outgoingCodec = JSONCodec<unknown>();
  private readonly deliveryCodec = JSONCodec<unknown>();
  private readonly sessionStatusCodec = JSONCodec<unknown>();

  private workerSubscription?: Subscription;
  private readonly outgoingSubscriptions = new Map<string, Subscription>();

  constructor(private readonly providerId: string) {}

  public async connect(): Promise<void> {
    await NatsConnection.getClient();
  }

  public async disconnect(): Promise<void> {
    this.workerSubscription?.unsubscribe();
    this.workerSubscription = undefined;

    for (const subscription of this.outgoingSubscriptions.values()) {
      subscription.unsubscribe();
    }

    this.outgoingSubscriptions.clear();
    await NatsConnection.close();
  }

  public async subscribeWorkerCommands(
    workerId: string,
    handler: WorkerCommandHandler,
  ): Promise<void> {
    const client = await NatsConnection.getClient();

    this.workerSubscription?.unsubscribe();
    const subscription = client.subscribe(
      NatsSubjectBuilder.getWorkerControlSubject(this.providerId, workerId),
    );
    this.workerSubscription = subscription;

    void this.consume(
      subscription,
      this.workerCommandCodec,
      payload => handler(this.parseWorkerCommand(payload)),
      '[NATS] Failed to process worker command:',
    );
  }

  public async subscribeOutgoing(
    session: SessionReference,
    handler: OutgoingHandler,
  ): Promise<void> {
    const client = await NatsConnection.getClient();
    const sessionKey = session.toKey();

    this.outgoingSubscriptions.get(sessionKey)?.unsubscribe();
    const subscription = client.subscribe(
      NatsSubjectBuilder.getSessionSubject(session, 'outgoing'),
    );
    this.outgoingSubscriptions.set(sessionKey, subscription);

    void this.consume(
      subscription,
      this.outgoingCodec,
      payload => handler(this.parseSendMessageCommand(payload)),
      '[NATS] Failed to process outbound command:',
    );
  }

  public async disconnectSession(session: SessionReference): Promise<void> {
    const sessionKey = session.toKey();
    this.outgoingSubscriptions.get(sessionKey)?.unsubscribe();
    this.outgoingSubscriptions.delete(sessionKey);
  }

  public async publishInbound(event: InboundEvent): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      NatsSubjectBuilder.getSessionSubject(event.session, 'incoming'),
      this.inboundCodec.encode(this.serializeInboundEvent(event)),
    );
  }

  public async publishDelivery(event: DeliveryResult): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      NatsSubjectBuilder.getSessionSubject(event.session, 'delivery'),
      this.deliveryCodec.encode({
        commandId: event.commandId,
        session: this.serializeSession(event.session),
        recipientId: event.recipientId,
        status: event.status,
        providerMessageId: event.providerMessageId,
        reason: event.reason,
        timestamp: event.timestamp,
      }),
    );
  }

  public async publishSessionStatus(event: SessionStatusEvent): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      NatsSubjectBuilder.getSessionSubject(event.session, 'status'),
      this.sessionStatusCodec.encode({
        session: this.serializeSession(event.session),
        workerId: event.workerId,
        status: event.status,
        reason: event.reason,
        timestamp: event.timestamp,
      }),
    );
  }

  private serializeInboundEvent(event: InboundEvent): Record<string, unknown> {
    if (event instanceof ReceivedMessageEvent) {
      return {
        eventType: event.eventType,
        session: this.serializeSession(event.session),
        timestamp: event.timestamp,
        message: this.serializeMessage(event.message),
      };
    }

    if (event instanceof MessageUpdatedEvent) {
      return {
        eventType: event.eventType,
        session: this.serializeSession(event.session),
        timestamp: event.timestamp,
        messageId: event.messageId,
        chatId: event.chatId,
        senderId: event.senderId,
        fromMe: event.fromMe,
        status: event.status,
        stubType: event.stubType,
        contentType: event.contentType,
        pollUpdateCount: event.pollUpdateCount,
      };
    }

    return {
      eventType: event.eventType,
      session: this.serializeSession(event.session),
      timestamp: event.timestamp,
      messageId: event.messageId,
      chatId: event.chatId,
      senderId: event.senderId,
      fromMe: event.fromMe,
      reactionText: event.reactionText,
      removed: event.removed,
    };
  }

  private parseWorkerCommand(payload: unknown): WorkerCommand {
    const payloadRecord = this.requireRecord(payload, 'worker command');
    return new WorkerCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'worker command'),
      parseWorkerCommandAction(this.readRequiredString(payloadRecord, 'action', 'worker command')),
      this.parseSession(payloadRecord.session, 'worker command session'),
    );
  }

  private parseSendMessageCommand(payload: unknown): SendMessageCommand {
    const payloadRecord = this.requireRecord(payload, 'outgoing command');
    return new SendMessageCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'outgoing command'),
      this.parseSession(payloadRecord.session, 'outgoing command session'),
      this.parseMessage(payloadRecord.message, 'outgoing command message'),
    );
  }

  private parseSession(payload: unknown, label: string): SessionReference {
    const payloadRecord = this.requireRecord(payload, label);
    return new SessionReference(
      this.readRequiredString(payloadRecord, 'provider', label),
      this.readRequiredNumber(payloadRecord, 'workspaceId', label),
      this.readRequiredString(payloadRecord, 'sessionId', label),
    );
  }

  private serializeSession(session: SessionReference): Record<string, unknown> {
    return {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    };
  }

  private parseMessage(payload: unknown, label: string): Message {
    const payloadRecord = this.requireRecord(payload, label);
    const rawContext = payloadRecord.context;

    return new Message(
      this.readRequiredString(payloadRecord, 'chatId', label),
      this.readRequiredString(payloadRecord, 'timestamp', label),
      this.parseMessageContent(payloadRecord.content, `${label} content`),
      this.readOptionalString(payloadRecord, 'messageId', label),
      this.readOptionalString(payloadRecord, 'senderId', label),
      this.readOptionalString(payloadRecord, 'participantId', label),
      rawContext === undefined
        ? undefined
        : this.parseMessageContext(rawContext, `${label} context`),
    );
  }

  private serializeMessage(message: Message): Record<string, unknown> {
    return {
      chatId: message.chatId,
      timestamp: message.timestamp,
      content: this.serializeMessageContent(message.content),
      messageId: message.messageId,
      senderId: message.senderId,
      participantId: message.participantId,
      context: message.context
        ? {
            chatType: message.context.chatType,
            remoteJid: message.context.remoteJid,
            participantId: message.context.participantId,
            senderPhone: message.context.senderPhone,
          }
        : undefined,
    };
  }

  private parseMessageContext(payload: unknown, label: string): MessageContext {
    const payloadRecord = this.requireRecord(payload, label);
    return new MessageContext(
      parseChatType(this.readRequiredString(payloadRecord, 'chatType', label)),
      this.readRequiredString(payloadRecord, 'remoteJid', label),
      this.readOptionalString(payloadRecord, 'participantId', label),
      this.readOptionalString(payloadRecord, 'senderPhone', label),
    );
  }

  private parseMessageContent(payload: unknown, label: string): MessageContent {
    const payloadRecord = this.requireRecord(payload, label);
    return new MessageContent(
      parseMessageContentType(this.readRequiredString(payloadRecord, 'type', label)),
      this.readOptionalString(payloadRecord, 'text', label),
      this.readOptionalString(payloadRecord, 'mediaUrl', label),
      this.readOptionalString(payloadRecord, 'fileName', label),
    );
  }

  private serializeMessageContent(content: MessageContent): Record<string, unknown> {
    return {
      type: content.type,
      text: content.text,
      mediaUrl: content.mediaUrl,
      fileName: content.fileName,
    };
  }

  private requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!this.isRecord(value)) {
      throw new Error(`${label} must be an object.`);
    }

    return value;
  }

  private readRequiredString(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): string {
    const value = source[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${label}.${key} must be a non-empty string.`);
    }

    return value;
  }

  private readOptionalString(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): string | undefined {
    const value = source[key];
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new Error(`${label}.${key} must be a string when provided.`);
    }

    return value;
  }

  private readRequiredNumber(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): number {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label}.${key} must be a finite number.`);
    }

    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async consume<T>(
    subscription: Subscription,
    codec: Codec<T>,
    handler: (payload: T) => Promise<void>,
    errorMessage: string,
  ): Promise<void> {
    for await (const message of subscription) {
      try {
        const payload = codec.decode(message.data);
        await handler(payload);
      } catch (error) {
        console.error(errorMessage, error);
      }
    }
  }
}
