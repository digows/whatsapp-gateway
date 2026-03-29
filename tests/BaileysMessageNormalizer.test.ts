import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageContentType } from '../src/domain/entities/messaging/MessageContentType.js';
import { ChatType } from '../src/domain/entities/messaging/WhatsappMessageContext.js';
import { BaileysMessageNormalizer } from '../src/infrastructure/baileys/BaileysMessageNormalizer.js';

test('BaileysMessageNormalizer normalizes a direct text WhatsApp message', async () => {
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
    async jid => {
      if (jid === '5511999999999@s.whatsapp.net') {
        return '+5511999999999';
      }

      return null;
    },
  );

  assert.ok(normalized);
  assert.equal(normalized?.messageId, 'message-1');
  assert.equal(normalized?.chatId, '+5511999999999');
  assert.equal(normalized?.senderId, '+5511999999999');
  assert.equal(normalized?.timestamp, new Date(1_710_000_000 * 1000).toISOString());
  assert.equal(normalized?.content.type, MessageContentType.Text);
  assert.equal(normalized?.content.text, 'hello world');
  assert.equal(normalized?.context?.chatType, ChatType.Direct);
  assert.equal(normalized?.context?.remoteJid, '5511999999999@s.whatsapp.net');
  assert.equal(normalized?.context?.senderPhone, '+5511999999999');
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
