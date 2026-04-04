import assert from 'node:assert/strict';
import test from 'node:test';
import { PresenceCommand, PresenceCommandAction, PresenceType } from '../src/domain/entities/command/OutboundCommand.js';
import { EventMessageContent, PinMessageContent, TextMessageContent } from '../src/domain/entities/messaging/MessageContent.js';
import { NatsChannelTransport } from '../src/infrastructure/nats/NatsChannelTransport.js';

test('NatsChannelTransport treats null optional outbound objects as absent', () => {
  const transport = new NatsChannelTransport('whatsapp-web') as any;

  const command = transport.parseSendMessageCommand({
    commandId: 'command-1',
    session: {
      provider: 'whatsapp-web',
      workspaceId: 1,
      sessionId: 'primary',
    },
    message: {
      chatId: '5511999999999@s.whatsapp.net',
      timestamp: '2026-04-04T00:00:00Z',
      content: {
        type: 'text',
        text: 'hello',
      },
      context: null,
    },
  });

  assert.ok(command.message.content instanceof TextMessageContent);
  assert.equal(command.message.context, undefined);
});

test('NatsChannelTransport accepts null on optional nested outbound fields', () => {
  const transport = new NatsChannelTransport('whatsapp-web') as any;

  const command = transport.parseSendMessageCommand({
    commandId: 'command-2',
    session: {
      provider: 'whatsapp-web',
      workspaceId: 1,
      sessionId: 'primary',
    },
    message: {
      chatId: '120363000000000000@g.us',
      timestamp: '2026-04-04T00:00:10Z',
      content: {
        type: 'pin',
        targetMessage: {
          messageId: 'wamid-target-pin',
          remoteJid: '120363000000000000@g.us',
          participantId: null,
        },
        action: 'pin_for_all',
        durationSeconds: null,
      },
      context: {
        chatType: 'group',
        remoteJid: '120363000000000000@g.us',
        participantId: null,
        senderPhone: null,
        mentionedJids: null,
        quotedMessage: {
          reference: {
            messageId: 'wamid-quoted',
            remoteJid: '120363000000000000@g.us',
            participantId: null,
          },
          content: null,
        },
        editTarget: null,
        forwarded: null,
        forwardingScore: null,
        expirationSeconds: null,
        viewOnce: null,
      },
    },
  });

  assert.ok(command.message.content instanceof PinMessageContent);
  assert.equal(command.message.content.durationSeconds, undefined);
  assert.ok(command.message.context);
  assert.deepEqual(command.message.context.mentionedJids, []);
  assert.ok(command.message.context.quotedMessage);
  assert.equal(command.message.context.quotedMessage.content, undefined);
  assert.equal(command.message.context.editTarget, undefined);
  assert.equal(command.message.context.participantId, undefined);
  assert.equal(command.message.context.senderPhone, undefined);
});

test('NatsChannelTransport accepts null optional event location payloads', () => {
  const transport = new NatsChannelTransport('whatsapp-web') as any;

  const command = transport.parseSendMessageCommand({
    commandId: 'command-3',
    session: {
      provider: 'whatsapp-web',
      workspaceId: 1,
      sessionId: 'primary',
    },
    message: {
      chatId: '120363000000000000@g.us',
      timestamp: '2026-04-04T00:00:20Z',
      content: {
        type: 'event',
        name: 'Support Call',
        location: null,
      },
    },
  });

  assert.ok(command.message.content instanceof EventMessageContent);
  assert.equal(command.message.content.location, undefined);
});

test('NatsChannelTransport parses presence commands on the shared outgoing rail', () => {
  const transport = new NatsChannelTransport('whatsapp-web') as any;

  const command = transport.parseOutboundCommand({
    family: 'presence',
    action: 'update',
    commandId: 'command-4',
    session: {
      provider: 'whatsapp-web',
      workspaceId: 1,
      sessionId: 'primary',
    },
    chatId: '5511999999999@s.whatsapp.net',
    presence: 'composing',
  });

  assert.ok(command instanceof PresenceCommand);
  assert.equal(command.action, PresenceCommandAction.Update);
  assert.equal(command.presence, PresenceType.Composing);
});
