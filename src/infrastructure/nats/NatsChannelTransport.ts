import {
  Codec,
  DiscardPolicy,
  JetStreamClient,
  JetStreamManager,
  JetStreamSubscription,
  JSONCodec,
  RetentionPolicy,
  StorageType,
  Subscription,
  consumerOpts,
  nanos,
} from 'nats';
import { env } from '../../application/config/env.js';
import { WorkerTransport } from '../../application/contracts/WorkerTransport.js';
import {
  ActivationCommand,
  parseActivationCommandAction,
} from '../../domain/entities/activation/ActivationCommand.js';
import {
  ActivationCancelledEvent,
  ActivationCompletedEvent,
  ActivationEvent,
  ActivationExpiredEvent,
  ActivationFailedEvent,
  ActivationPairingCodeUpdatedEvent,
  ActivationQrCodeUpdatedEvent,
  ActivationStartedEvent,
} from '../../domain/entities/activation/ActivationEvent.js';
import { parseActivationMode } from '../../domain/entities/activation/ActivationMode.js';
import {
  DeliveryResult,
} from '../../domain/entities/messaging/DeliveryResult.js';
import {
  InboundEvent,
  MessageReactionEvent,
  MessageUpdatedEvent,
  ReceivedMessageEvent,
} from '../../domain/entities/messaging/InboundEvent.js';
import { Message } from '../../domain/entities/messaging/Message.js';
import { MessageContent } from '../../domain/entities/messaging/MessageContent.js';
import { parseMessageContentType } from '../../domain/entities/messaging/MessageContentType.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
import { MessageContext, parseChatType } from '../../domain/entities/messaging/MessageContext.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { SessionStatusEvent } from '../../domain/entities/operational/SessionStatus.js';
import { WorkerCommand, parseWorkerCommandAction } from '../../domain/entities/operational/WorkerCommand.js';
import { NatsConnection } from './NatsConnection.js';
import { NatsSubjectBuilder } from './NatsSubjectBuilder.js';
import {
  CommandClaimStatus,
  CommandKind,
  RedisCommandDeduplicator,
} from '../redis/RedisCommandDeduplicator.js';
import { RedisConnection } from '../redis/RedisConnection.js';

type WorkerCommandHandler = (command: WorkerCommand) => Promise<void>;
type OutgoingHandler = (command: SendMessageCommand) => Promise<void>;
type ActivationHandler = (command: ActivationCommand) => Promise<void>;
type BrokerSubscription = Subscription | JetStreamSubscription;
type BrokerMessageHandling = 'ack' | 'retry';

/**
 * NATS implementation of the worker transport contract.
 * It keeps the broker boundary explicit and rebuilds domain entities from wire payloads.
 */
export class NatsChannelTransport implements WorkerTransport {
  private readonly workerCommandCodec = JSONCodec<unknown>();
  private readonly outboundCodec = JSONCodec<unknown>();
  private readonly activationCodec = JSONCodec<unknown>();
  private readonly inboundCodec = JSONCodec<unknown>();
  private readonly deliveryCodec = JSONCodec<unknown>();
  private readonly sessionStatusCodec = JSONCodec<unknown>();

  private workerSubscription?: BrokerSubscription;
  private readonly outboundSubscriptions = new Map<string, BrokerSubscription>();
  private readonly activationSubscriptions = new Map<string, BrokerSubscription>();
  private jetStreamClient?: JetStreamClient;
  private jetStreamManager?: JetStreamManager;
  private commandDeduplicator?: RedisCommandDeduplicator;

  constructor(private readonly providerId: string) {}

  public async connect(): Promise<void> {
    const client = await NatsConnection.getClient();

    if (env.NATS_MODE !== 'jetstream') {
      return;
    }

    this.jetStreamClient = client.jetstream();
    this.jetStreamManager = await client.jetstreamManager();
    await this.ensureJetStreamStream();
  }

