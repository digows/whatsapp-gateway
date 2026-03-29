export enum ChatType {
  Direct = 'direct',
  Group = 'group',
  Broadcast = 'broadcast',
  Unknown = 'unknown',
}

export class WhatsappMessageContext {
  constructor(
    public readonly chatType: ChatType,
    public readonly remoteJid: string,
    public readonly participantId?: string,
    public readonly senderPhone?: string,
  ) {}
}
