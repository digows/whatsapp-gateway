import { OutboundCommand, OutboundCommandFamily } from '../command/OutboundCommand.js';
import { SessionReference } from '../operational/SessionReference.js';
import { Message } from './Message.js';

/**
 * Application command that asks a session runtime to send one message.
 */
export class SendMessageCommand implements OutboundCommand {
  public readonly family = OutboundCommandFamily.Message;
  public readonly action = 'send';

  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly message: Message,
  ) {}
}
