import { SessionReference } from '../operational/SessionReference.js';
import { WhatsappMessage } from './WhatsappMessage.js';

export class SendMessageCommand {
  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly message: WhatsappMessage,
  ) {}
}
