import { SessionReference } from '../operational/SessionReference.js';
import { Message } from './Message.js';
import { MessageContentType } from './MessageContentType.js';
import { MessageReference } from './MessageReference.js';

export enum InboundEventType {
  MessageCreated = 'message.created',
  MessageUpdated = 'message.updated',
  MessageDeleted = 'message.deleted',
}

/**
 * Classifies which part of a WhatsApp message lifecycle changed.
 * More than one kind may be present in the same update event because Baileys can batch
 * status, stub and poll changes together.
 */
export enum MessageUpdateKind {
  Content = 'content',
  Status = 'status',
  Stub = 'stub',
  Poll = 'poll',
  Reaction = 'reaction',
}

export function parseMessageUpdateKind(value: string): MessageUpdateKind {
  switch (value) {
    case MessageUpdateKind.Content:
      return MessageUpdateKind.Content;
    case MessageUpdateKind.Status:
      return MessageUpdateKind.Status;
    case MessageUpdateKind.Stub:
      return MessageUpdateKind.Stub;
    case MessageUpdateKind.Poll:
      return MessageUpdateKind.Poll;
    case MessageUpdateKind.Reaction:
      return MessageUpdateKind.Reaction;
    default:
      throw new Error(`Unsupported message update kind "${value}".`);
  }
}

/**
 * Emitted when the session observes a newly created WhatsApp message in the timeline.
 * The payload is always normalized to the canonical domain `Message`.
 */
export class MessageCreatedEvent {
  public readonly eventType = InboundEventType.MessageCreated;

  constructor(
    public readonly session: SessionReference,
    public readonly timestamp: string,
    public readonly message: Message,
    public readonly fromMe: boolean,
  ) {}
}

/**
 * Emitted when an existing message changes after creation.
 * `targetMessage` points to the logical WhatsApp message being updated.
 * `message` is present when the update carries a normalized payload, such as an edit.
 * Reaction deltas are also modeled as updates so consumers can handle the full lifecycle
 * through created/updated/deleted without a fourth top-level event category.
 */
export class MessageUpdatedEvent {
  public readonly eventType = InboundEventType.MessageUpdated;

  constructor(
    public readonly session: SessionReference,
    public readonly timestamp: string,
    public readonly targetMessage: MessageReference,
    public readonly chatId: string,
    public readonly senderId: string,
    public readonly fromMe: boolean,
    public readonly updateKinds: readonly MessageUpdateKind[],
    public readonly message?: Message,
    public readonly status?: number,
    public readonly stubType?: number,
    public readonly contentType?: MessageContentType,
    public readonly pollUpdateCount?: number,
    public readonly reactionText?: string,
    public readonly reactionRemoved?: boolean,
  ) {}
}

/**
 * Emitted when WhatsApp revokes an existing message from the chat timeline.
 * `message` preserves the normalized delete envelope when the provider can supply it.
 */
export class MessageDeletedEvent {
  public readonly eventType = InboundEventType.MessageDeleted;

  constructor(
    public readonly session: SessionReference,
    public readonly timestamp: string,
    public readonly targetMessage: MessageReference,
    public readonly chatId: string,
    public readonly senderId: string,
    public readonly fromMe: boolean,
    public readonly message?: Message,
  ) {}
}

export type InboundEvent =
  | MessageCreatedEvent
  | MessageUpdatedEvent
  | MessageDeletedEvent;
