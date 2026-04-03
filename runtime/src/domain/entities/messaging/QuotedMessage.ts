import { MessageContent } from './MessageContent.js';
import { MessageReference } from './MessageReference.js';

/**
 * Quoted message snapshot carried in WhatsApp context metadata.
 * The content is partial because quoted payloads frequently arrive without the original envelope.
 */
export class QuotedMessage {
  constructor(
    public readonly reference: MessageReference,
    public readonly content?: MessageContent,
  ) {}
}
