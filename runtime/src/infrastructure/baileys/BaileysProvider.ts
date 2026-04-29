import makeWASocket, {
  DisconnectReason,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
} from 'baileys';
import crypto from 'crypto';
import {
  ActivationCancelledEvent,
  ActivationCompletedEvent,
  ActivationEvent,
  ActivationFailedEvent,
  ActivationPairingCodeUpdatedEvent,
  ActivationQrCodeUpdatedEvent,
  ActivationStartedEvent,
} from '../../domain/entities/activation/ActivationEvent.js';
import { ActivationMode } from '../../domain/entities/activation/ActivationMode.js';
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
  NewsletterCommand,
  NewsletterCommandAction,
  NewsletterLookupType,
  OutboundCommand,
  PresenceCommand,
  PresenceCommandAction,
  PrivacyCommand,
  PrivacyCommandAction,
  ProfileCommand,
  ProfileCommandAction,
  ReadCommand,
  ReadCommandAction,
} from '../../domain/entities/command/OutboundCommand.js';
import {
  OutboundCommandResult,
  OutboundCommandResultStatus,
} from '../../domain/entities/command/OutboundCommandResult.js';
import { DeliveryResult, DeliveryStatus } from '../../domain/entities/messaging/DeliveryResult.js';
import {
  InboundEvent,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageUpdateKind,
  MessageUpdatedEvent,
} from '../../domain/entities/messaging/InboundEvent.js';
import { Message } from '../../domain/entities/messaging/Message.js';
import {
  AudioMessageContent,
  ButtonReplyMessageContent,
  ContactsMessageContent,
  DeleteMessageContent,
  DisappearingMessagesMessageContent,
  DocumentMessageContent,
  EventCallType,
  EventMessageContent,
  GroupInviteMessageContent,
  ImageMessageContent,
  InteractiveCarouselCardContent,
  InteractiveCarouselMessageContent,
  InteractiveCarouselNativeFlowMessageContent,
  InteractiveResponseMessageContent,
  LimitSharingMessageContent,
  ListReplyMessageContent,
  LocationMessageContent,
  MessageContent,
  OtherMessageContent,
  PinMessageAction,
  PinMessageContent,
  PollMessageContent,
  ProductMessageContent,
  ReactionMessageContent,
  RequestPhoneNumberMessageContent,
  SharePhoneNumberMessageContent,
  StickerMessageContent,
  TextMessageContent,
  VideoMessageContent,
} from '../../domain/entities/messaging/MessageContent.js';
import { MessageContentType } from '../../domain/entities/messaging/MessageContentType.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
import {
  SessionStatus,
  SessionStatusEvent,
} from '../../domain/entities/operational/SessionStatus.js';
import { MessageReference } from '../../domain/entities/messaging/MessageReference.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import qrcode from 'qrcode-terminal';
import { env } from '../../application/config/env.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { AntiBanService } from '../../domain/services/AntiBanService.js';
import { PgSignalKeyRepository } from '../pg/PgSignalKeyRepository.js';
import { RedisAntiBanWarmUpStateRepository } from '../redis/RedisAntiBanWarmUpStateRepository.js';
import { RedisConnection } from '../redis/RedisConnection.js';
import { RedisKeyBuilder } from '../redis/RedisKeyBuilder.js';
import { BaileysAuthenticationStateStore } from './BaileysAuthenticationStateStore.js';
import { createBaileysLogger } from './BaileysLogger.js';
import { BaileysMessageNormalizer } from './BaileysMessageNormalizer.js';

interface ActiveActivation {
  commandId: string;
  correlationId: string;
  activationId: string;
  mode: ActivationMode;
  phoneNumber?: string;
  qrSequence: number;
  pairingCodeSequence: number;
}

interface PendingActivationFirstResult {
  activationId: string;
  resolve: (event: ActivationEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Callback contract implemented by the host that owns one Baileys session instance.
 */
export interface BaileysProviderCallbacks {
  onActivationEvent(event: ActivationEvent): Promise<void>;
  onInboundEvent(event: InboundEvent): Promise<void>;
  onPersistedCredentialsChanged(
    hasPersistedCredentials: boolean,
    timestamp: string,
  ): Promise<void>;
  onSessionStatus(event: SessionStatusEvent): Promise<void>;
}

export interface OutboundExecutionOutcome {
  readonly commandResult: OutboundCommandResult;
  readonly deliveryResult?: DeliveryResult;
}

type InteractiveCarouselHeaderMediaBuilder = (
  recipientJid: string,
  headerMedia: MessageContent,
) => Promise<Record<string, unknown> | undefined>;

/**
 * Single-session Baileys runtime.
 * It owns the WhatsApp socket, auth state, message normalization and anti-ban behavior.
 */
export class BaileysProvider {
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private isStopping = false;
  private isConnected = false;
  private readonly loggedCiphertextIssues = new Set<string>();
  private activeActivation?: ActiveActivation;
  private latestQrCode?: string;
  private pendingActivationFirstResult?: PendingActivationFirstResult;

  private readonly proxyAgent?: HttpsProxyAgent<string>;
  private readonly antiBan: AntiBanService;
  private readonly authenticationStateStore: BaileysAuthenticationStateStore;

  constructor(
    private readonly session: SessionReference,
    private readonly callbacks: BaileysProviderCallbacks,
  ) {
    const proxyUrl = env.RESIDENTIAL_PROXY_URL;
    if (proxyUrl) {
      console.log('[PROXY] Routing provider traffic via residential proxy');
      this.proxyAgent = new HttpsProxyAgent(proxyUrl);
    } else {
      console.log('[PROXY] No residential proxy configured. Running via local IP.');
    }

    this.authenticationStateStore = new BaileysAuthenticationStateStore(
      this.session,
      new PgSignalKeyRepository(),
      RedisConnection.getClient(),
      {
        onPersistedCredentialsChanged: async (hasPersistedCredentials, timestamp) => {
          await this.callbacks.onPersistedCredentialsChanged(
            hasPersistedCredentials,
            timestamp,
          );
        },
      },
    );
    this.antiBan = new AntiBanService(
      this.session,
      new RedisAntiBanWarmUpStateRepository(RedisConnection.getClient()),
    );
  }

  public async start(): Promise<void> {
    this.isStopping = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.sock) {
      return;
    }

    const { state, saveCreds } = await this.authenticationStateStore.getAuthenticationState();

    this.sock = makeWASocket({
      auth: state,
      agent: this.proxyAgent,
      fetchAgent: this.proxyAgent,
      logger: createBaileysLogger(),
      syncFullHistory: false,
    });

    this.setupEventListeners(saveCreds);
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    this.isConnected = false;

    if (this.activeActivation) {
      await this.publishActivationCancelled(this.activeActivation, 'session_stopped');
      this.activeActivation = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.sock) {
      this.sock.end(new Error('Intentional Shutdown'));
      this.sock = null;
    }
  }

  public async requestQrCodeActivation(waitTimeoutMs = 30000): Promise<ActivationEvent> {
    return this.requestActivation(
      this.createActiveActivation(
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        ActivationMode.QrCode,
      ),
      waitTimeoutMs,
    );
  }

  public async requestPairingCodeActivation(
    phoneNumber: string,
    customPairingCode?: string,
    waitTimeoutMs = 30000,
  ): Promise<ActivationEvent> {
    if (!phoneNumber.trim()) {
      throw new Error('Pairing code activation requires a non-empty phoneNumber.');
    }

    return this.requestActivation(
      this.createActiveActivation(
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        ActivationMode.PairingCode,
        phoneNumber,
      ),
      waitTimeoutMs,
      customPairingCode,
    );
  }

  public async execute(command: OutboundCommand): Promise<OutboundExecutionOutcome> {
    if (command instanceof SendMessageCommand) {
      const deliveryResult = await this.send(command);
      return {
        commandResult: this.buildCommandResultFromDelivery(command, deliveryResult),
        deliveryResult,
      };
    }

    if (command instanceof PresenceCommand) {
      return {
        commandResult: await this.executePresenceCommand(command),
      };
    }

    if (command instanceof ReadCommand) {
      return {
        commandResult: await this.executeReadCommand(command),
      };
    }

    if (command instanceof ChatCommand) {
      return {
        commandResult: await this.executeChatCommand(command),
      };
    }

    if (command instanceof GroupCommand) {
      return {
        commandResult: await this.executeGroupCommand(command),
      };
    }

    if (command instanceof CommunityCommand) {
      return {
        commandResult: await this.executeCommunityCommand(command),
      };
    }

    if (command instanceof NewsletterCommand) {
      return {
        commandResult: await this.executeNewsletterCommand(command),
      };
    }

    if (command instanceof ProfileCommand) {
      return {
        commandResult: await this.executeProfileCommand(command),
      };
    }

    if (command instanceof PrivacyCommand) {
      return {
        commandResult: await this.executePrivacyCommand(command),
      };
    }

    if (command instanceof CallCommand) {
      return {
        commandResult: await this.executeCallCommand(command),
      };
    }

    throw new Error(`Unsupported outbound command family "${command.family}".`);
  }

  public async send(command: SendMessageCommand): Promise<DeliveryResult> {
    if (!this.sock) {
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Failed,
        undefined,
        'no active socket',
      );
    }

    const recipientJid = this.normalizeRecipientId(command.message.chatId);
    const decision = await this.antiBan.beforeSend(recipientJid, command.message.content);
    if (!decision.allowed) {
      console.warn(`[ANTIBAN] Outbound message blocked for ${recipientJid}: ${decision.reason}`);
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Blocked,
        undefined,
        decision.reason,
      );
    }

    const isGroup = recipientJid.endsWith('@g.us');
    await this.sleep(decision.preSendDelayMs);

