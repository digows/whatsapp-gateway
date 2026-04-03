import { MessageContent } from './MessageContent.js';
import { MessageContext } from './MessageContext.js';

/**
 * Canonical message representation used across the gateway.
 * Direction is defined by the command/event that carries the message, not by the entity itself.
 */
export class Message {
  constructor(
    public readonly chatId: string,
    public readonly timestamp: string,
    public readonly content: MessageContent,
    public readonly messageId?: string,
    public readonly senderId?: string,
    public readonly participantId?: string,
    public readonly context?: MessageContext,
  ) {}
}
