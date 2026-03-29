import { SessionReference } from '../operational/SessionReference.js';
import { WhatsappMessage } from './WhatsappMessage.js';

export enum InboundEventType {
  MessageReceived = 'message.received',
  MessageUpdated = 'message.updated',
  MessageReaction = 'message.reaction',
}

export class ReceivedMessageEvent {
  public readonly eventType = InboundEventType.MessageReceived;

  constructor(
    public readonly session: SessionReference,
    public readonly timestamp: string,
    public readonly message: WhatsappMessage,
  ) {}
}

export class MessageUpdatedEvent {
  public readonly eventType = InboundEventType.MessageUpdated;

  constructor(
    public readonly session: SessionReference,
    public readonly timestamp: string,
    public readonly messageId: string,
    public readonly chatId: string,
    public readonly senderId: string,
    public readonly fromMe: boolean,
    public readonly status?: number,
    public readonly stubType?: number,
    public readonly contentType?: string,
    public readonly pollUpdateCount?: number,
  ) {}
}

export class MessageReactionEvent {
  public readonly eventType = InboundEventType.MessageReaction;

  constructor(
    public readonly session: SessionReference,
    public readonly timestamp: string,
    public readonly chatId: string,
    public readonly senderId: string,
    public readonly fromMe: boolean,
    public readonly removed: boolean,
    public readonly messageId?: string,
    public readonly reactionText?: string,
  ) {}
}

export type InboundEvent =
  | ReceivedMessageEvent
  | MessageUpdatedEvent
  | MessageReactionEvent;
