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
import { MessageContentType } from '../../domain/entities/messaging/MessageContentType.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
import {
  ChatType,
  MessageContext,
} from '../../domain/entities/messaging/MessageContext.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import {
  SessionStatus,
  SessionStatusEvent,
} from '../../domain/entities/operational/SessionStatus.js';
import {
  WorkerCommand,
  WorkerCommandAction,
} from '../../domain/entities/operational/WorkerCommand.js';
import { NatsConnection } from './NatsConnection.js';
import { NatsSubjectBuilder } from './NatsSubjectBuilder.js';

type SessionPayload = {
  provider: string;
  workspaceId: number;
  sessionId: string;
};

type MessageContentPayload = {
  type: string;
  text?: string;
  mediaUrl?: string;
  fileName?: string;
};

type MessageContextPayload = {
  chatType: string;
  remoteJid: string;
  participantId?: string;
  senderPhone?: string;
};

type MessagePayload = {
  chatId: string;
  timestamp: string;
  content: MessageContentPayload;
  messageId?: string;
  senderId?: string;
  participantId?: string;
  context?: MessageContextPayload;
};

type SendMessageCommandPayload = {
  commandId: string;
  session: SessionPayload;
  message: MessagePayload;
};

type WorkerCommandPayload = {
  commandId: string;
  action: string;
  session: SessionPayload;
};

type SessionStatusPayload = {
  session: SessionPayload;
  workerId?: string;
  status: string;
  reason?: string;
  timestamp: string;
};

type DeliveryResultPayload = {
  commandId: string;
  session: SessionPayload;
  recipientId: string;
  status: string;
  providerMessageId?: string;
  reason?: string;
  timestamp: string;
};

type ReceivedMessageEventPayload = {
  eventType: InboundEventType.MessageReceived;
  session: SessionPayload;
  timestamp: string;
  message: MessagePayload;
};

type MessageUpdatedEventPayload = {
  eventType: InboundEventType.MessageUpdated;
  session: SessionPayload;
  timestamp: string;
  messageId: string;
  chatId: string;
  senderId: string;
  fromMe: boolean;
  status?: number;
  stubType?: number;
  contentType?: string;
  pollUpdateCount?: number;
};

type MessageReactionEventPayload = {
  eventType: InboundEventType.MessageReaction;
  session: SessionPayload;
  timestamp: string;
  messageId?: string;
  chatId: string;
  senderId: string;
  fromMe: boolean;
  reactionText?: string;
  removed: boolean;
};

type InboundEventPayload =
  | ReceivedMessageEventPayload
  | MessageUpdatedEventPayload
  | MessageReactionEventPayload;

type WorkerCommandHandler = (command: WorkerCommand) => Promise<void>;
type OutgoingHandler = (command: SendMessageCommand) => Promise<void>;

/**
 * NATS implementation of the worker transport contract.
 */
export class NatsChannelTransport implements WorkerTransport {
  private readonly workerCommandCodec = JSONCodec<WorkerCommandPayload>();
  private readonly inboundCodec = JSONCodec<InboundEventPayload>();
  private readonly outgoingCodec = JSONCodec<SendMessageCommandPayload>();
  private readonly deliveryCodec = JSONCodec<DeliveryResultPayload>();
  private readonly sessionStatusCodec = JSONCodec<SessionStatusPayload>();

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
      payload => handler(this.mapWorkerCommand(payload)),
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
      payload => handler(this.mapSendMessageCommand(payload)),
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
      this.inboundCodec.encode(this.mapInboundEventPayload(event)),
    );
  }

  public async publishDelivery(event: DeliveryResult): Promise<void> {
    const client = await NatsConnection.getClient();
    client.publish(
      NatsSubjectBuilder.getSessionSubject(event.session, 'delivery'),
      this.deliveryCodec.encode({
        commandId: event.commandId,
        session: this.mapSessionPayload(event.session),
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
        session: this.mapSessionPayload(event.session),
        workerId: event.workerId,
        status: event.status,
        reason: event.reason,
        timestamp: event.timestamp,
      }),
    );
  }

  private mapInboundEventPayload(event: InboundEvent): InboundEventPayload {
    if (event instanceof ReceivedMessageEvent) {
      return {
        eventType: event.eventType,
        session: this.mapSessionPayload(event.session),
        timestamp: event.timestamp,
        message: this.mapMessagePayload(event.message),
      };
    }

    if (event instanceof MessageUpdatedEvent) {
      return {
        eventType: event.eventType,
        session: this.mapSessionPayload(event.session),
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
      session: this.mapSessionPayload(event.session),
      timestamp: event.timestamp,
      messageId: event.messageId,
      chatId: event.chatId,
      senderId: event.senderId,
      fromMe: event.fromMe,
      reactionText: event.reactionText,
      removed: event.removed,
    };
  }

  private mapWorkerCommand(payload: WorkerCommandPayload): WorkerCommand {
    return new WorkerCommand(
      payload.commandId,
      payload.action as WorkerCommandAction,
      this.mapSession(payload.session),
    );
  }

  private mapSendMessageCommand(payload: SendMessageCommandPayload): SendMessageCommand {
    return new SendMessageCommand(
      payload.commandId,
      this.mapSession(payload.session),
      this.mapMessage(payload.message),
    );
  }

  private mapSession(payload: SessionPayload): SessionReference {
    return new SessionReference(payload.provider, payload.workspaceId, payload.sessionId);
  }

  private mapSessionPayload(session: SessionReference): SessionPayload {
    return {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    };
  }

  private mapMessage(payload: MessagePayload): Message {
    return new Message(
      payload.chatId,
      payload.timestamp,
      this.mapMessageContent(payload.content),
      payload.messageId,
      payload.senderId,
      payload.participantId,
      payload.context
        ? new MessageContext(
            payload.context.chatType as ChatType,
            payload.context.remoteJid,
            payload.context.participantId,
            payload.context.senderPhone,
          )
        : undefined,
    );
  }

  private mapMessagePayload(message: Message): MessagePayload {
    return {
      chatId: message.chatId,
      timestamp: message.timestamp,
      content: this.mapMessageContentPayload(message.content),
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

  private mapMessageContent(payload: MessageContentPayload): MessageContent {
    return new MessageContent(
      payload.type as MessageContentType,
      payload.text,
      payload.mediaUrl,
      payload.fileName,
    );
  }

  private mapMessageContentPayload(content: MessageContent): MessageContentPayload {
    return {
      type: content.type,
      text: content.text,
      mediaUrl: content.mediaUrl,
      fileName: content.fileName,
    };
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
