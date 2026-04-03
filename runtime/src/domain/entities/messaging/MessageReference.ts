/**
 * WhatsApp message identifier used by reply, reaction and other content that targets
 * an existing message.
 */
export class MessageReference {
  constructor(
    public readonly messageId: string,
    public readonly remoteJid?: string,
    public readonly participantId?: string,
  ) {
    if (!messageId.trim()) {
      throw new Error('MessageReference requires a non-empty messageId.');
    }
  }
}
