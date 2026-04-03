import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatType } from '../src/domain/entities/messaging/MessageContext.js';
import {
  DeleteMessageContent,
  DisappearingMessagesMessageContent,
  LimitSharingMessageContent,
  LocationMessageContent,
  PinMessageAction,
  PinMessageContent,
  ReactionMessageContent,
  SharePhoneNumberMessageContent,
  TextMessageContent,
} from '../src/domain/entities/messaging/MessageContent.js';
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
  assert.ok(normalized?.content instanceof TextMessageContent);
  assert.equal(normalized?.content.text, 'hello world');
  assert.equal(normalized?.context?.chatType, ChatType.Direct);
  assert.equal(normalized?.context?.remoteJid, '5511999999999@s.whatsapp.net');
  assert.equal(normalized?.context?.senderPhone, '+5511999999999');
});

test('BaileysMessageNormalizer extracts mentions and quoted message context', async () => {
  const normalized = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511888888888@s.whatsapp.net',
        id: 'message-quoted-1',
      },
      messageTimestamp: 1_710_000_100,
      message: {
        extendedTextMessage: {
          text: 'reply body',
          contextInfo: {
            mentionedJid: ['5511777777777@s.whatsapp.net'],
            stanzaId: 'quoted-1',
            participant: '5511666666666@s.whatsapp.net',
            remoteJid: '5511888888888@s.whatsapp.net',
            quotedMessage: {
              conversation: 'original text',
            },
            isForwarded: true,
            forwardingScore: 2,
            expiration: 3600,
          },
        },
      },
    },
    async jid => {
      if (jid === '5511888888888@s.whatsapp.net') {
        return '+5511888888888';
      }

      return null;
    },
  );

  assert.ok(normalized);
  assert.ok(normalized?.content instanceof TextMessageContent);
  assert.deepEqual(normalized?.context?.mentionedJids, ['5511777777777@s.whatsapp.net']);
  assert.equal(normalized?.context?.forwarded, true);
  assert.equal(normalized?.context?.forwardingScore, 2);
  assert.equal(normalized?.context?.expirationSeconds, 3600);
  assert.equal(normalized?.context?.quotedMessage?.reference.messageId, 'quoted-1');
  assert.ok(normalized?.context?.quotedMessage?.content instanceof TextMessageContent);
  assert.equal(normalized?.context?.quotedMessage?.content.text, 'original text');
});

test('BaileysMessageNormalizer extracts the edit target from edited message envelopes', async () => {
  const normalized = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'edit-envelope-1',
      },
      messageTimestamp: 1_710_000_150,
      message: {
        editedMessage: {
          message: {
            protocolMessage: {
              type: 14,
              key: {
                id: 'target-edit-1',
                remoteJid: '5511999999999@s.whatsapp.net',
              },
              editedMessage: {
                conversation: 'edited text',
              },
            },
          },
        },
      },
    },
    async () => null,
  );

  assert.ok(normalized);
  assert.ok(normalized?.content instanceof TextMessageContent);
  assert.equal(normalized?.content.text, 'edited text');
  assert.equal(normalized?.context?.editTarget?.messageId, 'target-edit-1');
});