  public async disconnect(): Promise<void> {
    this.unsubscribe(this.workerSubscription);
    this.workerSubscription = undefined;

    for (const subscription of this.outboundSubscriptions.values()) {
      this.unsubscribe(subscription);
    }

    for (const subscription of this.activationSubscriptions.values()) {
      this.unsubscribe(subscription);
    }

    this.outboundSubscriptions.clear();
    this.activationSubscriptions.clear();
    this.jetStreamClient = undefined;
    this.jetStreamManager = undefined;
    await NatsConnection.close();
  }

  public async subscribeWorkerCommands(
    workerId: string,
    handler: WorkerCommandHandler,
  ): Promise<void> {
    const subject = NatsSubjectBuilder.getWorkerControlSubject(this.providerId, workerId);

    this.unsubscribe(this.workerSubscription);

    if (env.NATS_MODE === 'jetstream') {
      const subscription = await this.subscribeJetStream(
        subject,
        this.buildWorkerConsumerName(workerId),
      );
      this.workerSubscription = subscription;

      void this.consumeJetStream(
        subscription,
        this.workerCommandCodec,
        payload => this.handleWorkerCommandPayload(payload, handler),
        '[NATS] Failed to process worker command:',
      );
      return;
    }

    const client = await NatsConnection.getClient();
    const subscription = client.subscribe(subject);
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
    const subject = NatsSubjectBuilder.getSessionSubject(session, 'outgoing');
    const sessionKey = session.toKey();

    this.unsubscribe(this.outboundSubscriptions.get(sessionKey));

    if (env.NATS_MODE === 'jetstream') {
      const subscription = await this.subscribeJetStream(
        subject,
        this.buildSessionConsumerName('outgoing', session),
      );
      this.outboundSubscriptions.set(sessionKey, subscription);

      void this.consumeJetStream(
        subscription,
        this.outboundCodec,
        payload => this.handleOutgoingPayload(payload, handler),
        '[NATS] Failed to process outbound command:',
      );
      return;
    }

    const client = await NatsConnection.getClient();
    const subscription = client.subscribe(subject);
    this.outboundSubscriptions.set(sessionKey, subscription);

    void this.consume(
      subscription,
      this.outboundCodec,
      payload => handler(this.parseSendMessageCommand(payload)),
      '[NATS] Failed to process outbound command:',
    );
  }

  public async subscribeActivation(
    session: SessionReference,
    handler: ActivationHandler,
  ): Promise<void> {
    const subject = NatsSubjectBuilder.getActivationSubject(session);
    const sessionKey = session.toKey();

    this.unsubscribe(this.activationSubscriptions.get(sessionKey));

    if (env.NATS_MODE === 'jetstream') {
      const subscription = await this.subscribeJetStream(
        subject,
        this.buildSessionConsumerName('activation', session),
      );
      this.activationSubscriptions.set(sessionKey, subscription);

      void this.consumeJetStream(
        subscription,
        this.activationCodec,
        payload => this.handleActivationPayload(payload, handler),
        '[NATS] Failed to process activation command:',
      );
      return;
    }

    const client = await NatsConnection.getClient();
    const subscription = client.subscribe(subject);
    this.activationSubscriptions.set(sessionKey, subscription);

    void this.consume(
      subscription,
      this.activationCodec,
      async payload => {
        if (!this.isActivationCommandPayload(payload)) {
          return;
        }

        await handler(this.parseActivationCommand(payload));
      },
      '[NATS] Failed to process activation command:',
    );
  }

  public async disconnectSession(session: SessionReference): Promise<void> {
    const sessionKey = session.toKey();
    this.unsubscribe(this.outboundSubscriptions.get(sessionKey));
    this.outboundSubscriptions.delete(sessionKey);
    this.unsubscribe(this.activationSubscriptions.get(sessionKey));
    this.activationSubscriptions.delete(sessionKey);
  }

  public async publishActivation(event: ActivationEvent): Promise<void> {
    const subject = NatsSubjectBuilder.getActivationSubject(event.session);
    await this.publish(
      subject,
      this.activationCodec.encode(this.serializeActivationEvent(event)),
      this.buildActivationEventMessageId(event),
    );
  }

