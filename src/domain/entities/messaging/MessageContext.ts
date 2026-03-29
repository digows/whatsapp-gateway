import { MessageReference } from './MessageReference.js';
import { QuotedMessage } from './QuotedMessage.js';

export enum ChatType {
  Direct = 'direct',
  Group = 'group',
  Broadcast = 'broadcast',
  Unknown = 'unknown',
}

export function parseChatType(value: string): ChatType {
  switch (value) {
    case ChatType.Direct:
      return ChatType.Direct;
    case ChatType.Group:
      return ChatType.Group;
    case ChatType.Broadcast:
      return ChatType.Broadcast;
    case ChatType.Unknown:
      return ChatType.Unknown;
    default:
      throw new Error(`Unsupported chat type "${value}".`);
  }
}

/**
 * Messaging metadata extracted from WhatsApp-specific envelopes.
 * JID-based fields stay raw so the infrastructure layer can keep exact WhatsApp addressing details.
 * `editTarget` identifies the message being edited when the content is sent as a WhatsApp edit.
 */
export class MessageContext {
  constructor(
    public readonly chatType: ChatType,
    public readonly remoteJid: string,
    public readonly participantId?: string,
    public readonly senderPhone?: string,
    public readonly mentionedJids: readonly string[] = [],
    public readonly quotedMessage?: QuotedMessage,
    public readonly editTarget?: MessageReference,
    public readonly forwarded = false,
    public readonly forwardingScore?: number,
    public readonly expirationSeconds?: number,
    public readonly viewOnce = false,
  ) {}
}