test('BaileysMessageNormalizer normalizes location and reaction payloads', async () => {
  const location = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'location-1',
      },
      messageTimestamp: 1_710_000_200,
      message: {
        locationMessage: {
          degreesLatitude: -23.5505,
          degreesLongitude: -46.6333,
          name: 'Sao Paulo',
          address: 'Downtown',
        },
      },
    },
    async () => null,
  );

  assert.ok(location?.content instanceof LocationMessageContent);
  assert.equal(location?.content.latitude, -23.5505);
  assert.equal(location?.content.longitude, -46.6333);
  assert.equal(location?.content.name, 'Sao Paulo');

  const reaction = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'reaction-1',
      },
      messageTimestamp: 1_710_000_201,
      message: {
        reactionMessage: {
          key: {
            id: 'target-1',
            remoteJid: '5511999999999@s.whatsapp.net',
          },
          text: '🔥',
        },
      },
    },
    async () => null,
  );

  assert.ok(reaction?.content instanceof ReactionMessageContent);
  assert.equal(reaction?.content.targetMessage.messageId, 'target-1');
  assert.equal(reaction?.content.reactionText, '🔥');

  const removedReaction = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'reaction-removed-1',
      },
      messageTimestamp: 1_710_000_202,
      message: {
        reactionMessage: {
          key: {
            id: 'target-1',
            remoteJid: '5511999999999@s.whatsapp.net',
          },
          text: '',
        },
      },
    },
    async () => null,
  );

  assert.ok(removedReaction?.content instanceof ReactionMessageContent);
  assert.equal(removedReaction?.content.targetMessage.messageId, 'target-1');
  assert.equal(removedReaction?.content.removed, true);
  assert.equal(removedReaction?.content.reactionText, undefined);
});

test('BaileysMessageNormalizer normalizes supported protocol and pin payloads', async () => {
  const deletedMessage = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'message-2',
      },
      message: {
        protocolMessage: {
          type: 0,
          key: {
            id: 'target-delete-1',
            remoteJid: '5511999999999@s.whatsapp.net',
          },
        },
      },
    },
    async () => null,
  );

  assert.ok(deletedMessage?.content instanceof DeleteMessageContent);
  assert.equal(deletedMessage?.content.targetMessage.messageId, 'target-delete-1');

  const pinMessage = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@g.us',
        id: 'pin-1',
      },
      message: {
        pinInChatMessage: {
          key: {
            id: 'target-pin-1',
            remoteJid: '5511999999999@g.us',
          },
          type: 1,
        },
        messageContextInfo: {
          messageAddOnDurationInSecs: 86400,
        },
      },
    },
    async () => null,
  );

  assert.ok(pinMessage?.content instanceof PinMessageContent);
  assert.equal(pinMessage?.content.targetMessage.messageId, 'target-pin-1');
  assert.equal(pinMessage?.content.action, PinMessageAction.PinForAll);
  assert.equal(pinMessage?.content.durationSeconds, 86400);

  const sharePhoneNumberMessage = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'share-phone-1',
      },
      message: {
        protocolMessage: {
          type: 11,
        },
      },
    },
    async () => null,
  );

  assert.ok(sharePhoneNumberMessage?.content instanceof SharePhoneNumberMessageContent);

  const limitSharingMessage = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'limit-sharing-1',
      },
      message: {
        protocolMessage: {
          type: 27,
          limitSharing: {
            sharingLimited: true,
            limitSharingSettingTimestamp: 1_710_000_300,
            initiatedByMe: true,
          },
        },
      },
    },
    async () => null,
  );

  assert.ok(limitSharingMessage?.content instanceof LimitSharingMessageContent);
  assert.equal(limitSharingMessage?.content.sharingLimited, true);
  assert.equal(limitSharingMessage?.content.updatedTimestamp, 1_710_000_300);

  const disappearingMessage = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@g.us',
        id: 'disappearing-1',
      },
      message: {
        protocolMessage: {
          type: 3,
          ephemeralExpiration: 604800,
        },
      },
    },
    async () => null,
  );

  assert.ok(disappearingMessage?.content instanceof DisappearingMessagesMessageContent);
  assert.equal(disappearingMessage?.content.expirationSeconds, 604800);
});

test('BaileysMessageNormalizer skips unsupported protocol messages', async () => {
  const normalized = await BaileysMessageNormalizer.normalize(
    {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        id: 'message-unsupported-protocol',
      },
      message: {
        protocolMessage: {
          type: 6,
        },
      },
    },
    async () => null,
  );

  assert.equal(normalized, null);
  assert.equal(
    BaileysMessageNormalizer.getSkipReason({
      protocolMessage: {
        type: 6,
      },
    }),
    'protocol_message',
  );
});