  public async publishInbound(event: InboundEvent): Promise<void> {
    const subject = NatsSubjectBuilder.getSessionSubject(event.session, 'incoming');
    await this.publish(
      subject,
      this.inboundCodec.encode(this.serializeInboundEvent(event)),
      this.buildInboundEventMessageId(event),
    );
  }

  public async publishDelivery(event: DeliveryResult): Promise<void> {
    const subject = NatsSubjectBuilder.getSessionSubject(event.session, 'delivery');
    await this.publish(
      subject,
      this.deliveryCodec.encode({
        commandId: event.commandId,
        session: this.serializeSession(event.session),
        recipientId: event.recipientId,
        status: event.status,
        providerMessageId: event.providerMessageId,
        reason: event.reason,
        timestamp: event.timestamp,
      }),
      this.buildDeliveryMessageId(event),
    );
  }

  public async publishSessionStatus(event: SessionStatusEvent): Promise<void> {
    const subject = NatsSubjectBuilder.getSessionSubject(event.session, 'status');
    await this.publish(
      subject,
      this.sessionStatusCodec.encode({
        session: this.serializeSession(event.session),
        workerId: event.workerId,
        status: event.status,
        reason: event.reason,
        timestamp: event.timestamp,
      }),
      this.buildSessionStatusMessageId(event),
    );
  }

  private async subscribeJetStream(
    subject: string,
    durableName: string,
  ): Promise<JetStreamSubscription> {
    const options = consumerOpts();
    options.bindStream(env.NATS_JETSTREAM_STREAM_NAME);
    options.durable(durableName);
    options.deliverNew();
    options.ackExplicit();
    options.manualAck();
    options.ackWait(env.NATS_JETSTREAM_ACK_WAIT_MS);
    options.maxDeliver(env.NATS_JETSTREAM_MAX_DELIVER);
    options.filterSubject(subject);

    return this.getJetStreamClient().subscribe(subject, options);
  }

  private async ensureJetStreamStream(): Promise<void> {
    const manager = this.getJetStreamManager();
    const configuration = {
      subjects: NatsSubjectBuilder.getJetStreamSubjects(this.providerId),
      retention: RetentionPolicy.Limits,
      storage: this.getJetStreamStorageType(),
      discard: DiscardPolicy.Old,
      max_age: nanos(env.NATS_JETSTREAM_MAX_AGE_MS),
      duplicate_window: nanos(env.NATS_JETSTREAM_DUPLICATE_WINDOW_MS),
      num_replicas: env.NATS_JETSTREAM_REPLICAS,
    };

    try {
      await manager.streams.info(env.NATS_JETSTREAM_STREAM_NAME);
    } catch {
      await manager.streams.add({
        name: env.NATS_JETSTREAM_STREAM_NAME,
        ...configuration,
      });
      return;
    }

    await manager.streams.update(env.NATS_JETSTREAM_STREAM_NAME, configuration);
  }

  private getJetStreamStorageType(): StorageType {
    return env.NATS_JETSTREAM_STORAGE === 'memory'
      ? StorageType.Memory
      : StorageType.File;
  }

  private getJetStreamClient(): JetStreamClient {
    if (!this.jetStreamClient) {
      throw new Error('JetStream client is not initialized. Call connect() first.');
    }

    return this.jetStreamClient;
  }

  private getJetStreamManager(): JetStreamManager {
    if (!this.jetStreamManager) {
      throw new Error('JetStream manager is not initialized. Call connect() first.');
    }

    return this.jetStreamManager;
  }

  private getCommandDeduplicator(): RedisCommandDeduplicator {
    if (!this.commandDeduplicator) {
      this.commandDeduplicator = new RedisCommandDeduplicator(
        RedisConnection.getCoordinationClient(),
      );
    }

    return this.commandDeduplicator;
  }

  private async publish(
    subject: string,
    payload: Uint8Array,
    messageId?: string,
  ): Promise<void> {
    if (env.NATS_MODE === 'jetstream') {
      if (messageId) {
        await this.getJetStreamClient().publish(subject, payload, { msgID: messageId });
      } else {
        await this.getJetStreamClient().publish(subject, payload);
      }
      return;
    }

    const client = await NatsConnection.getClient();
    client.publish(subject, payload);
  }