    if (decision.content instanceof InteractiveCarouselMessageContent) {
      try {
        const messageId = await this.sendInteractiveCarousel(recipientJid, decision.content);
        await this.antiBan.afterSend(recipientJid, decision.content, decision.trackingKey);
        return this.buildDeliveryResult(
          command,
          DeliveryStatus.Sent,
          messageId,
        );
      } catch (error) {
        this.antiBan.afterSendFailed(error);
        return this.buildDeliveryResult(
          command,
          DeliveryStatus.Failed,
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (decision.content instanceof TextMessageContent && !isGroup) {
      await this.sock.presenceSubscribe(recipientJid).catch(() => {});
      await this.sock.sendPresenceUpdate('composing', recipientJid).catch(() => {});
    }

    await this.sleep(decision.typingDelayMs);

    try {
      const response = await this.sock.sendMessage(
        recipientJid,
        this.toBaileysContent(command.message),
      );
      await this.antiBan.afterSend(recipientJid, decision.content, decision.trackingKey);
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Sent,
        response?.key?.id ?? undefined,
      );
    } catch (error) {
      this.antiBan.afterSendFailed(error);
      return this.buildDeliveryResult(
        command,
        DeliveryStatus.Failed,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (decision.content instanceof TextMessageContent && !isGroup && this.sock) {
        await this.sock.sendPresenceUpdate('paused', recipientJid).catch(() => {});
      }
    }
  }

  private async sendInteractiveCarousel(
    recipientJid: string,
    content: InteractiveCarouselMessageContent,
  ): Promise<string> {
    if (!this.sock) {
      throw new Error('no active socket');
    }

    const waMessage = await this.buildInteractiveCarouselWAMessage(recipientJid, content);
    await this.sock.relayMessage(recipientJid, waMessage.message, {
      messageId: waMessage.key.id,
    });

    return waMessage.key.id;
  }

  private async buildInteractiveCarouselWAMessage(
    recipientJid: string,
    content: InteractiveCarouselMessageContent,
    headerMediaBuilder?: InteractiveCarouselHeaderMediaBuilder,
  ): Promise<ReturnType<typeof generateWAMessageFromContent>> {
    const resolvedHeaderMediaBuilder = headerMediaBuilder
      ?? ((jid: string, headerMedia: MessageContent) => this.buildInteractiveCarouselHeaderMedia(jid, headerMedia));

    const cards = await Promise.all(
      content.cards.map(card => this.buildInteractiveCarouselCard(recipientJid, card, resolvedHeaderMediaBuilder)),
    );

    return generateWAMessageFromContent(
      recipientJid,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
            interactiveMessage: proto.Message.InteractiveMessage.create({
              body: content.bodyText
                ? proto.Message.InteractiveMessage.Body.create({
                    text: content.bodyText,
                  })
                : undefined,
              footer: content.footerText
                ? proto.Message.InteractiveMessage.Footer.create({
                    text: content.footerText,
                  })
                : undefined,
              carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({
                messageVersion: content.messageVersion,
                carouselCardType: proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType.HSCROLL_CARDS,
                cards,
              }),
            }),
          },
        },
      },
      {
        userJid: this.sock?.user?.id ?? recipientJid,
      },
    );
  }

  private async buildInteractiveCarouselCard(
    recipientJid: string,
    card: InteractiveCarouselCardContent,
    headerMediaBuilder: InteractiveCarouselHeaderMediaBuilder,
  ): Promise<proto.Message.IInteractiveMessage> {
    const headerMedia = card.headerMedia
      ? await headerMediaBuilder(recipientJid, card.headerMedia)
      : undefined;

    return proto.Message.InteractiveMessage.create({
      header: proto.Message.InteractiveMessage.Header.create({
        title: card.headerTitle,
        subtitle: card.headerSubtitle,
        hasMediaAttachment: headerMedia != null,
        ...(headerMedia ?? {}),
      }),
      body: card.bodyText
        ? proto.Message.InteractiveMessage.Body.create({
            text: card.bodyText,
          })
        : undefined,
      footer: card.footerText
        ? proto.Message.InteractiveMessage.Footer.create({
            text: card.footerText,
          })
        : undefined,
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: card.nativeFlowMessage.buttons.map(button =>
          proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
            name: button.name,
            buttonParamsJson: button.buttonParamsJson,
          }),
        ),
        messageParamsJson: card.nativeFlowMessage.messageParamsJson,
        messageVersion: card.nativeFlowMessage.messageVersion,
      }),
    });
  }

  private async buildInteractiveCarouselHeaderMedia(
    recipientJid: string,
    headerMedia: MessageContent,
  ): Promise<Record<string, unknown>> {
    if (!this.sock) {
      throw new Error('no active socket');
    }

    if (headerMedia instanceof ImageMessageContent) {
      if (!headerMedia.mediaUrl) {
        throw new Error('interactive carousel image header requires mediaUrl');
      }

      return {
        imageMessage: await this.prepareInteractiveCarouselMediaMessage(
          recipientJid,
          {
            image: { url: headerMedia.mediaUrl },
          },
        ),
      };
    }

    if (headerMedia instanceof VideoMessageContent) {
      if (!headerMedia.mediaUrl) {
        throw new Error('interactive carousel video header requires mediaUrl');
      }

      return {
        videoMessage: await this.prepareInteractiveCarouselMediaMessage(
          recipientJid,
          {
            video: { url: headerMedia.mediaUrl },
            mimetype: headerMedia.mimeType,
            gifPlayback: headerMedia.gifPlayback,
            ptv: headerMedia.videoNote,
          },
        ),
      };
    }

    if (headerMedia instanceof DocumentMessageContent) {
      if (!headerMedia.mediaUrl) {
        throw new Error('interactive carousel document header requires mediaUrl');
      }

      return {
        documentMessage: await this.prepareInteractiveCarouselMediaMessage(
          recipientJid,
          {
            document: { url: headerMedia.mediaUrl },
            mimetype: headerMedia.mimeType ?? 'application/octet-stream',
            fileName: headerMedia.fileName ?? headerMedia.caption ?? 'document',
          },
        ),
      };
    }

    if (headerMedia instanceof LocationMessageContent) {
      return {
        locationMessage: {
          degreesLatitude: headerMedia.latitude,
          degreesLongitude: headerMedia.longitude,
          name: headerMedia.name,
          address: headerMedia.address,
          url: headerMedia.url,
          comment: headerMedia.comment,
          isLive: headerMedia.live,
          accuracyInMeters: headerMedia.accuracyInMeters,
          speedInMps: headerMedia.speedInMetersPerSecond,
          degreesClockwiseFromMagneticNorth: headerMedia.degreesClockwiseFromMagneticNorth,
          sequenceNumber: headerMedia.sequenceNumber,
          timeOffset: headerMedia.timeOffsetSeconds,
        },
      };
    }

    if (headerMedia instanceof ProductMessageContent) {
      if (!headerMedia.productImageUrl) {
        throw new Error('interactive carousel product header requires productImageUrl');
      }

      const productImage = await this.prepareInteractiveCarouselMediaMessage(
        recipientJid,
        {
          image: { url: headerMedia.productImageUrl },
        },
      );

      return {
        productMessage: {
          product: {
            productImage,
            productId: headerMedia.productId,
            title: headerMedia.title,
            description: headerMedia.description,
            currencyCode: headerMedia.currencyCode,
            priceAmount1000: headerMedia.priceAmount1000,
            retailerId: headerMedia.retailerId,
            url: headerMedia.url,
          },
          businessOwnerJid: headerMedia.businessOwnerJid,
          body: headerMedia.body,
          footer: headerMedia.footer,
          catalog: headerMedia.catalogTitle || headerMedia.catalogDescription
            ? {
                title: headerMedia.catalogTitle,
                description: headerMedia.catalogDescription,
                catalogImage: productImage,
              }
            : undefined,
        },
      };
    }

    throw new Error(`Unsupported interactive carousel header media type: ${headerMedia.type}`);
  }

  private async prepareInteractiveCarouselMediaMessage(
    recipientJid: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const prepared = await prepareWAMessageMedia(content as any, {
      upload: this.sock!.waUploadToServer,
      jid: recipientJid,
    });

    const preparedRecord = prepared as unknown as Record<string, unknown>;
    const [messageType] = Object.keys(preparedRecord);
    const message = preparedRecord[messageType];

    if (!message) {
      throw new Error('Unable to prepare interactive carousel header media.');
    }

    return message as Record<string, unknown>;
  }

  private async executePresenceCommand(command: PresenceCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    const chatJid = this.normalizeRecipientId(command.chatId);

    try {
      if (command.action === PresenceCommandAction.Subscribe) {
        await this.sock.presenceSubscribe(chatJid);
        return this.buildSucceededCommandResult(command, {
          chatId: chatJid,
        });
      }

      await this.sock.sendPresenceUpdate(command.presence!, chatJid);
      return this.buildSucceededCommandResult(command, {
        chatId: chatJid,
        presence: command.presence,
      });
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeReadCommand(command: ReadCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    try {
      if (command.action === ReadCommandAction.ReadMessages) {
        await this.sock.readMessages(
          command.messages.map(message => this.toBaileysMessageKey(message)),
        );

        return this.buildSucceededCommandResult(command, {
          messageCount: command.messages.length,
        });
      }

      const chatJid = this.normalizeRecipientId(command.chatId!);
      await this.sock.sendReceipt(
        chatJid,
        command.participantId,
        [...command.messageIds],
        command.receiptType,
      );

      return this.buildSucceededCommandResult(command, {
        chatId: chatJid,
        participantId: command.participantId,
        messageCount: command.messageIds.length,
        receiptType: command.receiptType,
      });
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeChatCommand(command: ChatCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    const chatJid = this.normalizeRecipientId(command.chatId);

    try {
      switch (command.action) {
        case ChatCommandAction.Archive:
          await this.sock.chatModify(
            {
              archive: true,
              lastMessages: this.toMinimalMessages(command.lastMessages, 'chat archive'),
            },
            chatJid,
          );
          break;
        case ChatCommandAction.Unarchive:
          await this.sock.chatModify(
            {
              archive: false,
              lastMessages: this.toMinimalMessages(command.lastMessages, 'chat unarchive'),
            },
            chatJid,
          );
          break;
        case ChatCommandAction.Pin:
          await this.sock.chatModify({ pin: true }, chatJid);
          break;
        case ChatCommandAction.Unpin:
          await this.sock.chatModify({ pin: false }, chatJid);
          break;
        case ChatCommandAction.Mute:
          await this.sock.chatModify({ mute: command.muteDurationMs ?? 0 }, chatJid);
          break;
        case ChatCommandAction.Unmute:
          await this.sock.chatModify({ mute: null }, chatJid);
          break;
        case ChatCommandAction.Clear:
          await this.sock.chatModify(
            {
              clear: true,
              lastMessages: this.toMinimalMessages(command.lastMessages, 'chat clear'),
            },
            chatJid,
          );
          break;
        case ChatCommandAction.DeleteForMe:
          await this.sock.chatModify(
            {
              deleteForMe: {
                deleteMedia: command.deleteMedia === true,
                key: this.toBaileysMessageKey(command.targetMessage!),
                timestamp: command.deleteTimestamp!,
              },
            },
            chatJid,
          );
          break;
        case ChatCommandAction.DeleteChat:
          await this.sock.chatModify(
            {
              delete: true,
              lastMessages: this.toMinimalMessages(command.lastMessages, 'chat delete'),
            },
            chatJid,
          );
          break;
        case ChatCommandAction.MarkRead:
          await this.sock.chatModify(
            {
              markRead: true,
              lastMessages: this.toMinimalMessages(command.lastMessages, 'chat markRead'),
            },
            chatJid,
          );
          break;
        case ChatCommandAction.MarkUnread:
          await this.sock.chatModify(
            {
              markRead: false,
              lastMessages: this.toMinimalMessages(command.lastMessages, 'chat markUnread'),
            },
            chatJid,
          );
          break;
        case ChatCommandAction.Star:
          await this.sock.star(
            chatJid,
            command.messageReferences.map(message => ({
              id: message.reference.messageId,
              fromMe: message.fromMe,
            })),
            true,
          );
          break;
        case ChatCommandAction.Unstar:
          await this.sock.star(
            chatJid,
            command.messageReferences.map(message => ({
              id: message.reference.messageId,
              fromMe: message.fromMe,
            })),
            false,
          );
          break;
      }

      return this.buildSucceededCommandResult(command, {
        chatId: chatJid,
      });
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeGroupCommand(command: GroupCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    try {
      switch (command.action) {
        case GroupCommandAction.Metadata:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.groupMetadata(this.normalizeRecipientId(command.groupJid!)),
          });
        case GroupCommandAction.Create:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.groupCreate(command.subject!, [...command.participants]),
          });
        case GroupCommandAction.Leave:
          await this.sock.groupLeave(this.normalizeRecipientId(command.groupJid!));
          break;
        case GroupCommandAction.UpdateSubject:
          await this.sock.groupUpdateSubject(
            this.normalizeRecipientId(command.groupJid!),
            command.subject!,
          );
          break;
        case GroupCommandAction.UpdateDescription:
          await this.sock.groupUpdateDescription(
            this.normalizeRecipientId(command.groupJid!),
            command.description,
          );
          break;
        case GroupCommandAction.InviteCode:
          return this.buildSucceededCommandResult(command, {
            inviteCode: await this.sock.groupInviteCode(this.normalizeRecipientId(command.groupJid!)),
          });
        case GroupCommandAction.RevokeInvite:
          return this.buildSucceededCommandResult(command, {
            inviteCode: await this.sock.groupRevokeInvite(this.normalizeRecipientId(command.groupJid!)),
          });
        case GroupCommandAction.AcceptInvite:
          return this.buildSucceededCommandResult(command, {
            groupJid: await this.sock.groupAcceptInvite(command.inviteCode!),
          });
        case GroupCommandAction.GetInviteInfo:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.groupGetInviteInfo(command.inviteCode!),
          });
        case GroupCommandAction.ParticipantsUpdate:
          return this.buildSucceededCommandResult(command, {
            participants: await this.sock.groupParticipantsUpdate(
              this.normalizeRecipientId(command.groupJid!),
              [...command.participants],
              command.participantAction!,
            ),
          });
        case GroupCommandAction.RequestParticipantsList:
          return this.buildSucceededCommandResult(command, {
            participants: await this.sock.groupRequestParticipantsList(
              this.normalizeRecipientId(command.groupJid!),
            ),
          });
        case GroupCommandAction.RequestParticipantsUpdate:
          return this.buildSucceededCommandResult(command, {
            participants: await this.sock.groupRequestParticipantsUpdate(
              this.normalizeRecipientId(command.groupJid!),
              [...command.participants],
              command.requestAction!,
            ),
          });
        case GroupCommandAction.ToggleEphemeral:
          await this.sock.groupToggleEphemeral(
            this.normalizeRecipientId(command.groupJid!),
            command.ephemeralExpiration!,
          );
          break;
        case GroupCommandAction.SettingUpdate:
          await this.sock.groupSettingUpdate(
            this.normalizeRecipientId(command.groupJid!),
            command.setting!,
          );
          break;
        case GroupCommandAction.MemberAddMode:
          await this.sock.groupMemberAddMode(
            this.normalizeRecipientId(command.groupJid!),
            command.memberAddMode!,
          );
          break;
        case GroupCommandAction.JoinApprovalMode:
          await this.sock.groupJoinApprovalMode(
            this.normalizeRecipientId(command.groupJid!),
            command.joinApprovalMode!,
          );
          break;
        case GroupCommandAction.FetchAllParticipating:
          return this.buildSucceededCommandResult(command, {
            groups: await this.sock.groupFetchAllParticipating(),
          });
      }

      return this.buildSucceededCommandResult(command);
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeCommunityCommand(command: CommunityCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    try {
      switch (command.action) {
        case CommunityCommandAction.Metadata:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.communityMetadata(this.normalizeRecipientId(command.communityJid!)),
          });
        case CommunityCommandAction.Create:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.communityCreate(command.subject!, command.description ?? ''),
          });
        case CommunityCommandAction.CreateGroup:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.communityCreateGroup(
              command.subject!,
              [...command.participants],
              this.normalizeRecipientId(command.communityJid!),
            ),
          });
        case CommunityCommandAction.Leave:
          await this.sock.communityLeave(this.normalizeRecipientId(command.communityJid!));
          break;
        case CommunityCommandAction.UpdateSubject:
          await this.sock.communityUpdateSubject(
            this.normalizeRecipientId(command.communityJid!),
            command.subject!,
          );
          break;
        case CommunityCommandAction.UpdateDescription:
          await this.sock.communityUpdateDescription(
            this.normalizeRecipientId(command.communityJid!),
            command.description,
          );
          break;
        case CommunityCommandAction.LinkGroup:
          await this.sock.communityLinkGroup(
            this.normalizeRecipientId(command.groupJid!),
            this.normalizeRecipientId(command.communityJid!),
          );
          break;
        case CommunityCommandAction.UnlinkGroup:
          await this.sock.communityUnlinkGroup(
            this.normalizeRecipientId(command.groupJid!),
            this.normalizeRecipientId(command.communityJid!),
          );
          break;
        case CommunityCommandAction.FetchLinkedGroups:
          return this.buildSucceededCommandResult(command, {
            groups: await this.sock.communityFetchLinkedGroups(
              this.normalizeRecipientId(command.communityJid!),
            ),
          });
        case CommunityCommandAction.RequestParticipantsList:
          return this.buildSucceededCommandResult(command, {
            participants: await this.sock.communityRequestParticipantsList(
              this.normalizeRecipientId(command.communityJid!),
            ),
          });
        case CommunityCommandAction.RequestParticipantsUpdate:
          return this.buildSucceededCommandResult(command, {
            participants: await this.sock.communityRequestParticipantsUpdate(
              this.normalizeRecipientId(command.communityJid!),
              [...command.participants],
              command.requestAction!,
            ),
          });
        case CommunityCommandAction.ParticipantsUpdate:
          return this.buildSucceededCommandResult(command, {
            participants: await this.sock.communityParticipantsUpdate(
              this.normalizeRecipientId(command.communityJid!),
              [...command.participants],
              command.participantAction!,
            ),
          });
        case CommunityCommandAction.InviteCode:
          return this.buildSucceededCommandResult(command, {
            inviteCode: await this.sock.communityInviteCode(this.normalizeRecipientId(command.communityJid!)),
          });
        case CommunityCommandAction.RevokeInvite:
          return this.buildSucceededCommandResult(command, {
            inviteCode: await this.sock.communityRevokeInvite(this.normalizeRecipientId(command.communityJid!)),
          });
        case CommunityCommandAction.AcceptInvite:
          return this.buildSucceededCommandResult(command, {
            communityJid: await this.sock.communityAcceptInvite(command.inviteCode!),
          });
        case CommunityCommandAction.GetInviteInfo:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.communityGetInviteInfo(command.inviteCode!),
          });
        case CommunityCommandAction.ToggleEphemeral:
          await this.sock.communityToggleEphemeral(
            this.normalizeRecipientId(command.communityJid!),
            command.ephemeralExpiration!,
          );
          break;
        case CommunityCommandAction.SettingUpdate:
          await this.sock.communitySettingUpdate(
            this.normalizeRecipientId(command.communityJid!),
            command.setting!,
          );
          break;
        case CommunityCommandAction.MemberAddMode:
          await this.sock.communityMemberAddMode(
            this.normalizeRecipientId(command.communityJid!),
            command.memberAddMode!,
          );
          break;
        case CommunityCommandAction.JoinApprovalMode:
          await this.sock.communityJoinApprovalMode(
            this.normalizeRecipientId(command.communityJid!),
            command.joinApprovalMode!,
          );
          break;
        case CommunityCommandAction.FetchAllParticipating:
          return this.buildSucceededCommandResult(command, {
            communities: await this.sock.communityFetchAllParticipating(),
          });
      }

      return this.buildSucceededCommandResult(command);
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeNewsletterCommand(command: NewsletterCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    try {
      switch (command.action) {
        case NewsletterCommandAction.Create:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.newsletterCreate(command.name!, command.description),
          });
        case NewsletterCommandAction.Update:
          if (command.name) {
            await this.sock.newsletterUpdateName(this.normalizeRecipientId(command.newsletterJid!), command.name);
          }
          if (command.description !== undefined) {
            await this.sock.newsletterUpdateDescription(
              this.normalizeRecipientId(command.newsletterJid!),
              command.description,
            );
          }
          if (command.pictureUrl) {
            await this.sock.newsletterUpdatePicture(
              this.normalizeRecipientId(command.newsletterJid!),
              { url: command.pictureUrl },
            );
          }
          break;
        case NewsletterCommandAction.Subscribers:
          return this.buildSucceededCommandResult(command, {
            subscribers: await this.sock.newsletterSubscribers(
              this.normalizeRecipientId(command.newsletterJid!),
            ),
          });
        case NewsletterCommandAction.Metadata:
          return this.buildSucceededCommandResult(command, {
            metadata: await this.sock.newsletterMetadata(
              command.lookupType ?? NewsletterLookupType.Jid,
              command.lookupKey ?? this.normalizeRecipientId(command.newsletterJid!),
            ),
          });
        case NewsletterCommandAction.Follow:
          await this.sock.newsletterFollow(this.normalizeRecipientId(command.newsletterJid!));
          break;
        case NewsletterCommandAction.Unfollow:
          await this.sock.newsletterUnfollow(this.normalizeRecipientId(command.newsletterJid!));
          break;
        case NewsletterCommandAction.Mute:
          await this.sock.newsletterMute(this.normalizeRecipientId(command.newsletterJid!));
          break;
        case NewsletterCommandAction.Unmute:
          await this.sock.newsletterUnmute(this.normalizeRecipientId(command.newsletterJid!));
          break;
        case NewsletterCommandAction.ReactMessage:
          await this.sock.newsletterReactMessage(
            this.normalizeRecipientId(command.newsletterJid!),
            command.serverId!,
            command.reactionText,
          );
          break;
        case NewsletterCommandAction.FetchMessages:
          return this.buildSucceededCommandResult(command, {
            messages: await this.sock.newsletterFetchMessages(
              this.normalizeRecipientId(command.newsletterJid!),
              command.count!,
              command.since!,
              command.after!,
            ),
          });
        case NewsletterCommandAction.SubscribeUpdates:
          return this.buildSucceededCommandResult(command, {
            subscription: await this.sock.subscribeNewsletterUpdates(
              this.normalizeRecipientId(command.newsletterJid!),
            ),
          });
        case NewsletterCommandAction.AdminCount:
          return this.buildSucceededCommandResult(command, {
            adminCount: await this.sock.newsletterAdminCount(
              this.normalizeRecipientId(command.newsletterJid!),
            ),
          });
        case NewsletterCommandAction.ChangeOwner:
          await this.sock.newsletterChangeOwner(
            this.normalizeRecipientId(command.newsletterJid!),
            this.normalizeRecipientId(command.newOwnerJid!),
          );
          break;
        case NewsletterCommandAction.Demote:
          await this.sock.newsletterDemote(
            this.normalizeRecipientId(command.newsletterJid!),
            this.normalizeRecipientId(command.userJid!),
          );
          break;
        case NewsletterCommandAction.Delete:
          await this.sock.newsletterDelete(this.normalizeRecipientId(command.newsletterJid!));
          break;
      }

      return this.buildSucceededCommandResult(command);
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeProfileCommand(command: ProfileCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    try {
      switch (command.action) {
        case ProfileCommandAction.ProfilePictureUrl:
          return this.buildSucceededCommandResult(command, {
            url: await this.sock.profilePictureUrl(
              this.normalizeRecipientId(command.jid!),
              command.pictureType,
            ),
          });
        case ProfileCommandAction.UpdateProfilePicture:
          await this.sock.updateProfilePicture(
            this.normalizeRecipientId(command.jid!),
            { url: command.mediaUrl! },
            command.dimensions,
          );
          break;
        case ProfileCommandAction.RemoveProfilePicture:
          await this.sock.removeProfilePicture(this.normalizeRecipientId(command.jid!));
          break;
        case ProfileCommandAction.UpdateProfileStatus:
          await this.sock.updateProfileStatus(command.statusText!);
          break;
        case ProfileCommandAction.UpdateProfileName:
          await this.sock.updateProfileName(command.profileName!);
          break;
        case ProfileCommandAction.UpdateBlockStatus:
          await this.sock.updateBlockStatus(
            this.normalizeRecipientId(command.jid!),
            command.blockAction!,
          );
          break;
        case ProfileCommandAction.FetchBlocklist:
          return this.buildSucceededCommandResult(command, {
            blocklist: await this.sock.fetchBlocklist(),
          });
        case ProfileCommandAction.FetchStatus:
          return this.buildSucceededCommandResult(command, {
            statuses: await this.sock.fetchStatus(...command.jids.map(jid => this.normalizeRecipientId(jid))),
          });
        case ProfileCommandAction.FetchDisappearingDuration:
          return this.buildSucceededCommandResult(command, {
            durations: await this.sock.fetchDisappearingDuration(
              ...command.jids.map(jid => this.normalizeRecipientId(jid)),
            ),
          });
        case ProfileCommandAction.GetBusinessProfile:
          return this.buildSucceededCommandResult(command, {
            profile: await this.sock.getBusinessProfile(this.normalizeRecipientId(command.jid!)),
          });
      }

      return this.buildSucceededCommandResult(command);
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executePrivacyCommand(command: PrivacyCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    try {
      switch (command.action) {
        case PrivacyCommandAction.FetchSettings:
          return this.buildSucceededCommandResult(command, {
            settings: await this.sock.fetchPrivacySettings(),
          });
        case PrivacyCommandAction.UpdateDisableLinkPreviews:
          await this.sock.updateDisableLinkPreviewsPrivacy(command.previewsDisabled!);
          break;
        case PrivacyCommandAction.UpdateCallPrivacy:
          await this.sock.updateCallPrivacy(command.callPrivacy!);
          break;
        case PrivacyCommandAction.UpdateMessagesPrivacy:
          await this.sock.updateMessagesPrivacy(command.messagesPrivacy!);
          break;
        case PrivacyCommandAction.UpdateLastSeenPrivacy:
          await this.sock.updateLastSeenPrivacy(command.lastSeenPrivacy!);
          break;
        case PrivacyCommandAction.UpdateOnlinePrivacy:
          await this.sock.updateOnlinePrivacy(command.onlinePrivacy!);
          break;
        case PrivacyCommandAction.UpdateProfilePicturePrivacy:
          await this.sock.updateProfilePicturePrivacy(command.profilePicturePrivacy!);
          break;
        case PrivacyCommandAction.UpdateStatusPrivacy:
          await this.sock.updateStatusPrivacy(command.statusPrivacy!);
          break;
        case PrivacyCommandAction.UpdateReadReceiptsPrivacy:
          await this.sock.updateReadReceiptsPrivacy(command.readReceiptsPrivacy!);
          break;
        case PrivacyCommandAction.UpdateGroupsAddPrivacy:
          await this.sock.updateGroupsAddPrivacy(command.groupsAddPrivacy!);
          break;
        case PrivacyCommandAction.UpdateDefaultDisappearingMode:
          await this.sock.updateDefaultDisappearingMode(command.defaultDisappearingModeSeconds!);
          break;
      }

      return this.buildSucceededCommandResult(command);
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async executeCallCommand(command: CallCommand): Promise<OutboundCommandResult> {
    if (!this.sock) {
      return this.buildFailedCommandResult(command, 'no active socket');
    }

    try {
      if (command.action === CallCommandAction.Reject) {
        await this.sock.rejectCall(command.callId!, this.normalizeRecipientId(command.callFrom!));
        return this.buildSucceededCommandResult(command);
      }

      return this.buildSucceededCommandResult(command, {
        callLink: await this.sock.createCallLink(
          command.callType === CallType.Video ? 'video' : 'audio',
          command.startTime
            ? {
                startTime: command.startTime,
              }
            : undefined,
          command.timeoutMs,
        ),
      });
    } catch (error) {
      return this.buildFailedCommandResult(
        command,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private buildCommandResultFromDelivery(
    command: SendMessageCommand,
    deliveryResult: DeliveryResult,
  ): OutboundCommandResult {
    return new OutboundCommandResult(
      command.commandId,
      command.session,
      command.family,
      command.action,
      deliveryResult.status === DeliveryStatus.Sent
        ? OutboundCommandResultStatus.Succeeded
        : deliveryResult.status === DeliveryStatus.Blocked
          ? OutboundCommandResultStatus.Blocked
          : OutboundCommandResultStatus.Failed,
      deliveryResult.timestamp,
      deliveryResult.reason,
      {
        recipientId: deliveryResult.recipientId,
        providerMessageId: deliveryResult.providerMessageId,
      },
    );
  }

  private buildSucceededCommandResult(
    command: OutboundCommand,
    data?: Readonly<Record<string, unknown>>,
  ): OutboundCommandResult {
    return new OutboundCommandResult(
      command.commandId,
      command.session,
      command.family,
      command.action,
      OutboundCommandResultStatus.Succeeded,
      new Date().toISOString(),
      undefined,
      data,
    );
  }

  private buildFailedCommandResult(
    command: OutboundCommand,
    reason: string,
    data?: Readonly<Record<string, unknown>>,
  ): OutboundCommandResult {
    return new OutboundCommandResult(
      command.commandId,
      command.session,
      command.family,
      command.action,
      OutboundCommandResultStatus.Failed,
      new Date().toISOString(),
      reason,
      data,
    );
  }

  private toBaileysMessageKey(messageKey: CommandMessageKey): {
    id: string;
    remoteJid?: string;
    participant?: string;
  } {
    return {
      id: messageKey.reference.messageId,
      remoteJid: messageKey.reference.remoteJid,
      participant: messageKey.reference.participantId,
    };
  }

  private toMinimalMessages(
    messageKeys: readonly CommandMessageKey[],
    label: string,
  ): Array<{
    key: {
      id: string;
      remoteJid?: string;
      participant?: string;
    };
    messageTimestamp: number;
  }> {
    return messageKeys.map((messageKey, index) => {
      if (messageKey.timestamp == null) {
        throw new Error(`${label} requires messages[${index}].timestamp.`);
      }

      return {
        key: this.toBaileysMessageKey(messageKey),
        messageTimestamp: messageKey.timestamp,
      };
    });
  }

  private setupEventListeners(saveCreds: () => Promise<void>): void {
    if (!this.sock) {
      return;
    }

    const socket = this.sock;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', update => {
      void this.handleConnectionUpdate(update);
    });

    socket.ev.on('messages.upsert', event => {
      void this.handleMessagesUpsert(event);
    });

    socket.ev.on('messages.update', updates => {
      void this.handleMessagesUpdate(updates);
    });

    socket.ev.on('messages.reaction', reactions => {
      void this.handleMessagesReaction(reactions);
    });

    socket.ev.on('messaging-history.set', event => {
      this.logMessagingHistorySet(event);
    });

    socket.ev.on('contacts.upsert', contacts => {
      void this.cacheContactLidMappings(contacts);
    });

    socket.ev.on('contacts.update', contacts => {
      void this.cacheContactLidMappings(contacts);
    });
  }

  private async handleConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.latestQrCode = qr;
      console.log(
        `\n[QR CODE] Scan below to connect WhatsApp for ${this.session.toLogLabel()}:`,
      );
      qrcode.generate(qr, { small: true });

      if (this.activeActivation?.mode === ActivationMode.QrCode) {
        await this.publishCurrentQrCode(this.activeActivation);
      }
    }

    if (connection === 'open') {
      this.isConnected = true;
      this.latestQrCode = undefined;
      console.log(`[BaileysProvider] Connection opened for ${this.session.toLogLabel()}.`);
      this.antiBan.onReconnect();

      if (this.activeActivation) {
        await this.publishActivationCompleted(this.activeActivation);
        this.activeActivation = undefined;
      }

      await this.publishStatus(SessionStatus.Connected);
      return;
    }

    if (connection !== 'close') {
      return;
    }

    const statusCode = this.extractDisconnectStatusCode(lastDisconnect?.error);
    const errorMsg = this.extractErrorMessage(lastDisconnect?.error);
    const isIntentional =
      this.isStopping
      || errorMsg.includes('Intentional Logout')
      || errorMsg.includes('Intentional Shutdown');
    const shouldReconnect =
      statusCode !== DisconnectReason.loggedOut && !isIntentional;

    console.log(
      `[BaileysProvider] Connection closed for ${this.session.toLogLabel()} (reason: ${statusCode}). Reconnecting: ${shouldReconnect}.`,
    );

    this.antiBan.onDisconnect(statusCode);
    this.isConnected = false;
    this.sock = null;

    if (statusCode === DisconnectReason.loggedOut && !isIntentional) {
      console.error(
        `[BaileysProvider] Permanent logout detected for ${this.session.toLogLabel()}. Cleaning up session state.`,
      );
      await this.authenticationStateStore.clearSession().catch(error => {
        console.error('[BaileysProvider] Fatal error cleaning session:', error);
      });
      await this.publishStatus(SessionStatus.LoggedOut, `disconnect:${statusCode}`);
    }

    if (shouldReconnect) {
      await this.publishStatus(SessionStatus.Reconnecting, `disconnect:${statusCode}`);
      this.scheduleReconnect();
      return;
    }

    this.isStopping = false;
    if (!isIntentional) {
      if (this.activeActivation) {
        await this.publishActivationFailed(
          this.activeActivation,
          `disconnect:${statusCode ?? 'unknown'}`,
        );
        this.activeActivation = undefined;
      }
      await this.publishStatus(SessionStatus.Failed, `disconnect:${statusCode}`);
    }
    console.log(
      `[BaileysProvider] ${this.session.toLogLabel()} stopped (${isIntentional ? 'requested' : 'logged out'}).`,
    );
  }

  private async requestActivation(
    activation: ActiveActivation,
    waitTimeoutMs: number,
    customPairingCode?: string,
  ): Promise<ActivationEvent> {
    if (waitTimeoutMs <= 0) {
      throw new Error('Activation wait timeout must be greater than zero.');
    }

    if (this.activeActivation) {
      await this.cancelActivation(this.activeActivation, 'superseded_by_new_request');
    }

    const firstResultPromise = this.createPendingActivationFirstResult(
      activation.activationId,
      waitTimeoutMs,
    );

    try {
      await this.startActivation(activation, customPairingCode);
      return await firstResultPromise;
    } catch (error) {
      this.rejectPendingActivationFirstResult(
        activation.activationId,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async startActivation(
    activation: ActiveActivation,
    customPairingCode?: string,
  ): Promise<void> {
    this.activeActivation = activation;

    await this.emitActivationEvent(
      new ActivationStartedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        activation.mode,
        activation.phoneNumber,
      ),
    );

    await this.start();

    if (!this.isCurrentActivation(activation)) {
      return;
    }

    if (this.isConnected) {
      await this.publishActivationCompleted(activation);
      if (this.isCurrentActivation(activation)) {
        this.activeActivation = undefined;
      }
      return;
    }

    if (activation.mode === ActivationMode.QrCode) {
      await this.publishCurrentQrCode(activation);
      return;
    }

    if (!this.sock) {
      await this.publishActivationFailed(activation, 'activation socket unavailable');
      if (this.isCurrentActivation(activation)) {
        this.activeActivation = undefined;
      }
      return;
    }

    try {
      const pairingCode = await this.sock.requestPairingCode(
        this.normalizePhoneNumberForPairingCode(activation.phoneNumber ?? ''),
        customPairingCode,
      );

      if (!this.isCurrentActivation(activation)) {
        return;
      }

      activation.pairingCodeSequence += 1;
      await this.emitActivationEvent(
        new ActivationPairingCodeUpdatedEvent(
          activation.commandId,
          activation.correlationId,
          activation.activationId,
          this.session,
          new Date().toISOString(),
          pairingCode,
          activation.pairingCodeSequence,
          activation.phoneNumber,
        ),
      );
    } catch (error) {
      await this.publishActivationFailed(
        activation,
        error instanceof Error ? error.message : String(error),
      );

      if (this.isCurrentActivation(activation)) {
        this.activeActivation = undefined;
      }
    }
  }

  private async cancelActivation(
    activation: ActiveActivation,
    reason = 'cancelled_by_request',
  ): Promise<void> {
    await this.publishActivationCancelled(activation, reason);

    if (this.isCurrentActivation(activation)) {
      this.activeActivation = undefined;
    }
  }

  private async handleMessagesUpsert(event: any): Promise<void> {
    const upsertType = event?.type ?? 'unknown';
    const messages = Array.isArray(event?.messages) ? event.messages : [];

    if (upsertType !== 'notify' && messages.length > 0) {
      console.log(`\n[UPSERT] type=${upsertType} count=${messages.length}`);
    }

    for (const msg of messages) {
      const isFromMe = Boolean(msg.key.fromMe);

      if (!isFromMe && this.isCiphertextStub(msg)) {
        await this.logCiphertextIssue(msg, upsertType);
        continue;
      }

      const normalized = await BaileysMessageNormalizer.normalize(
        msg,
        this.resolveJidToE164.bind(this),
      );

      if (!normalized) {
        await this.logSkippedMessage(
          upsertType,
          isFromMe,
          msg,
          BaileysMessageNormalizer.getSkipReason(msg?.message) ?? 'no_normalized_content',
        );
        continue;
      }

      this.logNormalizedMessage(
        this.getMessageLogTag(upsertType, isFromMe),
        msg,
        normalized,
      );

      if (upsertType !== 'notify') {
        continue;
      }

      if (normalized.content instanceof DeleteMessageContent) {
        const inboundEvent = new MessageDeletedEvent(
          this.session,
          normalized.timestamp,
          normalized.content.targetMessage,
          normalized.chatId,
          normalized.senderId,
          isFromMe,
          normalized,
        );

        await this.callbacks.onInboundEvent(inboundEvent);
        continue;
      }

      if (normalized.context?.editTarget) {
        const inboundEvent = new MessageUpdatedEvent(
          this.session,
          normalized.timestamp,
          normalized.context.editTarget,
          normalized.chatId,
          normalized.senderId,
          isFromMe,
          [MessageUpdateKind.Content],
          normalized,
          undefined,
          undefined,
          normalized.content.type,
          undefined,
          undefined,
          undefined,
        );

        await this.callbacks.onInboundEvent(inboundEvent);
        continue;
      }

      if (normalized.content instanceof ReactionMessageContent) {
        continue;
      }

      const inboundEvent = new MessageCreatedEvent(
        this.session,
        normalized.timestamp,
        normalized,
        isFromMe,
      );

      await this.callbacks.onInboundEvent(inboundEvent);
    }
  }

  private async handleMessagesUpdate(updates: any[]): Promise<void> {
    for (const entry of updates ?? []) {
      const key = entry?.key;
      const update = entry?.update ?? {};

      if (!key) {
        continue;
      }

      const hasMessage = Boolean(update.message);
      const pollUpdateCount = Array.isArray(update.pollUpdates) ? update.pollUpdates.length : 0;
      const status = update.status;
      const stubType = update.messageStubType;
      const timestamp = new Date().toISOString();

      if (!hasMessage && !pollUpdateCount && status == null && stubType == null) {
        continue;
      }

      const fallbackTargetMessage = this.buildMessageReferenceFromKey(key);
      if (!fallbackTargetMessage) {
        continue;
      }

      const { chatId, senderId, chatLabel, senderLabel } = await this.describeMessageKey(key);
      const normalizedMessage = hasMessage
        ? await BaileysMessageNormalizer.normalize(
            {
              key,
              message: update.message,
              messageTimestamp: update.messageTimestamp,
            },
            this.resolveJidToE164.bind(this),
          )
        : null;
      const deletedTargetMessage = hasMessage
        ? BaileysMessageNormalizer.extractDeleteTargetMessage(
            update.message,
            key.remoteJid ?? undefined,
          )
        : undefined;
      const targetMessage =
        normalizedMessage?.context?.editTarget
        ?? deletedTargetMessage
        ?? fallbackTargetMessage;
      const updateKinds: MessageUpdateKind[] = [];
      const parts = [
        `chat=${chatLabel}`,
        `sender=${senderLabel}`,
      ];

      if (status != null) {
        parts.push(`status=${status}`);
      }

      if (stubType != null) {
        parts.push(`stubType=${stubType}`);
        updateKinds.push(MessageUpdateKind.Stub);
      }

      const contentType = hasMessage
        ? normalizedMessage?.content.type
          ?? BaileysMessageNormalizer.describeContentType(
            update.message,
            key.remoteJid ?? undefined,
          )
        : undefined;
      if (hasMessage) {
        parts.push(`message=${contentType ?? 'unknown'}`);
        updateKinds.push(MessageUpdateKind.Content);
      }

      if (pollUpdateCount > 0) {
        parts.push(`pollUpdates=${pollUpdateCount}`);
        updateKinds.push(MessageUpdateKind.Poll);
      }

      if (status != null) {
        updateKinds.push(MessageUpdateKind.Status);
      }

      console.log(`\n[MSG UPDATE] ${parts.join(' ')}`);

      if (deletedTargetMessage) {
        const inboundEvent = new MessageDeletedEvent(
          this.session,
          timestamp,
          deletedTargetMessage,
          chatId,
          senderId,
          Boolean(key.fromMe),
          normalizedMessage ?? undefined,
        );

        await this.callbacks.onInboundEvent(inboundEvent);
        continue;
      }

      const inboundEvent = new MessageUpdatedEvent(
        this.session,
        timestamp,
        targetMessage,
        chatId,
        senderId,
        Boolean(key.fromMe),
        updateKinds,
        normalizedMessage ?? undefined,
        typeof status === 'number' ? status : undefined,
        typeof stubType === 'number' ? stubType : undefined,
        contentType,
        pollUpdateCount > 0 ? pollUpdateCount : undefined,
        undefined,
        undefined,
      );

      await this.callbacks.onInboundEvent(inboundEvent);
    }
  }

  private async handleMessagesReaction(reactions: any[]): Promise<void> {
    for (const entry of reactions ?? []) {
      const key = entry?.key;
      const targetMessage = this.buildMessageReferenceFromKey(key);
      if (!key || !targetMessage) {
        continue;
      }

      const { chatId, senderId, chatLabel, senderLabel } = await this.describeMessageKey(key);
      const reactionText = entry?.reaction?.text || 'removed';
      console.log(
        `\n[MSG REACTION] chat=${chatLabel} sender=${senderLabel} text=${reactionText}`,
      );

      const inboundEvent = new MessageUpdatedEvent(
        this.session,
        new Date().toISOString(),
        targetMessage,
        chatId,
        senderId,
        Boolean(key.fromMe),
        [MessageUpdateKind.Reaction],
        undefined,
        undefined,
        undefined,
        MessageContentType.Reaction,
        undefined,
        entry?.reaction?.text || undefined,
        !entry?.reaction?.text,
      );

      await this.callbacks.onInboundEvent(inboundEvent);
    }
  }

  private logMessagingHistorySet(event: any): void {
    const messageCount = Array.isArray(event?.messages) ? event.messages.length : 0;
    const contactCount = Array.isArray(event?.contacts) ? event.contacts.length : 0;
    const chatCount = Array.isArray(event?.chats) ? event.chats.length : 0;
    const syncType = event?.syncType ?? 'unknown';
    const progress = event?.progress ?? 'n/a';
    const latest = event?.isLatest ?? 'n/a';

    console.log(
      `\n[HISTORY] syncType=${syncType} progress=${progress} latest=${latest} messages=${messageCount} contacts=${contactCount} chats=${chatCount}`,
    );
  }

  private logNormalizedMessage(
    direction: string,
    rawMessage: any,
    normalized: Message,
  ): void {
    const senderLabel = direction === 'OUT'
      ? 'self'
      : this.buildSenderLabel(rawMessage, normalized);

    const debugSuffix = this.buildDebugContentSuffix(rawMessage, normalized);

    console.log(
      `\n[MSG ${direction}] chat=${normalized.chatId} sender=${senderLabel} type=${normalized.content.type}${debugSuffix}`,
    );
  }

  private getMessageLogTag(upsertType: string, isFromMe: boolean): string {
    if (isFromMe) {
      return 'OUT';
    }

    return upsertType === 'notify' ? 'IN' : upsertType.toUpperCase();
  }

  private async logSkippedMessage(
    upsertType: string,
    isFromMe: boolean,
    rawMessage: any,
    reason: string,
  ): Promise<void> {
    const { chatLabel, senderLabel } = await this.describeRawMessage(rawMessage);
    const direction = isFromMe ? 'OUT' : 'IN';

    const debugSuffix = this.buildDebugContentSuffix(rawMessage);

    console.log(
      `\n[MSG SKIP] upsert=${upsertType} direction=${direction} chat=${chatLabel} sender=${senderLabel} reason=${reason}${debugSuffix}`,
    );
  }

  private buildSenderLabel(
    rawMessage: any,
    normalized: Message,
  ): string {
    const senderPhone = normalized.context?.senderPhone;
    const senderName =
      rawMessage.pushName || rawMessage.verifiedBizName || rawMessage.verifiedName || undefined;

    return senderName
      ? `${senderName}${senderPhone ? ` <${senderPhone}>` : ''}`
      : senderPhone || normalized.senderId;
  }

  private isCiphertextStub(message: any): boolean {
    return message?.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT;
  }

  private async logCiphertextIssue(message: any, upsertType = 'notify'): Promise<void> {
    const messageId = message?.key?.id;
    if (!messageId || this.loggedCiphertextIssues.has(messageId)) {
      return;
    }

    this.loggedCiphertextIssues.add(messageId);
    setTimeout(() => {
      this.loggedCiphertextIssues.delete(messageId);
    }, 10 * 60 * 1000);

    const { chatLabel, senderLabel } = await this.describeRawMessage(message);
    const reason = this.mapCiphertextReason(message?.messageStubParameters?.[0]);

    const debugSuffix = this.buildDebugContentSuffix(message);

    console.warn(
      `\n[MSG WAIT] upsert=${upsertType} chat=${chatLabel} sender=${senderLabel} reason=${reason}${debugSuffix}`,
    );
  }

  private mapCiphertextReason(rawReason: unknown): string {
    const reason = typeof rawReason === 'string' ? rawReason : '';

    if (reason.includes('PreKey')) {
      return 'decrypt_retry_pending';
    }

    if (reason.includes('No message found')) {
      return 'message_retry_requested';
    }

    if (reason.includes('Missing')) {
      return 'keys_pending';
    }

    return 'ciphertext_pending';
  }

  private scheduleReconnect(): void {
    if (this.isStopping || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;

      if (this.isStopping) {
        return;
      }

      void this.start().catch(error => {
        console.error(
          `[BaileysProvider] Failed to restart ${this.session.toLogLabel()}:`,
          error,
        );
        this.scheduleReconnect();
      });
    }, 2000);
  }

  private buildDeliveryResult(
    command: SendMessageCommand,
    status: DeliveryStatus,
    providerMessageId?: string,
    reason?: string,
  ): DeliveryResult {
    return new DeliveryResult(
      command.commandId,
      this.session,
      command.message.chatId,
      status,
      new Date().toISOString(),
      providerMessageId,
      reason,
    );
  }

  private async publishStatus(
    status: SessionStatus,
    reason?: string,
  ): Promise<void> {
    await this.callbacks.onSessionStatus(
      new SessionStatusEvent(
        this.session,
        status,
        new Date().toISOString(),
        undefined,
        reason,
      ),
    );
  }

  private toBaileysContent(message: Message): any {
    const { content } = message;
    let payload: Record<string, unknown>;

    if (content instanceof TextMessageContent) {
      payload = { text: content.text };
    } else if (content instanceof ImageMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('image content requires mediaUrl');
      }

      payload = {
        image: { url: content.mediaUrl },
        caption: content.caption,
        mimetype: content.mimeType,
        width: content.width,
        height: content.height,
      };
    } else if (content instanceof AudioMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('audio content requires mediaUrl');
      }

      payload = {
        audio: { url: content.mediaUrl },
        mimetype: content.mimeType,
        seconds: content.durationSeconds,
        ptt: content.voiceNote,
      };
    } else if (content instanceof VideoMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('video content requires mediaUrl');
      }

      payload = {
        video: { url: content.mediaUrl },
        caption: content.caption,
        mimetype: content.mimeType,
        width: content.width,
        height: content.height,
        gifPlayback: content.gifPlayback,
        ptv: content.videoNote,
      };
    } else if (content instanceof DocumentMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('document content requires mediaUrl');
      }

      payload = {
        document: { url: content.mediaUrl },
        mimetype: content.mimeType,
        fileName: content.fileName ?? content.caption ?? 'document',
        caption: content.caption,
      };
    } else if (content instanceof StickerMessageContent) {
      if (!content.mediaUrl) {
        throw new Error('sticker content requires mediaUrl');
      }

      payload = {
        sticker: { url: content.mediaUrl },
        mimetype: content.mimeType,
        isAnimated: content.animated,
        width: content.width,
        height: content.height,
      };
    } else if (content instanceof ContactsMessageContent) {
      payload = {
        contacts: {
          displayName: content.displayName ?? content.contacts[0]?.displayName,
          contacts: content.contacts.map(contact => ({
            displayName: contact.displayName,
            vcard: contact.vcard,
          })),
        },
      };
    } else if (content instanceof LocationMessageContent) {
      payload = {
        location: {
          degreesLatitude: content.latitude,
          degreesLongitude: content.longitude,
          name: content.name,
          address: content.address,
          url: content.url,
          comment: content.comment,
          isLive: content.live,
          accuracyInMeters: content.accuracyInMeters,
          speedInMps: content.speedInMetersPerSecond,
          degreesClockwiseFromMagneticNorth: content.degreesClockwiseFromMagneticNorth,
        },
      };
    } else if (content instanceof ReactionMessageContent) {
      payload = {
        react: {
          key: {
            id: content.targetMessage.messageId,
            remoteJid: content.targetMessage.remoteJid
              ?? this.normalizeRecipientId(message.chatId),
            participant: content.targetMessage.participantId,
          },
          text: content.removed ? '' : content.reactionText,
        },
      };
    } else if (content instanceof PollMessageContent) {
      payload = {
        poll: {
          name: content.name,
          values: content.options.map(option => option.name),
          selectableCount: content.selectableCount,
        },
      };
    } else if (content instanceof ButtonReplyMessageContent) {
      payload = {
        buttonReply: {
          displayText: content.displayText,
          id: content.buttonId,
          index: content.buttonIndex ?? 0,
        },
        type: content.replyType,
      };
    } else if (content instanceof ListReplyMessageContent) {
      payload = {
        listReply: {
          title: content.title,
          description: content.description,
          singleSelectReply: {
            selectedRowId: content.selectedRowId,
          },
        },
      };
    } else if (content instanceof GroupInviteMessageContent) {
      if (!content.groupJid.trim() || !content.inviteCode.trim()) {
        throw new Error('group invite content requires groupJid and inviteCode');
      }

      payload = {
        groupInvite: {
          jid: content.groupJid,
          inviteCode: content.inviteCode,
          inviteExpiration: content.inviteExpiration ?? 0,
          subject: content.groupName ?? '',
          text: content.caption ?? '',
        },
      };
    } else if (content instanceof EventMessageContent) {
      payload = {
        event: {
          name: content.name,
          description: content.description,
          startDate: content.startTimestamp ? new Date(content.startTimestamp) : new Date(),
          endDate: content.endTimestamp ? new Date(content.endTimestamp) : undefined,
          location: content.location
            ? {
                degreesLatitude: content.location.latitude,
                degreesLongitude: content.location.longitude,
                name: content.location.name,
                address: content.location.address,
                url: content.location.url,
              }
            : undefined,
          call: content.callType === EventCallType.Audio
            ? 'audio'
            : content.callType === EventCallType.Video
              ? 'video'
              : undefined,
          isCancelled: content.cancelled,
          isScheduleCall: content.scheduledCall,
          extraGuestsAllowed: content.extraGuestsAllowed,
        },
      };
    } else if (content instanceof ProductMessageContent) {
      if (!content.productImageUrl) {
        throw new Error('product content requires productImageUrl');
      }

      payload = {
        product: {
          productId: content.productId,
          title: content.title,
          description: content.description,
          currencyCode: content.currencyCode,
          priceAmount1000: content.priceAmount1000,
          retailerId: content.retailerId,
          url: content.url,
          productImage: { url: content.productImageUrl },
        },
        businessOwnerJid: content.businessOwnerJid,
        body: content.body,
        footer: content.footer,
      };
    } else if (content instanceof RequestPhoneNumberMessageContent) {
      payload = { requestPhoneNumber: true };
    } else if (content instanceof SharePhoneNumberMessageContent) {
      payload = { sharePhoneNumber: true };
    } else if (content instanceof DeleteMessageContent) {
      payload = {
        delete: {
          id: content.targetMessage.messageId,
          remoteJid: content.targetMessage.remoteJid ?? this.normalizeRecipientId(message.chatId),
          participant: content.targetMessage.participantId,
        },
      };
    } else if (content instanceof PinMessageContent) {
      payload = {
        pin: {
          id: content.targetMessage.messageId,
          remoteJid: content.targetMessage.remoteJid ?? this.normalizeRecipientId(message.chatId),
          participant: content.targetMessage.participantId,
        },
        type: content.action === PinMessageAction.UnpinForAll
          ? proto.PinInChat.Type.UNPIN_FOR_ALL
          : proto.PinInChat.Type.PIN_FOR_ALL,
        time: content.durationSeconds,
      };
    } else if (content instanceof DisappearingMessagesMessageContent) {
      payload = {
        disappearingMessagesInChat: content.expirationSeconds,
      };
    } else if (content instanceof LimitSharingMessageContent) {
      payload = {
        limitSharing: content.sharingLimited,
      };
    } else if (content instanceof InteractiveResponseMessageContent) {
      throw new Error('interactive response content is inbound-only in this gateway');
    } else if (content instanceof OtherMessageContent) {
      throw new Error(
        `Unsupported outbound content type: ${content.description ?? MessageContentType.Other}`,
      );
    } else {
      throw new Error(`Unsupported outbound content type: ${String(content.type)}`);
    }

    return this.applyCommonOutboundOptions(message, payload);
  }

  private applyCommonOutboundOptions(
    message: Message,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const mentionedJids = message.context?.mentionedJids
      .map(jid => this.normalizeRecipientId(jid))
      .filter(Boolean);

    if (
      mentionedJids?.length
      && (
        payload.text
        || payload.image
        || payload.video
        || payload.document
        || payload.poll
      )
    ) {
      payload.mentions = mentionedJids;
    }

    if (message.context?.viewOnce) {
      payload.viewOnce = true;
    }

    if (message.context?.editTarget) {
      payload.edit = {
        id: message.context.editTarget.messageId,
        remoteJid: message.context.editTarget.remoteJid ?? this.normalizeRecipientId(message.chatId),
        participant: message.context.editTarget.participantId,
      };
    }

    return payload;
  }

  private normalizeRecipientId(recipientId: string): string {
    if (recipientId.includes('@')) {
      return recipientId;
    }

    const digits = recipientId.replace(/\D/g, '');
    if (digits) {
      return `${digits}@s.whatsapp.net`;
    }

    return recipientId;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private async cacheContactLidMappings(contacts: any[]): Promise<void> {
    const redis = RedisConnection.getClient();
    for (const contact of contacts) {
      const id1 = contact.id;
      const id2 = contact.lidJid || contact.pnJid;

      if (id1 && id2 && id1 !== id2) {
        const jids = [id1, id2];
        const lid = jids.find((jid: string) => jid.includes('@lid') || jid.includes('hosted.lid'));
        const pn = jids.find((jid: string) => jid.includes('@s.whatsapp.net'));

        if (lid && pn) {
          const redisKey = RedisKeyBuilder.getLidMappingKey(
            this.session,
            lid,
          );
          await redis.setex(redisKey, 86400 * 30, pn);
        }
      }
    }
  }

  private normalizeE164(phoneNumber: string): string {
    const digits = phoneNumber.replace(/\D/g, '');
    if (!digits) {
      return '';
    }

    return `+${digits}`;
  }

  private normalizePhoneNumberForPairingCode(phoneNumber: string): string {
    const digits = phoneNumber.replace(/\D/g, '');
    if (!digits) {
      throw new Error('Pairing code activation requires a numeric phone number.');
    }

    return digits;
  }

  private async resolveJidToE164(
    jid: string | null | undefined,
    altJid?: string | null,
  ): Promise<string | null> {
    if (!jid) {
      return null;
    }

    if (altJid && altJid.includes('@s.whatsapp.net')) {
      return this.normalizeE164(altJid.split('@')[0]);
    }

    const phoneMatch = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
    if (phoneMatch) {
      return this.normalizeE164(phoneMatch[1]);
    }

    const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
    if (lidMatch) {
      try {
        const redis = RedisConnection.getClient();
        const mappedPn = await redis.get(
          RedisKeyBuilder.getLidMappingKey(this.session, jid),
        );
        if (mappedPn) {
          return this.resolveJidToE164(mappedPn);
        }
      } catch (error) {
        console.warn(`[BaileysProvider] LID Redis lookup failed for ${jid}:`, error);
      }

      return null;
    }

    return null;
  }

  private async describeRawMessage(rawMessage: any): Promise<{
    chatId: string;
    senderId: string;
    chatLabel: string;
    senderLabel: string;
  }> {
    return this.describeMessageKey(
      rawMessage?.key,
      rawMessage?.pushName || rawMessage?.verifiedBizName || rawMessage?.verifiedName || undefined,
    );
  }

  private async describeMessageKey(
    key: any,
    senderName?: string,
  ): Promise<{
    chatId: string;
    senderId: string;
    chatLabel: string;
    senderLabel: string;
  }> {
    const rawChatId = key?.remoteJid;
    const rawParticipantId = key?.participant || undefined;
    const rawSenderId = rawParticipantId || rawChatId;
    const altJid = key?.participantAlt || key?.remoteJidAlt;
    const senderPhone = await this.resolveJidToE164(rawSenderId, altJid);
    const chatPhone = rawChatId
      ? await this.resolveJidToE164(rawChatId, key?.remoteJidAlt)
      : null;

    const chatId = chatPhone || rawChatId || 'unknown';
    const senderId = senderPhone || rawSenderId || 'unknown';

    return {
      chatId,
      senderId,
      chatLabel: chatId,
      senderLabel: senderName
        ? `${senderName}${senderPhone ? ` <${senderPhone}>` : ''}`
        : senderId,
    };
  }

  private describeMessageContentType(message: any): string {
    const content = this.unwrapMessage(message);

    if (!this.isRecord(content)) {
      return 'unknown';
    }

    const contentKeys = Object.keys(content).filter(key => Boolean(content[key]));
    return contentKeys[0] ?? 'unknown';
  }

  private buildMessageReferenceFromKey(key: any): MessageReference | undefined {
    if (!key?.id) {
      return undefined;
    }

    return new MessageReference(
      key.id,
      key.remoteJid ?? undefined,
      key.participant ?? undefined,
    );
  }

  private createActiveActivation(
    commandId: string,
    correlationId: string,
    activationId: string,
    mode: ActivationMode,
    phoneNumber?: string,
  ): ActiveActivation {
    return {
      commandId,
      correlationId,
      activationId,
      mode,
      phoneNumber,
      qrSequence: 0,
      pairingCodeSequence: 0,
    };
  }

  private isCurrentActivation(activation: ActiveActivation): boolean {
    return this.activeActivation?.activationId === activation.activationId;
  }

  private createPendingActivationFirstResult(
    activationId: string,
    waitTimeoutMs: number,
  ): Promise<ActivationEvent> {
    if (this.pendingActivationFirstResult) {
      clearTimeout(this.pendingActivationFirstResult.timer);
      this.pendingActivationFirstResult.reject(
        new Error('Activation first result waiter was replaced before completion.'),
      );
      this.pendingActivationFirstResult = undefined;
    }

    return new Promise<ActivationEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingActivationFirstResult?.activationId === activationId) {
          this.pendingActivationFirstResult = undefined;
        }

        reject(
          new Error(`Activation ${activationId} did not produce an initial result within ${waitTimeoutMs}ms.`),
        );
      }, waitTimeoutMs);
      timer.unref();

      this.pendingActivationFirstResult = {
        activationId,
        resolve,
        reject,
        timer,
      };
    });
  }

  private resolvePendingActivationFirstResult(event: ActivationEvent): void {
    if (!this.pendingActivationFirstResult) {
      return;
    }

    if (this.pendingActivationFirstResult.activationId !== event.activationId) {
      return;
    }

    if (event instanceof ActivationStartedEvent) {
      return;
    }

    clearTimeout(this.pendingActivationFirstResult.timer);
    const { resolve } = this.pendingActivationFirstResult;
    this.pendingActivationFirstResult = undefined;
    resolve(event);
  }

  private rejectPendingActivationFirstResult(activationId: string, error: Error): void {
    if (!this.pendingActivationFirstResult) {
      return;
    }

    if (this.pendingActivationFirstResult.activationId !== activationId) {
      return;
    }

    clearTimeout(this.pendingActivationFirstResult.timer);
    const { reject } = this.pendingActivationFirstResult;
    this.pendingActivationFirstResult = undefined;
    reject(error);
  }

  private async emitActivationEvent(event: ActivationEvent): Promise<void> {
    try {
      await this.callbacks.onActivationEvent(event);
    } finally {
      this.resolvePendingActivationFirstResult(event);
    }
  }

  private async publishCurrentQrCode(activation: ActiveActivation): Promise<void> {
    if (!this.latestQrCode || !this.isCurrentActivation(activation)) {
      return;
    }

    activation.qrSequence += 1;
    await this.emitActivationEvent(
      new ActivationQrCodeUpdatedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        this.latestQrCode,
        activation.qrSequence,
      ),
    );
  }

  private async publishActivationCompleted(activation: ActiveActivation): Promise<void> {
    await this.emitActivationEvent(
      new ActivationCompletedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        activation.mode,
      ),
    );
  }

  private async publishActivationFailed(
    activation: ActiveActivation,
    reason: string,
  ): Promise<void> {
    await this.emitActivationEvent(
      new ActivationFailedEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        reason,
      ),
    );
  }

  private async publishActivationCancelled(
    activation: ActiveActivation,
    reason: string,
  ): Promise<void> {
    await this.emitActivationEvent(
      new ActivationCancelledEvent(
        activation.commandId,
        activation.correlationId,
        activation.activationId,
        this.session,
        new Date().toISOString(),
        reason,
      ),
    );
  }

  private extractDisconnectStatusCode(error: unknown): number | undefined {
    if (!this.isRecord(error)) {
      return undefined;
    }

    const output = error.output;
    if (!this.isRecord(output) || typeof output.statusCode !== 'number') {
      return undefined;
    }

    return output.statusCode;
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (this.isRecord(error) && typeof error.message === 'string') {
      return error.message;
    }

    return '';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private buildDebugContentSuffix(
    rawMessage: any,
    normalized?: Message,
  ): string {
    if (!this.isDebugLoggingEnabled()) {
      return '';
    }

    const contentSummary = normalized?.content
      ? this.summarizeNormalizedContent(normalized.content)
      : this.summarizeRawContent(this.unwrapMessage(rawMessage?.message));

    if (!contentSummary) {
      return '';
    }

    return ` content=${JSON.stringify(contentSummary)}`;
  }

  private summarizeRawContent(content: any): Record<string, unknown> | null {
    if (!content || typeof content !== 'object') {
      return null;
    }

    if (content.conversation) {
      return {
        type: 'conversation',
        text: this.truncateDebugText(content.conversation),
      };
    }

    if (content.extendedTextMessage?.text) {
      return {
        type: 'extendedTextMessage',
        text: this.truncateDebugText(content.extendedTextMessage.text),
      };
    }

    if (content.imageMessage) {
      return {
        type: 'imageMessage',
        caption: this.truncateDebugText(content.imageMessage.caption),
        mimetype: content.imageMessage.mimetype,
      };
    }

    if (content.videoMessage) {
      return {
        type: 'videoMessage',
        caption: this.truncateDebugText(content.videoMessage.caption),
        mimetype: content.videoMessage.mimetype,
      };
    }

    if (content.documentMessage) {
      return {
        type: 'documentMessage',
        fileName: content.documentMessage.fileName,
        caption: this.truncateDebugText(content.documentMessage.caption),
        mimetype: content.documentMessage.mimetype,
      };
    }

    if (content.audioMessage) {
      return {
        type: 'audioMessage',
        seconds: content.audioMessage.seconds,
        mimetype: content.audioMessage.mimetype,
        ptt: content.audioMessage.ptt,
      };
    }

    if (content.stickerMessage) {
      return {
        type: 'stickerMessage',
        mimetype: content.stickerMessage.mimetype,
        isAnimated: content.stickerMessage.isAnimated,
      };
    }

    if (content.locationMessage) {
      return {
        type: 'locationMessage',
        name: content.locationMessage.name,
        address: content.locationMessage.address,
      };
    }

    if (content.contactMessage) {
      return {
        type: 'contactMessage',
        displayName: content.contactMessage.displayName,
      };
    }

    if (content.contactsArrayMessage) {
      return {
        type: 'contactsArrayMessage',
        count: Array.isArray(content.contactsArrayMessage.contacts)
          ? content.contactsArrayMessage.contacts.length
          : undefined,
      };
    }

    if (content.reactionMessage) {
      return {
        type: 'reactionMessage',
        text: content.reactionMessage.text,
      };
    }

    if (content.pollCreationMessage || content.pollCreationMessageV2 || content.pollCreationMessageV3) {
      const pollMessage =
        content.pollCreationMessage
        || content.pollCreationMessageV2
        || content.pollCreationMessageV3;

      return {
        type: 'pollCreationMessage',
        name: pollMessage.name,
        options: Array.isArray(pollMessage.options) ? pollMessage.options.length : undefined,
      };
    }

    return {
      type: this.describeMessageContentType(content),
    };
  }

  private summarizeNormalizedContent(
    content: MessageContent,
  ): Record<string, unknown> | null {
    if (content instanceof TextMessageContent) {
      return {
        type: MessageContentType.Text,
        text: this.truncateDebugText(content.text),
        title: this.truncateDebugText(content.title),
      };
    }

    if (
      content instanceof ImageMessageContent
      || content instanceof VideoMessageContent
      || content instanceof DocumentMessageContent
    ) {
      return {
        type: content.type,
        text: this.truncateDebugText(content.getTextBody()),
        mimeType: content.mimeType,
      };
    }

    if (content instanceof AudioMessageContent) {
      return {
        type: MessageContentType.Audio,
        durationSeconds: content.durationSeconds,
        voiceNote: content.voiceNote,
      };
    }

    if (content instanceof StickerMessageContent) {
      return {
        type: MessageContentType.Sticker,
        animated: content.animated,
      };
    }

    if (content instanceof ContactsMessageContent) {
      return {
        type: MessageContentType.Contacts,
        count: content.contacts.length,
        displayName: content.displayName,
      };
    }

    if (content instanceof LocationMessageContent) {
      return {
        type: MessageContentType.Location,
        latitude: content.latitude,
        longitude: content.longitude,
        live: content.live,
        name: content.name,
      };
    }

    if (content instanceof ReactionMessageContent) {
      return {
        type: MessageContentType.Reaction,
        messageId: content.targetMessage.messageId,
        text: content.reactionText,
        removed: content.removed,
      };
    }

    if (content instanceof PollMessageContent) {
      return {
        type: MessageContentType.Poll,
        name: this.truncateDebugText(content.name),
        options: content.options.length,
      };
    }

    if (content instanceof ButtonReplyMessageContent) {
      return {
        type: MessageContentType.ButtonReply,
        buttonId: content.buttonId,
        displayText: this.truncateDebugText(content.displayText),
        replyType: content.replyType,
      };
    }

    if (content instanceof ListReplyMessageContent) {
      return {
        type: MessageContentType.ListReply,
        selectedRowId: content.selectedRowId,
        title: this.truncateDebugText(content.title),
      };
    }

    if (content instanceof GroupInviteMessageContent) {
      return {
        type: MessageContentType.GroupInvite,
        groupJid: content.groupJid,
        groupName: content.groupName,
      };
    }

    if (content instanceof EventMessageContent) {
      return {
        type: MessageContentType.Event,
        name: this.truncateDebugText(content.name),
        startTimestamp: content.startTimestamp,
      };
    }

    if (content instanceof ProductMessageContent) {
      return {
        type: MessageContentType.Product,
        productId: content.productId,
        title: this.truncateDebugText(content.title),
      };
    }

    if (content instanceof InteractiveResponseMessageContent) {
      return {
        type: MessageContentType.InteractiveResponse,
        bodyText: this.truncateDebugText(content.bodyText),
        flowName: content.flowName,
      };
    }

    if (content instanceof InteractiveCarouselMessageContent) {
      return {
        type: MessageContentType.InteractiveCarousel,
        bodyText: this.truncateDebugText(content.bodyText),
        footerText: this.truncateDebugText(content.footerText),
        cardCount: content.cards.length,
      };
    }

    if (content instanceof DeleteMessageContent) {
      return {
        type: MessageContentType.Delete,
        messageId: content.targetMessage.messageId,
      };
    }

    if (content instanceof PinMessageContent) {
      return {
        type: MessageContentType.Pin,
        messageId: content.targetMessage.messageId,
        action: content.action,
        durationSeconds: content.durationSeconds,
      };
    }

    if (content instanceof DisappearingMessagesMessageContent) {
      return {
        type: MessageContentType.DisappearingMessages,
        expirationSeconds: content.expirationSeconds,
      };
    }

    if (content instanceof LimitSharingMessageContent) {
      return {
        type: MessageContentType.LimitSharing,
        sharingLimited: content.sharingLimited,
      };
    }

    return {
      type: content.type,
    };
  }

  private isDebugLoggingEnabled(): boolean {
    return env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace';
  }

  private truncateDebugText(value: unknown, maxLength = 280): string | undefined {
    if (typeof value !== 'string' || !value.length) {
      return undefined;
    }

    return value.length > maxLength
      ? `${value.slice(0, maxLength)}...`
      : value;
  }

  private unwrapMessage(message: any): any {
    if (!message) {
      return null;
    }

    if (message.ephemeralMessage?.message) {
      return this.unwrapMessage(message.ephemeralMessage.message);
    }

    if (message.viewOnceMessageV2?.message) {
      return this.unwrapMessage(message.viewOnceMessageV2.message);
    }

    if (message.viewOnceMessage?.message) {
      return this.unwrapMessage(message.viewOnceMessage.message);
    }

    if (message.documentWithCaptionMessage?.message) {
      return this.unwrapMessage(message.documentWithCaptionMessage.message);
    }

    if (message.editedMessage?.message?.protocolMessage?.editedMessage) {
      return this.unwrapMessage(message.editedMessage.message.protocolMessage.editedMessage);
    }

    return message;
  }
}
