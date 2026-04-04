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
import {
  BlockAction,
  CallCommand,
  CallCommandAction,
  CallType,
  ChatCommand,
  ChatCommandAction,
  CommandMessageKey,
  CommunityCommand,
  CommunityCommandAction,
  GroupCommand,
  GroupCommandAction,
  GroupJoinApprovalMode,
  GroupJoinRequestAction,
  GroupMemberAddMode,
  GroupSettingValue,
  MessageReceiptType,
  NewsletterCommand,
  NewsletterCommandAction,
  NewsletterLookupType,
  OnlinePrivacyValue,
  OutboundCommand,
  OutboundCommandFamily,
  parseBlockAction,
  parseCallCommandAction,
  parseCallType,
  parseChatCommandAction,
  parseCommunityCommandAction,
  parseGroupCommandAction,
  parseGroupJoinApprovalMode,
  parseGroupJoinRequestAction,
  parseGroupMemberAddMode,
  parseGroupSettingValue,
  parseMessageReceiptType,
  parseNewsletterCommandAction,
  parseNewsletterLookupType,
  parseOnlinePrivacyValue,
  parseOutboundCommandFamily,
  parseParticipantAction,
  parsePresenceCommandAction,
  parsePresenceType,
  parsePrivacyCommandAction,
  parsePrivacyValue,
  parseProfileCommandAction,
  parseProfilePictureType,
  parseGroupsAddPrivacyValue,
  parseReadCommandAction,
  parseReadReceiptsPrivacyValue,
  parseCallPrivacyValue,
  parseMessagesPrivacyValue,
  ParticipantAction,
  PresenceCommand,
  PresenceCommandAction,
  PresenceType,
  PrivacyCommand,
  PrivacyCommandAction,
  PrivacyValue,
  ProfileCommand,
  ProfileCommandAction,
  ProfilePictureType,
  GroupsAddPrivacyValue,
  ReadCommand,
  ReadCommandAction,
  ReadReceiptsPrivacyValue,
  CallPrivacyValue,
  MessagesPrivacyValue,
} from '../../domain/entities/command/OutboundCommand.js';
import {
  OutboundCommandResult,
  OutboundCommandResultStatus,
  parseOutboundCommandResultStatus,
} from '../../domain/entities/command/OutboundCommandResult.js';
import {DeliveryResult,} from '../../domain/entities/messaging/DeliveryResult.js';
import {
  InboundEvent,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageUpdatedEvent,
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
type CommandHandler = (command: OutboundCommand) => Promise<void>;
type BrokerSubscription = Subscription | JetStreamSubscription;
type BrokerMessageHandling = 'ack' | 'retry';

/**
 * NATS implementation of the worker transport contract.
 * It keeps the broker boundary explicit and rebuilds domain entities from wire payloads.
 */
export class NatsChannelTransport implements WorkerTransport {
  private readonly workerCommandCodec = JSONCodec<unknown>();
  private readonly commandCodec = JSONCodec<unknown>();
  private readonly activationCodec = JSONCodec<unknown>();
  private readonly inboundCodec = JSONCodec<unknown>();
  private readonly deliveryCodec = JSONCodec<unknown>();
  private readonly commandResultCodec = JSONCodec<unknown>();
  private readonly sessionStatusCodec = JSONCodec<unknown>();

  private workerSubscription?: BrokerSubscription;
  private readonly commandSubscriptions = new Map<string, BrokerSubscription[]>();
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

    for (const subscriptions of this.commandSubscriptions.values()) {
      for (const subscription of subscriptions) {
        this.unsubscribe(subscription);
      }
    }

    this.commandSubscriptions.clear();
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

  public async subscribeCommands(
    session: SessionReference,
    handler: CommandHandler,
  ): Promise<void> {
    const sessionKey = session.toKey();
    const subscriptions = this.commandSubscriptions.get(sessionKey);

    if (subscriptions) {
      for (const subscription of subscriptions) {
        this.unsubscribe(subscription);
      }
    }

    const registeredSubscriptions: BrokerSubscription[] = [];
    const client = env.NATS_MODE === 'jetstream'
      ? undefined
      : await NatsConnection.getClient();

    try {
      for (const family of Object.values(OutboundCommandFamily)) {
        const subject = NatsSubjectBuilder.getCommandSubject(session, family);

        if (env.NATS_MODE === 'jetstream') {
          const subscription = await this.subscribeJetStream(
            subject,
            this.buildCommandConsumerName(session, family),
          );
          registeredSubscriptions.push(subscription);

          void this.consumeJetStream(
            subscription,
            this.commandCodec,
            payload => this.handleCommandPayload(payload, handler),
            '[NATS] Failed to process command payload:',
          );
          continue;
        }

        const subscription = client!.subscribe(subject);
        registeredSubscriptions.push(subscription);

        void this.consume(
          subscription,
          this.commandCodec,
          payload => handler(this.parseOutboundCommand(payload)),
          '[NATS] Failed to process command payload:',
        );
      }
    } catch (error) {
      for (const subscription of registeredSubscriptions) {
        this.unsubscribe(subscription);
      }

      throw error;
    }

    this.commandSubscriptions.set(sessionKey, registeredSubscriptions);
  }

  public async disconnectSession(session: SessionReference): Promise<void> {
    const sessionKey = session.toKey();
    const subscriptions = this.commandSubscriptions.get(sessionKey);

    if (subscriptions) {
      for (const subscription of subscriptions) {
        this.unsubscribe(subscription);
      }
    }

    this.commandSubscriptions.delete(sessionKey);
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

  public async publishCommandResult(event: OutboundCommandResult): Promise<void> {
    const subject = NatsSubjectBuilder.getCommandResultSubject(event.session, event.family);
    await this.publish(
      subject,
      this.commandResultCodec.encode({
        commandId: event.commandId,
        session: this.serializeSession(event.session),
        family: event.family,
        action: event.action,
        status: event.status,
        timestamp: event.timestamp,
        reason: event.reason,
        data: event.data,
      }),
      this.buildCommandResultMessageId(event),
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

  private async handleCommandPayload(
    payload: unknown,
    handler: CommandHandler,
  ): Promise<BrokerMessageHandling> {
    try {
      const command = this.parseOutboundCommand(payload);
      return this.runDeduplicatedCommand(
        command.session,
        CommandKind.Outbound,
        command.commandId,
        () => handler(command),
      );
    } catch (error) {
      console.error('[NATS] Invalid command payload. Acknowledging message.', error);
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
    if (event instanceof MessageCreatedEvent) {
      return {
        eventType: event.eventType,
        session: this.serializeSession(event.session),
        timestamp: event.timestamp,
        message: this.serializeMessage(event.message),
        fromMe: event.fromMe,
      };
    }

    if (event instanceof MessageUpdatedEvent) {
      return {
        eventType: event.eventType,
        session: this.serializeSession(event.session),
        timestamp: event.timestamp,
        targetMessage: this.serializeMessageReference(event.targetMessage),
        chatId: event.chatId,
        senderId: event.senderId,
        fromMe: event.fromMe,
        updateKinds: event.updateKinds,
        message: event.message
          ? this.serializeMessage(event.message)
          : undefined,
        status: event.status,
        stubType: event.stubType,
        contentType: event.contentType,
        pollUpdateCount: event.pollUpdateCount,
        reactionText: event.reactionText,
        reactionRemoved: event.reactionRemoved,
      };
    }

    if (event instanceof MessageDeletedEvent) {
      return {
        eventType: event.eventType,
        session: this.serializeSession(event.session),
        timestamp: event.timestamp,
        targetMessage: this.serializeMessageReference(event.targetMessage),
        chatId: event.chatId,
        senderId: event.senderId,
        fromMe: event.fromMe,
        message: event.message
          ? this.serializeMessage(event.message)
          : undefined,
      };
    }

    throw new Error('Unsupported inbound event type.');
  }

  private parseWorkerCommand(payload: unknown): WorkerCommand {
    const payloadRecord = this.requireRecord(payload, 'worker command');
    return new WorkerCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'worker command'),
      parseWorkerCommandAction(this.readRequiredString(payloadRecord, 'action', 'worker command')),
      this.parseSession(payloadRecord.session, 'worker command session'),
    );
  }

  private parseOutboundCommand(payload: unknown): OutboundCommand {
    const payloadRecord = this.requireRecord(payload, 'command payload');

    switch (parseOutboundCommandFamily(this.readRequiredString(payloadRecord, 'family', 'command payload'))) {
      case OutboundCommandFamily.Message:
        return this.parseSendMessageCommand(payloadRecord);
      case OutboundCommandFamily.Presence:
        return this.parsePresenceCommand(payloadRecord);
      case OutboundCommandFamily.Read:
        return this.parseReadCommand(payloadRecord);
      case OutboundCommandFamily.Chat:
        return this.parseChatCommand(payloadRecord);
      case OutboundCommandFamily.Group:
        return this.parseGroupCommand(payloadRecord);
      case OutboundCommandFamily.Community:
        return this.parseCommunityCommand(payloadRecord);
      case OutboundCommandFamily.Newsletter:
        return this.parseNewsletterCommand(payloadRecord);
      case OutboundCommandFamily.Profile:
        return this.parseProfileCommand(payloadRecord);
      case OutboundCommandFamily.Privacy:
        return this.parsePrivacyCommand(payloadRecord);
      case OutboundCommandFamily.Call:
        return this.parseCallCommand(payloadRecord);
    }
  }

  private parseSendMessageCommand(payload: unknown): SendMessageCommand {
    const payloadRecord = this.requireRecord(payload, 'command payload');
    return new SendMessageCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      this.parseMessage(payloadRecord.message, 'command payload message'),
    );
  }

  private parsePresenceCommand(payloadRecord: Record<string, unknown>): PresenceCommand {
    const action = parsePresenceCommandAction(
      this.readRequiredString(payloadRecord, 'action', 'command payload'),
    );

    return new PresenceCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      action,
      this.readRequiredString(payloadRecord, 'chatId', 'command payload'),
      action === PresenceCommandAction.Update
        ? parsePresenceType(this.readRequiredString(payloadRecord, 'presence', 'command payload'))
        : undefined,
    );
  }

  private parseReadCommand(payloadRecord: Record<string, unknown>): ReadCommand {
    const action = parseReadCommandAction(
      this.readRequiredString(payloadRecord, 'action', 'command payload'),
    );

    return new ReadCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      action,
      action === ReadCommandAction.ReadMessages
        ? this.readOptionalArray(payloadRecord, 'messages', 'command payload')
          .map((entry, index) => this.parseCommandMessageKey(entry, `command payload messages[${index}]`))
        : [],
      this.readOptionalString(payloadRecord, 'chatId', 'command payload'),
      this.readOptionalString(payloadRecord, 'participantId', 'command payload'),
      this.readOptionalStringArray(payloadRecord, 'messageIds', 'command payload'),
      action === ReadCommandAction.SendReceipt
        ? parseMessageReceiptType(this.readRequiredString(payloadRecord, 'receiptType', 'command payload'))
        : undefined,
    );
  }

  private parseChatCommand(payloadRecord: Record<string, unknown>): ChatCommand {
    return new ChatCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      parseChatCommandAction(this.readRequiredString(payloadRecord, 'action', 'command payload')),
      this.readRequiredString(payloadRecord, 'chatId', 'command payload'),
      this.readOptionalArray(payloadRecord, 'lastMessages', 'command payload')
        .map((entry, index) => this.parseCommandMessageKey(entry, `command payload lastMessages[${index}]`)),
      payloadRecord.targetMessage == null
        ? undefined
        : this.parseCommandMessageKey(payloadRecord.targetMessage, 'command payload targetMessage'),
      this.readOptionalArray(payloadRecord, 'messageReferences', 'command payload')
        .map((entry, index) => this.parseCommandMessageKey(entry, `command payload messageReferences[${index}]`)),
      this.readOptionalNullableNumber(payloadRecord, 'muteDurationMs', 'command payload'),
      this.readOptionalBoolean(payloadRecord, 'deleteMedia', 'command payload'),
      this.readOptionalNumber(payloadRecord, 'deleteTimestamp', 'command payload'),
    );
  }

  private parseGroupCommand(payloadRecord: Record<string, unknown>): GroupCommand {
    return new GroupCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      parseGroupCommandAction(this.readRequiredString(payloadRecord, 'action', 'command payload')),
      this.readOptionalString(payloadRecord, 'groupJid', 'command payload'),
      this.readOptionalString(payloadRecord, 'subject', 'command payload'),
      this.readOptionalString(payloadRecord, 'description', 'command payload'),
      this.readOptionalStringArray(payloadRecord, 'participants', 'command payload'),
      payloadRecord.participantAction == null
        ? undefined
        : parseParticipantAction(
          this.readRequiredString(payloadRecord, 'participantAction', 'command payload'),
        ),
      payloadRecord.requestAction == null
        ? undefined
        : parseGroupJoinRequestAction(
          this.readRequiredString(payloadRecord, 'requestAction', 'command payload'),
        ),
      this.readOptionalString(payloadRecord, 'inviteCode', 'command payload'),
      this.readOptionalNumber(payloadRecord, 'ephemeralExpiration', 'command payload'),
      payloadRecord.setting == null
        ? undefined
        : parseGroupSettingValue(this.readRequiredString(payloadRecord, 'setting', 'command payload')),
      payloadRecord.memberAddMode == null
        ? undefined
        : parseGroupMemberAddMode(this.readRequiredString(payloadRecord, 'memberAddMode', 'command payload')),
      payloadRecord.joinApprovalMode == null
        ? undefined
        : parseGroupJoinApprovalMode(
          this.readRequiredString(payloadRecord, 'joinApprovalMode', 'command payload'),
        ),
    );
  }

  private parseCommunityCommand(payloadRecord: Record<string, unknown>): CommunityCommand {
    return new CommunityCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      parseCommunityCommandAction(this.readRequiredString(payloadRecord, 'action', 'command payload')),
      this.readOptionalString(payloadRecord, 'communityJid', 'command payload'),
      this.readOptionalString(payloadRecord, 'subject', 'command payload'),
      this.readOptionalString(payloadRecord, 'description', 'command payload'),
      this.readOptionalString(payloadRecord, 'groupJid', 'command payload'),
      this.readOptionalStringArray(payloadRecord, 'participants', 'command payload'),
      payloadRecord.participantAction == null
        ? undefined
        : parseParticipantAction(
          this.readRequiredString(payloadRecord, 'participantAction', 'command payload'),
        ),
      payloadRecord.requestAction == null
        ? undefined
        : parseGroupJoinRequestAction(
          this.readRequiredString(payloadRecord, 'requestAction', 'command payload'),
        ),
      this.readOptionalString(payloadRecord, 'inviteCode', 'command payload'),
      this.readOptionalNumber(payloadRecord, 'ephemeralExpiration', 'command payload'),
      payloadRecord.setting == null
        ? undefined
        : parseGroupSettingValue(this.readRequiredString(payloadRecord, 'setting', 'command payload')),
      payloadRecord.memberAddMode == null
        ? undefined
        : parseGroupMemberAddMode(this.readRequiredString(payloadRecord, 'memberAddMode', 'command payload')),
      payloadRecord.joinApprovalMode == null
        ? undefined
        : parseGroupJoinApprovalMode(
          this.readRequiredString(payloadRecord, 'joinApprovalMode', 'command payload'),
        ),
    );
  }

  private parseNewsletterCommand(payloadRecord: Record<string, unknown>): NewsletterCommand {
    return new NewsletterCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      parseNewsletterCommandAction(this.readRequiredString(payloadRecord, 'action', 'command payload')),
      this.readOptionalString(payloadRecord, 'newsletterJid', 'command payload'),
      this.readOptionalString(payloadRecord, 'name', 'command payload'),
      this.readOptionalString(payloadRecord, 'description', 'command payload'),
      this.readOptionalString(payloadRecord, 'pictureUrl', 'command payload'),
      payloadRecord.lookupType == null
        ? undefined
        : parseNewsletterLookupType(this.readRequiredString(payloadRecord, 'lookupType', 'command payload')),
      this.readOptionalString(payloadRecord, 'lookupKey', 'command payload'),
      this.readOptionalString(payloadRecord, 'serverId', 'command payload'),
      this.readOptionalString(payloadRecord, 'reactionText', 'command payload'),
      this.readOptionalNumber(payloadRecord, 'count', 'command payload'),
      this.readOptionalNumber(payloadRecord, 'since', 'command payload'),
      this.readOptionalNumber(payloadRecord, 'after', 'command payload'),
      this.readOptionalString(payloadRecord, 'newOwnerJid', 'command payload'),
      this.readOptionalString(payloadRecord, 'userJid', 'command payload'),
    );
  }

  private parseProfileCommand(payloadRecord: Record<string, unknown>): ProfileCommand {
    return new ProfileCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      parseProfileCommandAction(this.readRequiredString(payloadRecord, 'action', 'command payload')),
      this.readOptionalString(payloadRecord, 'jid', 'command payload'),
      payloadRecord.pictureType == null
        ? undefined
        : parseProfilePictureType(
          this.readRequiredString(payloadRecord, 'pictureType', 'command payload'),
        ),
      this.readOptionalString(payloadRecord, 'mediaUrl', 'command payload'),
      payloadRecord.dimensions == null
        ? undefined
        : this.parseMediaDimensions(payloadRecord.dimensions, 'command payload dimensions'),
      this.readOptionalString(payloadRecord, 'statusText', 'command payload'),
      this.readOptionalString(payloadRecord, 'profileName', 'command payload'),
      payloadRecord.blockAction == null
        ? undefined
        : parseBlockAction(this.readRequiredString(payloadRecord, 'blockAction', 'command payload')),
      this.readOptionalStringArray(payloadRecord, 'jids', 'command payload'),
    );
  }

  private parsePrivacyCommand(payloadRecord: Record<string, unknown>): PrivacyCommand {
    return new PrivacyCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      parsePrivacyCommandAction(this.readRequiredString(payloadRecord, 'action', 'command payload')),
      this.readOptionalBoolean(payloadRecord, 'previewsDisabled', 'command payload'),
      payloadRecord.callPrivacy == null
        ? undefined
        : parseCallPrivacyValue(this.readRequiredString(payloadRecord, 'callPrivacy', 'command payload')),
      payloadRecord.messagesPrivacy == null
        ? undefined
        : parseMessagesPrivacyValue(
          this.readRequiredString(payloadRecord, 'messagesPrivacy', 'command payload'),
        ),
      payloadRecord.lastSeenPrivacy == null
        ? undefined
        : parsePrivacyValue(
          this.readRequiredString(payloadRecord, 'lastSeenPrivacy', 'command payload'),
        ),
      payloadRecord.onlinePrivacy == null
        ? undefined
        : parseOnlinePrivacyValue(
          this.readRequiredString(payloadRecord, 'onlinePrivacy', 'command payload'),
        ),
      payloadRecord.profilePicturePrivacy == null
        ? undefined
        : parsePrivacyValue(
          this.readRequiredString(payloadRecord, 'profilePicturePrivacy', 'command payload'),
        ),
      payloadRecord.statusPrivacy == null
        ? undefined
        : parsePrivacyValue(
          this.readRequiredString(payloadRecord, 'statusPrivacy', 'command payload'),
        ),
      payloadRecord.readReceiptsPrivacy == null
        ? undefined
        : parseReadReceiptsPrivacyValue(
          this.readRequiredString(payloadRecord, 'readReceiptsPrivacy', 'command payload'),
        ),
      payloadRecord.groupsAddPrivacy == null
        ? undefined
        : parseGroupsAddPrivacyValue(
          this.readRequiredString(payloadRecord, 'groupsAddPrivacy', 'command payload'),
        ),
      this.readOptionalNumber(payloadRecord, 'defaultDisappearingModeSeconds', 'command payload'),
    );
  }

  private parseCallCommand(payloadRecord: Record<string, unknown>): CallCommand {
    return new CallCommand(
      this.readRequiredString(payloadRecord, 'commandId', 'command payload'),
      this.parseSession(payloadRecord.session, 'command payload session'),
      parseCallCommandAction(this.readRequiredString(payloadRecord, 'action', 'command payload')),
      this.readOptionalString(payloadRecord, 'callId', 'command payload'),
      this.readOptionalString(payloadRecord, 'callFrom', 'command payload'),
      payloadRecord.callType == null
        ? undefined
        : parseCallType(this.readRequiredString(payloadRecord, 'callType', 'command payload')),
      this.readOptionalNumber(payloadRecord, 'startTime', 'command payload'),
      this.readOptionalNumber(payloadRecord, 'timeoutMs', 'command payload'),
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

  private parseCommandMessageKey(payload: unknown, label: string): CommandMessageKey {
    const payloadRecord = this.requireRecord(payload, label);
    return new CommandMessageKey(
      this.parseMessageReference(payloadRecord.reference, `${label} reference`),
      this.readOptionalNumber(payloadRecord, 'timestamp', label),
      this.readOptionalBoolean(payloadRecord, 'fromMe', label),
    );
  }

  private serializeCommandMessageKey(messageKey: CommandMessageKey): Record<string, unknown> {
    return {
      reference: this.serializeMessageReference(messageKey.reference),
      timestamp: messageKey.timestamp,
      fromMe: messageKey.fromMe,
    };
  }

  private parseMediaDimensions(payload: unknown, label: string): { width: number; height: number } {
    const payloadRecord = this.requireRecord(payload, label);
    return {
      width: this.readRequiredNumber(payloadRecord, 'width', label),
      height: this.readRequiredNumber(payloadRecord, 'height', label),
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
      rawContext == null
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
      payloadRecord.quotedMessage == null
        ? undefined
        : this.parseQuotedMessage(payloadRecord.quotedMessage, `${label} quotedMessage`),
      payloadRecord.editTarget == null
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
          payloadRecord.location == null
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
          payloadRecord.durationSeconds == null
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
      payloadRecord.content == null
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
    rail: 'activation',
    session: SessionReference,
  ): string {
    return this.sanitizeConsumerName(
      `${rail}_${session.provider}_${session.workspaceId}_${session.sessionId}`,
    );
  }

  private buildCommandConsumerName(
    session: SessionReference,
    family: OutboundCommandFamily,
  ): string {
    return this.sanitizeConsumerName(
      `commands_${family}_${session.provider}_${session.workspaceId}_${session.sessionId}`,
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
    if (event instanceof MessageCreatedEvent) {
      return this.sanitizeMessageId(
        `inbound:${event.session.toKey()}:${event.message.messageId ?? event.timestamp}:${event.eventType}`,
      );
    }

    if (
      event instanceof MessageUpdatedEvent
      || event instanceof MessageDeletedEvent
    ) {
      return this.sanitizeMessageId(
        `inbound:${event.session.toKey()}:${event.targetMessage.messageId}:${event.eventType}:${event.timestamp}`,
      );
    }

    throw new Error('Unsupported inbound event type.');
  }

  private buildDeliveryMessageId(event: DeliveryResult): string {
    return this.sanitizeMessageId(
      `delivery:${event.session.toKey()}:${event.commandId}:${event.status}:${event.providerMessageId ?? 'none'}`,
    );
  }

  private buildCommandResultMessageId(event: OutboundCommandResult): string {
    return this.sanitizeMessageId(
      `command-results:${event.session.toKey()}:${event.commandId}:${event.family}:${event.action}:${event.status}`,
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

  private readOptionalNullableNumber(
    source: Record<string, unknown>,
    key: string,
    label: string,
  ): number | null | undefined {
    const value = source[key];
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
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