  private async handleWorkerCommandPayload(
    payload: unknown,
    handler: WorkerCommandHandler,
  ): Promise<BrokerMessageHandling> {
    try {
      const command = this.parseWorkerCommand(payload);
      return this.runDeduplicatedCommand(
        command.session,
        CommandKind.Worker,
        command.commandId,
        () => handler(command),
      );
    } catch (error) {
      console.error('[NATS] Invalid worker command payload. Acknowledging message.', error);
      return 'ack';
    }
  }

  private async handleOutgoingPayload(
    payload: unknown,
    handler: OutgoingHandler,
  ): Promise<BrokerMessageHandling> {
    try {
      const command = this.parseSendMessageCommand(payload);
      return this.runDeduplicatedCommand(
        command.session,
        CommandKind.Outbound,
        command.commandId,
        () => handler(command),
      );
    } catch (error) {
      console.error('[NATS] Invalid outbound command payload. Acknowledging message.', error);
      return 'ack';
    }
  }

  private async handleActivationPayload(
    payload: unknown,
    handler: ActivationHandler,
  ): Promise<BrokerMessageHandling> {
    if (!this.isActivationCommandPayload(payload)) {
      return 'ack';
    }

    try {
      const command = this.parseActivationCommand(payload);
      return this.runDeduplicatedCommand(
        command.session,
        CommandKind.Activation,
        command.activationId,
        () => handler(command),
      );
    } catch (error) {
      console.error('[NATS] Invalid activation command payload. Acknowledging message.', error);
      return 'ack';
    }
  }

  private async runDeduplicatedCommand(
    session: SessionReference,
    commandKind: CommandKind,
    identifier: string,
    handler: () => Promise<void>,
  ): Promise<BrokerMessageHandling> {
    const commandDeduplicator = this.getCommandDeduplicator();

    try {
      const claimStatus = await commandDeduplicator.begin(session, commandKind, identifier);

      if (claimStatus === CommandClaimStatus.Duplicate) {
        return 'ack';
      }

      if (claimStatus === CommandClaimStatus.InProgress) {
        return 'retry';
      }

      await handler();

      try {
        await commandDeduplicator.complete(session, commandKind, identifier);
      } catch (error) {
        console.error(
          `[NATS] Command ${identifier} completed but dedupe finalization failed. Acknowledging to avoid duplicate side effects.`,
          error,
        );
      }

      return 'ack';
    } catch (error) {
      try {
        await commandDeduplicator.abandon(session, commandKind, identifier);
      } catch (cleanupError) {
        console.error(
          `[NATS] Failed to abandon dedupe claim for ${identifier}. The command may stay blocked until TTL expiration.`,
          cleanupError,
        );
      }

      console.error(`[NATS] Failed while handling command ${identifier}:`, error);
      return 'retry';
    }
  }

