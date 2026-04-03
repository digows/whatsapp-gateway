import {
  Codec,
  consumerOpts,
  DiscardPolicy,
  JetStreamClient,
  JetStreamManager,
  JetStreamSubscription,
  JSONCodec,
  nanos,
  RetentionPolicy,
  StorageType,
  Subscription,
} from 'nats';
import {env} from '../../application/config/env.js';
import {WorkerTransport} from '../../application/contracts/WorkerTransport.js';
import {
  ActivationCompletedEvent,
  ActivationEvent,
  ActivationExpiredEvent,
  ActivationFailedEvent,
  ActivationPairingCodeUpdatedEvent,
  ActivationQrCodeUpdatedEvent,
  ActivationStartedEvent,
} from '../../domain/entities/activation/ActivationEvent.js';
import {parseActivationMode} from '../../domain/entities/activation/ActivationMode.js';
import {DeliveryResult,} from '../../domain/entities/messaging/DeliveryResult.js';
import {
  InboundEvent,
  MessageUpdatedEvent,
  ReceivedMessageEvent,
} from '../../domain/entities/messaging/InboundEvent.js';
import {Message} from '../../domain/entities/messaging/Message.js';
import {
  AudioMessageContent,
  ButtonReplyMessageContent,
  ContactCard,
  ContactsMessageContent,
  DeleteMessageContent,
  DisappearingMessagesMessageContent,
  DocumentMessageContent,
  EventMessageContent,
  GroupInviteMessageContent,
  ImageMessageContent,
  InteractiveResponseMessageContent,
  LimitSharingMessageContent,
  ListReplyMessageContent,
  LocationMessageContent,
  MessageContent,
  OtherMessageContent,
  parseButtonReplyType,
  parseEventCallType,
  parsePinMessageAction,
  parsePinMessageDurationSeconds,
  PinMessageContent,
  PollMessageContent,
  PollOption,
  ProductMessageContent,
  ReactionMessageContent,
  RequestPhoneNumberMessageContent,
  SharePhoneNumberMessageContent,
  StickerMessageContent,
  TextMessageContent,
  VideoMessageContent,
} from '../../domain/entities/messaging/MessageContent.js';
import {parseMessageContentType} from '../../domain/entities/messaging/MessageContentType.js';
import {MessageReference} from '../../domain/entities/messaging/MessageReference.js';
import {QuotedMessage} from '../../domain/entities/messaging/QuotedMessage.js';
import {SendMessageCommand} from '../../domain/entities/messaging/SendMessageCommand.js';
import {MessageContext, parseChatType} from '../../domain/entities/messaging/MessageContext.js';
import {SessionReference} from '../../domain/entities/operational/SessionReference.js';
import {SessionStatusEvent} from '../../domain/entities/operational/SessionStatus.js';
import {parseWorkerCommandAction, WorkerCommand} from '../../domain/entities/operational/WorkerCommand.js';
import {NatsConnection} from './NatsConnection.js';
import {NatsSubjectBuilder} from './NatsSubjectBuilder.js';
import {CommandClaimStatus, CommandKind, RedisCommandDeduplicator,} from '../redis/RedisCommandDeduplicator.js';
import {RedisConnection} from '../redis/RedisConnection.js';

