import assert from 'node:assert/strict';
import test from 'node:test';
import { BaileysMessageNormalizer } from '../src/infrastructure/baileys/BaileysMessageNormalizer.js';

test('BaileysMessageNormalizer normalizes a direct text message into the local contract', async () => {
  const normalized = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'message-1',
      },
      messageTimestamp: 1_710_000_000,
      message: {
        conversation: 'hello world',
      },
    },
    7,
    'session-a',
    async jid => {
      if (jid === '5511999999999@s.whatsapp.net') {
        return '+5511999999999';
      }

      return null;
    },
  );

  assert.deepEqual(normalized, {
    messageId: 'message-1',
    chatId: '+5511999999999',
    senderId: '+5511999999999',
    participantId: undefined,
    workspaceId: 7,
    sessionId: 'session-a',
    timestamp: new Date(1_710_000_000 * 1000).toISOString(),
    content: {
      type: 'text',
      text: 'hello world',
    },
    context: {
      chatType: 'direct',
      remoteJid: '5511999999999@s.whatsapp.net',
      participantId: undefined,
      senderPhone: '+5511999999999',
    },
  });
});

test('BaileysMessageNormalizer skips protocol messages', async () => {
  const normalized = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'message-2',
      },
      message: {
        protocolMessage: {
          type: 0,
        },
      },
    },
    7,
    'session-a',
    async () => null,
  );

  assert.equal(normalized, null);
  assert.equal(
    BaileysMessageNormalizer.getSkipReason({
      protocolMessage: {
        type: 0,
      },
    }),
    'protocol_message',
  );
});