  private serializeActivationEvent(event: ActivationEvent): Record<string, unknown> {
    const basePayload = {
      eventType: event.eventType,
      commandId: event.commandId,
      correlationId: event.correlationId,
      activationId: event.activationId,
      session: this.serializeSession(event.session),
      timestamp: event.timestamp,
    };

    if (event instanceof ActivationStartedEvent) {
      return {
        ...basePayload,
        mode: event.mode,
        phoneNumber: event.phoneNumber,
      };
    }

    if (event instanceof ActivationQrCodeUpdatedEvent) {
      return {
        ...basePayload,
        qrCode: event.qrCode,
        sequence: event.sequence,
        expiresAt: event.expiresAt,
      };
    }

    if (event instanceof ActivationPairingCodeUpdatedEvent) {
      return {
        ...basePayload,
        pairingCode: event.pairingCode,
        sequence: event.sequence,
        phoneNumber: event.phoneNumber,
        expiresAt: event.expiresAt,
      };
    }

    if (event instanceof ActivationCompletedEvent) {
      return {
        ...basePayload,
        mode: event.mode,
      };
    }

    if (event instanceof ActivationFailedEvent) {
      return {
        ...basePayload,
        reason: event.reason,
        retryable: event.retryable,
      };
    }

    if (event instanceof ActivationExpiredEvent) {
      return {
        ...basePayload,
        reason: event.reason,
      };
    }

    return {
      ...basePayload,
      reason: event.reason,
    };
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

  private parseActivationCommand(payload: unknown): ActivationCommand {
    const payloadRecord = this.requireRecord(payload, 'activation command');
    const action = parseActivationCommandAction(
      this.readRequiredString(payloadRecord, 'action', 'activation command'),
    );
    const rawMode = this.readOptionalString(payloadRecord, 'mode', 'activation command');
    const mode = rawMode ? parseActivationMode(rawMode) : undefined;

    return new ActivationCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'activation command'),
      this.readRequiredString(payloadRecord, 'correlationId', 'activation command'),
      this.readRequiredString(payloadRecord, 'activationId', 'activation command'),
      this.parseSession(payloadRecord.session, 'activation command session'),
      action,
      mode,
      this.readOptionalString(payloadRecord, 'phoneNumber', 'activation command'),
      this.readOptionalString(payloadRecord, 'customPairingCode', 'activation command'),
    );
  }

  private isActivationCommandPayload(payload: unknown): boolean {
    return this.isRecord(payload) && typeof payload.action === 'string';
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

  private buildWorkerConsumerName(workerId: string): string {
    return this.sanitizeConsumerName(`worker_${this.providerId}_${workerId}`);
  }

  private buildSessionConsumerName(
    rail: 'outgoing' | 'activation',
    session: SessionReference,
  ): string {
    return this.sanitizeConsumerName(
      `${rail}_${session.provider}_${session.workspaceId}_${session.sessionId}`,
    );
  }

  private sanitizeConsumerName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private buildActivationEventMessageId(event: ActivationEvent): string {
    const suffix = event instanceof ActivationQrCodeUpdatedEvent
      ? String(event.sequence)
      : event instanceof ActivationPairingCodeUpdatedEvent
        ? String(event.sequence)
        : event.timestamp;

    return this.sanitizeMessageId(
      `activation:${event.activationId}:${event.eventType}:${suffix}`,
    );
  }

  private buildInboundEventMessageId(event: InboundEvent): string {
    if (event instanceof ReceivedMessageEvent) {
      return this.sanitizeMessageId(
        `inbound:${event.session.toKey()}:${event.message.messageId ?? event.timestamp}:${event.eventType}`,
      );
    }

    if (event instanceof MessageUpdatedEvent) {
      return this.sanitizeMessageId(
        `inbound:${event.session.toKey()}:${event.messageId}:${event.eventType}:${event.timestamp}`,
      );
    }

    return this.sanitizeMessageId(
      `inbound:${event.session.toKey()}:${event.messageId ?? event.timestamp}:${event.eventType}:${event.timestamp}`,
    );
  }

  private buildDeliveryMessageId(event: DeliveryResult): string {
    return this.sanitizeMessageId(
      `delivery:${event.session.toKey()}:${event.commandId}:${event.status}:${event.providerMessageId ?? 'none'}`,
    );
  }

  private buildSessionStatusMessageId(event: SessionStatusEvent): string {
    return this.sanitizeMessageId(
      `status:${event.session.toKey()}:${event.status}:${event.timestamp}`,
    );
  }

  private sanitizeMessageId(value: string): string {
    return value.replace(/\s+/g, '_');
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

  private unsubscribe(subscription?: BrokerSubscription): void {
    subscription?.unsubscribe();
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

  private async consumeJetStream<T>(
    subscription: JetStreamSubscription,
    codec: Codec<T>,
    handler: (payload: T) => Promise<BrokerMessageHandling>,
    errorMessage: string,
  ): Promise<void> {
    for await (const message of subscription) {
      try {
        const payload = codec.decode(message.data);
        const handling = await handler(payload);

        if (handling === 'retry') {
          message.nak(1000);
        } else {
          message.ack();
        }
      } catch (error) {
        console.error(errorMessage, error);
        message.nak(1000);
      }
    }
  }
}