type WorkerCommandHandler = (command: WorkerCommand) => Promise<void>;
type OutgoingHandler = (command: SendMessageCommand) => Promise<void>;
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

    this.outboundSubscriptions.clear();
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

  public async publishWorkerCommand(command: WorkerCommand, workerId: string): Promise<void> {
    const subject = NatsSubjectBuilder.getWorkerControlSubject(this.providerId, workerId);
    await this.publish(
      subject,
      this.workerCommandCodec.encode({
        commandId: command.commandId,
        action: command.action,
        session: this.serializeSession(command.session),
      }),
      this.buildWorkerCommandMessageId(command, workerId),
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

  public async disconnectSession(session: SessionReference): Promise<void> {
    const sessionKey = session.toKey();
    this.unsubscribe(this.outboundSubscriptions.get(sessionKey));
    this.outboundSubscriptions.delete(sessionKey);
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
    options.deliverTo(this.buildJetStreamDeliverSubject(durableName));
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
            mentionedJids: message.context.mentionedJids,
            quotedMessage: message.context.quotedMessage
              ? this.serializeQuotedMessage(message.context.quotedMessage)
              : undefined,
            editTarget: message.context.editTarget
              ? this.serializeMessageReference(message.context.editTarget)
              : undefined,
            forwarded: message.context.forwarded,
            forwardingScore: message.context.forwardingScore,
            expirationSeconds: message.context.expirationSeconds,
            viewOnce: message.context.viewOnce,
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
      this.readOptionalStringArray(payloadRecord, 'mentionedJids', label),
      payloadRecord.quotedMessage === undefined
        ? undefined
        : this.parseQuotedMessage(payloadRecord.quotedMessage, `${label} quotedMessage`),
      payloadRecord.editTarget === undefined
        ? undefined
        : this.parseMessageReference(payloadRecord.editTarget, `${label} editTarget`),
      this.readOptionalBoolean(payloadRecord, 'forwarded', label) === true,
      this.readOptionalNumber(payloadRecord, 'forwardingScore', label),
      this.readOptionalNumber(payloadRecord, 'expirationSeconds', label),
      this.readOptionalBoolean(payloadRecord, 'viewOnce', label) === true,
    );
  }

  private parseMessageContent(payload: unknown, label: string): MessageContent {
    const payloadRecord = this.requireRecord(payload, label);
    const contentType = parseMessageContentType(
      this.readRequiredString(payloadRecord, 'type', label),
    );

    switch (contentType) {
      case 'text':
        return new TextMessageContent(
          this.readRequiredString(payloadRecord, 'text', label),
          this.readOptionalString(payloadRecord, 'matchedText', label),
          this.readOptionalString(payloadRecord, 'title', label),
          this.readOptionalString(payloadRecord, 'description', label),
        );
      case 'image':
        return new ImageMessageContent(
          this.readOptionalString(payloadRecord, 'caption', label),
          this.readOptionalString(payloadRecord, 'mediaUrl', label),
          this.readOptionalString(payloadRecord, 'mimeType', label),
          this.readOptionalNumber(payloadRecord, 'width', label),
          this.readOptionalNumber(payloadRecord, 'height', label),
        );
      case 'audio':
        return new AudioMessageContent(
          this.readOptionalString(payloadRecord, 'mediaUrl', label),
          this.readOptionalString(payloadRecord, 'mimeType', label),
          this.readOptionalNumber(payloadRecord, 'durationSeconds', label),
          this.readOptionalBoolean(payloadRecord, 'voiceNote', label) === true,
        );
      case 'video':
        return new VideoMessageContent(
          this.readOptionalString(payloadRecord, 'caption', label),
          this.readOptionalString(payloadRecord, 'mediaUrl', label),
          this.readOptionalString(payloadRecord, 'mimeType', label),
          this.readOptionalNumber(payloadRecord, 'width', label),
          this.readOptionalNumber(payloadRecord, 'height', label),
          this.readOptionalBoolean(payloadRecord, 'gifPlayback', label) === true,
          this.readOptionalBoolean(payloadRecord, 'videoNote', label) === true,
        );
      case 'document':
        return new DocumentMessageContent(
          this.readOptionalString(payloadRecord, 'caption', label),
          this.readOptionalString(payloadRecord, 'mediaUrl', label),
          this.readOptionalString(payloadRecord, 'fileName', label),
          this.readOptionalString(payloadRecord, 'mimeType', label),
        );
      case 'sticker':
        return new StickerMessageContent(
          this.readOptionalString(payloadRecord, 'mediaUrl', label),
          this.readOptionalString(payloadRecord, 'mimeType', label),
          this.readOptionalBoolean(payloadRecord, 'animated', label) === true,
          this.readOptionalNumber(payloadRecord, 'width', label),
          this.readOptionalNumber(payloadRecord, 'height', label),
        );
      case 'contacts':
        return new ContactsMessageContent(
          this.readOptionalArray(payloadRecord, 'contacts', label).map((entry, index) => {
            const contactRecord = this.requireRecord(entry, `${label} contacts[${index}]`);
            return new ContactCard(
              this.readOptionalString(contactRecord, 'displayName', `${label} contacts[${index}]`),
              this.readOptionalString(contactRecord, 'vcard', `${label} contacts[${index}]`),
            );
          }),
          this.readOptionalString(payloadRecord, 'displayName', label),
        );
      case 'location':
        return new LocationMessageContent(
          this.readRequiredNumber(payloadRecord, 'latitude', label),
          this.readRequiredNumber(payloadRecord, 'longitude', label),
          this.readOptionalString(payloadRecord, 'name', label),
          this.readOptionalString(payloadRecord, 'address', label),
          this.readOptionalString(payloadRecord, 'url', label),
          this.readOptionalString(payloadRecord, 'comment', label),
          this.readOptionalBoolean(payloadRecord, 'live', label) === true,
          this.readOptionalNumber(payloadRecord, 'accuracyInMeters', label),
          this.readOptionalNumber(payloadRecord, 'speedInMetersPerSecond', label),
          this.readOptionalNumber(payloadRecord, 'degreesClockwiseFromMagneticNorth', label),
          this.readOptionalNumber(payloadRecord, 'sequenceNumber', label),
          this.readOptionalNumber(payloadRecord, 'timeOffsetSeconds', label),
        );
      case 'reaction':
        return new ReactionMessageContent(
          this.parseMessageReference(payloadRecord.targetMessage, `${label} targetMessage`),
          this.readOptionalString(payloadRecord, 'reactionText', label),
          this.readOptionalBoolean(payloadRecord, 'removed', label) === true,
        );
      case 'poll':
        return new PollMessageContent(
          this.readRequiredString(payloadRecord, 'name', label),
          this.readOptionalArray(payloadRecord, 'options', label)
            .map((entry, index) => {
              const optionRecord = this.requireRecord(entry, `${label} options[${index}]`);
              return new PollOption(
                this.readRequiredString(optionRecord, 'name', `${label} options[${index}]`),
              );
            }),
          this.readOptionalNumber(payloadRecord, 'selectableCount', label) ?? 1,
        );
      case 'button_reply':
        return new ButtonReplyMessageContent(
          this.readRequiredString(payloadRecord, 'buttonId', label),
          this.readOptionalString(payloadRecord, 'displayText', label) ?? '',
          parseButtonReplyType(this.readRequiredString(payloadRecord, 'replyType', label)),
          this.readOptionalNumber(payloadRecord, 'buttonIndex', label),
        );
      case 'list_reply':
        return new ListReplyMessageContent(
          this.readRequiredString(payloadRecord, 'selectedRowId', label),
          this.readOptionalString(payloadRecord, 'title', label),
          this.readOptionalString(payloadRecord, 'description', label),
        );
      case 'group_invite':
        return new GroupInviteMessageContent(
          this.readRequiredString(payloadRecord, 'groupJid', label),
          this.readRequiredString(payloadRecord, 'inviteCode', label),
          this.readOptionalString(payloadRecord, 'groupName', label),
          this.readOptionalString(payloadRecord, 'caption', label),
          this.readOptionalNumber(payloadRecord, 'inviteExpiration', label),
        );
      case 'event':
        return new EventMessageContent(
          this.readRequiredString(payloadRecord, 'name', label),
          this.readOptionalNumber(payloadRecord, 'startTimestamp', label),
          this.readOptionalString(payloadRecord, 'description', label),
          this.readOptionalNumber(payloadRecord, 'endTimestamp', label),
          payloadRecord.location === undefined
            ? undefined
            : this.parseLocationMessageContent(payloadRecord.location, `${label} location`),
          this.readOptionalString(payloadRecord, 'joinLink', label),
          this.readOptionalString(payloadRecord, 'callType', label)
            ? parseEventCallType(this.readRequiredString(payloadRecord, 'callType', label))
            : undefined,
          this.readOptionalBoolean(payloadRecord, 'cancelled', label) === true,
          this.readOptionalBoolean(payloadRecord, 'scheduledCall', label) === true,
          this.readOptionalBoolean(payloadRecord, 'extraGuestsAllowed', label) === true,
          this.readOptionalBoolean(payloadRecord, 'hasReminder', label) === true,
          this.readOptionalNumber(payloadRecord, 'reminderOffsetSeconds', label),
        );
      case 'product':
        return new ProductMessageContent(
          this.readOptionalString(payloadRecord, 'productId', label),
          this.readOptionalString(payloadRecord, 'title', label),
          this.readOptionalString(payloadRecord, 'description', label),
          this.readOptionalString(payloadRecord, 'currencyCode', label),
          this.readOptionalNumber(payloadRecord, 'priceAmount1000', label),
          this.readOptionalString(payloadRecord, 'retailerId', label),
          this.readOptionalString(payloadRecord, 'url', label),
          this.readOptionalString(payloadRecord, 'productImageUrl', label),
          this.readOptionalString(payloadRecord, 'businessOwnerJid', label),
          this.readOptionalString(payloadRecord, 'body', label),
          this.readOptionalString(payloadRecord, 'footer', label),
          this.readOptionalString(payloadRecord, 'catalogTitle', label),
          this.readOptionalString(payloadRecord, 'catalogDescription', label),
        );
      case 'interactive_response':
        return new InteractiveResponseMessageContent(
          this.readOptionalString(payloadRecord, 'bodyText', label),
          this.readOptionalString(payloadRecord, 'flowName', label),
          this.readOptionalString(payloadRecord, 'parametersJson', label),
          this.readOptionalNumber(payloadRecord, 'version', label),
        );
      case 'request_phone_number':
        return new RequestPhoneNumberMessageContent();
      case 'share_phone_number':
        return new SharePhoneNumberMessageContent();
      case 'delete':
        return new DeleteMessageContent(
          this.parseMessageReference(payloadRecord.targetMessage, `${label} targetMessage`),
        );
      case 'pin':
        return new PinMessageContent(
          this.parseMessageReference(payloadRecord.targetMessage, `${label} targetMessage`),
          parsePinMessageAction(this.readRequiredString(payloadRecord, 'action', label)),
          payloadRecord.durationSeconds === undefined
            ? undefined
            : parsePinMessageDurationSeconds(
              this.readRequiredNumber(payloadRecord, 'durationSeconds', label),
            ),
        );
      case 'disappearing_messages':
        return new DisappearingMessagesMessageContent(
          this.readRequiredNumber(payloadRecord, 'expirationSeconds', label),
        );
      case 'limit_sharing':
        return new LimitSharingMessageContent(
          this.readRequiredBoolean(payloadRecord, 'sharingLimited', label),
          this.readOptionalNumber(payloadRecord, 'updatedTimestamp', label),
          this.readOptionalBoolean(payloadRecord, 'initiatedByMe', label),
        );
      case 'other':
        return new OtherMessageContent(this.readOptionalString(payloadRecord, 'description', label));
    }
  }

  private serializeMessageContent(content: MessageContent): Record<string, unknown> {
    if (content instanceof TextMessageContent) {
      return {
        type: content.type,
        text: content.text,
        matchedText: content.matchedText,
        title: content.title,
        description: content.description,
      };
    }

    if (content instanceof ImageMessageContent) {
      return {
        type: content.type,
        caption: content.caption,
        mediaUrl: content.mediaUrl,
        mimeType: content.mimeType,
        width: content.width,
        height: content.height,
      };
    }

    if (content instanceof AudioMessageContent) {
      return {
        type: content.type,
        mediaUrl: content.mediaUrl,
        mimeType: content.mimeType,
        durationSeconds: content.durationSeconds,
        voiceNote: content.voiceNote,
      };
    }

    if (content instanceof VideoMessageContent) {
      return {
        type: content.type,
        caption: content.caption,
        mediaUrl: content.mediaUrl,
        mimeType: content.mimeType,
        width: content.width,
        height: content.height,
        gifPlayback: content.gifPlayback,
        videoNote: content.videoNote,
      };
    }

    if (content instanceof DocumentMessageContent) {
      return {
        type: content.type,
        caption: content.caption,
        mediaUrl: content.mediaUrl,
        fileName: content.fileName,
        mimeType: content.mimeType,
      };
    }

    if (content instanceof StickerMessageContent) {
      return {
        type: content.type,
        mediaUrl: content.mediaUrl,
        mimeType: content.mimeType,
        animated: content.animated,
        width: content.width,
        height: content.height,
      };
    }

    if (content instanceof ContactsMessageContent) {
      return {
        type: content.type,
        displayName: content.displayName,
        contacts: content.contacts.map(contact => ({
          displayName: contact.displayName,
          vcard: contact.vcard,
        })),
      };
    }

    if (content instanceof LocationMessageContent) {
      return {
        type: content.type,
        latitude: content.latitude,
        longitude: content.longitude,
        name: content.name,
        address: content.address,
        url: content.url,
        comment: content.comment,
        live: content.live,
        accuracyInMeters: content.accuracyInMeters,
        speedInMetersPerSecond: content.speedInMetersPerSecond,
        degreesClockwiseFromMagneticNorth: content.degreesClockwiseFromMagneticNorth,
        sequenceNumber: content.sequenceNumber,
        timeOffsetSeconds: content.timeOffsetSeconds,
      };
    }

    if (content instanceof ReactionMessageContent) {
      return {
        type: content.type,
        targetMessage: this.serializeMessageReference(content.targetMessage),
        reactionText: content.reactionText,
        removed: content.removed,
      };
    }

    if (content instanceof PollMessageContent) {
      return {
        type: content.type,
        name: content.name,
        options: content.options.map(option => ({ name: option.name })),
        selectableCount: content.selectableCount,
      };
    }

    if (content instanceof ButtonReplyMessageContent) {
      return {
        type: content.type,
        buttonId: content.buttonId,
        displayText: content.displayText,
        replyType: content.replyType,
        buttonIndex: content.buttonIndex,
      };
    }

    if (content instanceof ListReplyMessageContent) {
      return {
        type: content.type,
        selectedRowId: content.selectedRowId,
        title: content.title,
        description: content.description,
      };
    }

    if (content instanceof GroupInviteMessageContent) {
      return {
        type: content.type,
        groupJid: content.groupJid,
        inviteCode: content.inviteCode,
        groupName: content.groupName,
        caption: content.caption,
        inviteExpiration: content.inviteExpiration,
      };
    }

    if (content instanceof EventMessageContent) {
      return {
        type: content.type,
        name: content.name,
        startTimestamp: content.startTimestamp,
        description: content.description,
        endTimestamp: content.endTimestamp,
        location: content.location
          ? this.serializeMessageContent(content.location)
          : undefined,
        joinLink: content.joinLink,
        callType: content.callType,
        cancelled: content.cancelled,
        scheduledCall: content.scheduledCall,
        extraGuestsAllowed: content.extraGuestsAllowed,
        hasReminder: content.hasReminder,
        reminderOffsetSeconds: content.reminderOffsetSeconds,
      };
    }

    if (content instanceof ProductMessageContent) {
      return {
        type: content.type,
        productId: content.productId,
        title: content.title,
        description: content.description,
        currencyCode: content.currencyCode,
        priceAmount1000: content.priceAmount1000,
        retailerId: content.retailerId,
        url: content.url,
        productImageUrl: content.productImageUrl,
        businessOwnerJid: content.businessOwnerJid,
        body: content.body,
        footer: content.footer,
        catalogTitle: content.catalogTitle,
        catalogDescription: content.catalogDescription,
      };
    }

    if (content instanceof InteractiveResponseMessageContent) {
      return {
        type: content.type,
        bodyText: content.bodyText,
        flowName: content.flowName,
        parametersJson: content.parametersJson,
        version: content.version,
      };
    }

    if (content instanceof RequestPhoneNumberMessageContent) {
      return { type: content.type };
    }

    if (content instanceof SharePhoneNumberMessageContent) {
      return { type: content.type };
    }

    if (content instanceof DeleteMessageContent) {
      return {
        type: content.type,
        targetMessage: this.serializeMessageReference(content.targetMessage),
      };
    }

    if (content instanceof PinMessageContent) {
      return {
        type: content.type,
        targetMessage: this.serializeMessageReference(content.targetMessage),
        action: content.action,
        durationSeconds: content.durationSeconds,
      };
    }

    if (content instanceof DisappearingMessagesMessageContent) {
      return {
        type: content.type,
        expirationSeconds: content.expirationSeconds,
      };
    }

    if (content instanceof LimitSharingMessageContent) {
      return {
        type: content.type,
        sharingLimited: content.sharingLimited,
        updatedTimestamp: content.updatedTimestamp,
        initiatedByMe: content.initiatedByMe,
      };
    }

    if (content instanceof OtherMessageContent) {
      return {
        type: content.type,
        description: content.description,
      };
    }

    throw new Error(`Unsupported message content type "${content.type}".`);
  }

  private parseLocationMessageContent(payload: unknown, label: string): LocationMessageContent {
    const payloadRecord = this.requireRecord(payload, label);
    return new LocationMessageContent(
      this.readRequiredNumber(payloadRecord, 'latitude', label),
      this.readRequiredNumber(payloadRecord, 'longitude', label),
      this.readOptionalString(payloadRecord, 'name', label),
      this.readOptionalString(payloadRecord, 'address', label),
      this.readOptionalString(payloadRecord, 'url', label),
      this.readOptionalString(payloadRecord, 'comment', label),
      this.readOptionalBoolean(payloadRecord, 'live', label) === true,
      this.readOptionalNumber(payloadRecord, 'accuracyInMeters', label),
      this.readOptionalNumber(payloadRecord, 'speedInMetersPerSecond', label),
      this.readOptionalNumber(payloadRecord, 'degreesClockwiseFromMagneticNorth', label),
      this.readOptionalNumber(payloadRecord, 'sequenceNumber', label),
      this.readOptionalNumber(payloadRecord, 'timeOffsetSeconds', label),
    );
  }

  private parseQuotedMessage(payload: unknown, label: string): QuotedMessage {
    const payloadRecord = this.requireRecord(payload, label);
    return new QuotedMessage(
      this.parseMessageReference(payloadRecord.reference, `${label} reference`),
      payloadRecord.content === undefined
        ? undefined
        : this.parseMessageContent(payloadRecord.content, `${label} content`),
    );
  }

  private serializeQuotedMessage(quotedMessage: QuotedMessage): Record<string, unknown> {
    return {
      reference: this.serializeMessageReference(quotedMessage.reference),
      content: quotedMessage.content
        ? this.serializeMessageContent(quotedMessage.content)
        : undefined,
    };
  }

  private parseMessageReference(payload: unknown, label: string): MessageReference {
    const payloadRecord = this.requireRecord(payload, label);
    return new MessageReference(
      this.readRequiredString(payloadRecord, 'messageId', label),
      this.readOptionalString(payloadRecord, 'remoteJid', label),
      this.readOptionalString(payloadRecord, 'participantId', label),
    );
  }

  private serializeMessageReference(messageReference: MessageReference): Record<string, unknown> {
    return {
      messageId: messageReference.messageId,
      remoteJid: messageReference.remoteJid,
      participantId: messageReference.participantId,
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

  private buildJetStreamDeliverSubject(durableName: string): string {
    return `_INBOX.gateway.${this.providerId}.${durableName}`;
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

  private buildWorkerCommandMessageId(command: WorkerCommand, workerId: string): string {
    return this.sanitizeMessageId(
      `worker-command:${workerId}:${command.session.toKey()}:${command.commandId}:${command.action}`,
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

  private readRequiredBoolean(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): boolean {
    const value = source[key];
    if (typeof value !== 'boolean') {
      throw new Error(`${label}.${key} must be a boolean.`);
    }

    return value;
  }

  private readOptionalNumber(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): number | undefined {
    const value = source[key];
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label}.${key} must be a finite number when provided.`);
    }

    return value;
  }

  private readOptionalBoolean(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): boolean | undefined {
    const value = source[key];
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value !== 'boolean') {
      throw new Error(`${label}.${key} must be a boolean when provided.`);
    }

    return value;
  }

  private readOptionalStringArray(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): string[] {
    const value = source[key];
    if (value === undefined || value === null) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error(`${label}.${key} must be an array of strings when provided.`);
    }

    return value.map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new Error(`${label}.${key}[${index}] must be a string.`);
      }

      return entry;
    });
  }

  private readOptionalArray(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): unknown[] {
    const value = source[key];
    if (value === undefined || value === null) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new Error(`${label}.${key} must be an array when provided.`);
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
