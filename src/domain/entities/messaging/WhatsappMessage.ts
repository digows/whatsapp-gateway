import { MessageContent } from './MessageContent.js';
import { WhatsappMessageContext } from './WhatsappMessageContext.js';

export class WhatsappMessage {
  constructor(
    public readonly chatId: string,
    public readonly timestamp: string,
    public readonly content: MessageContent,
    public readonly messageId?: string,
    public readonly senderId?: string,
    public readonly participantId?: string,
    public readonly context?: WhatsappMessageContext,
  ) {}
}
