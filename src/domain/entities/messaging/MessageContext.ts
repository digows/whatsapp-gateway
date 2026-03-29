export enum ChatType {
  Direct = 'direct',
  Group = 'group',
  Broadcast = 'broadcast',
  Unknown = 'unknown',
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
