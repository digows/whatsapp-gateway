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
 * Messaging metadata extracted from WhatsApp-specific addressing details.
 */
export class MessageContext {
  constructor(
    public readonly chatType: ChatType,
    public readonly remoteJid: string,
    public readonly participantId?: string,
    public readonly senderPhone?: string,
  ) {}
}
