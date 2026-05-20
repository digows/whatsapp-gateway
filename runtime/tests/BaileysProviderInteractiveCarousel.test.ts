import assert from 'node:assert/strict';
import test from 'node:test';
import { proto } from 'baileys';
import {
  ImageMessageContent,
  InteractiveCarouselCardContent,
  InteractiveCarouselMessageContent,
  InteractiveCarouselNativeFlowButton,
  InteractiveCarouselNativeFlowMessageContent,
} from '../src/domain/entities/messaging/MessageContent.js';
import { BaileysProvider } from '../src/infrastructure/baileys/BaileysProvider.js';

test('BaileysProvider builds a view-once interactive carousel message', async () => {
  const provider = Object.create(BaileysProvider.prototype) as BaileysProvider;
  const content = new InteractiveCarouselMessageContent(
    'Featured products',
    'Swipe the cards',
    [
      new InteractiveCarouselCardContent(
        'Watch S1',
        'Water resistant',
        undefined,
        'Premium smartwatch',
        'Available now',
        new InteractiveCarouselNativeFlowMessageContent([
          new InteractiveCarouselNativeFlowButton(
            'quick_reply',
            JSON.stringify({
              display_text: 'Buy watch',
              id: 'buy_watch',
            }),
          ),
        ]),
      ),
    ],
  );

  const waMessage = await (provider as any).buildInteractiveCarouselWAMessage(
    '5511999999999@s.whatsapp.net',
    content,
    async () => ({
      imageMessage: {
        mimetype: 'image/jpeg',
        width: 1080,
        height: 1080,
      },
    }),
  );

  assert.equal(waMessage.message.viewOnceMessage.message.interactiveMessage.carouselMessage.carouselCardType, proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType.HSCROLL_CARDS);
  assert.equal(waMessage.message.viewOnceMessage.message.interactiveMessage.body.text, 'Featured products');
  assert.equal(waMessage.message.viewOnceMessage.message.interactiveMessage.footer.text, 'Swipe the cards');
  assert.equal(waMessage.message.viewOnceMessage.message.interactiveMessage.carouselMessage.cards.length, 1);
  assert.equal(waMessage.message.viewOnceMessage.message.interactiveMessage.carouselMessage.cards[0].header.title, 'Watch S1');
  assert.equal(waMessage.message.viewOnceMessage.message.interactiveMessage.carouselMessage.cards[0].nativeFlowMessage.buttons[0].name, 'quick_reply');
});

test('BaileysProvider retries interactive carousel without header media when remote fetch fails', async () => {
  const provider = Object.create(BaileysProvider.prototype) as BaileysProvider & {
    sock: {
      relayMessage: (jid: string, message: unknown, options: { messageId: string }) => Promise<void>;
    };
  };

  const content = new InteractiveCarouselMessageContent(
    'Featured products',
    'Swipe the cards',
    [
      new InteractiveCarouselCardContent(
        'iPhone 16',
        '128 GB',
        new ImageMessageContent(undefined, 'https://example.com/iphone.jpg'),
        'Available now',
        'Store pickup available',
        new InteractiveCarouselNativeFlowMessageContent([
          new InteractiveCarouselNativeFlowButton(
            'quick_reply',
            JSON.stringify({
              display_text: 'See details',
              id: 'see_details',
            }),
          ),
        ]),
      ),
    ],
  );

  const relayCalls: Array<{ jid: string; options: { messageId: string } }> = [];
  provider.sock = {
    relayMessage: async (jid, _message, options) => {
      relayCalls.push({ jid, options });
    },
  };

  let buildCalls = 0;
  (provider as any).buildInteractiveCarouselWAMessage = async (
    recipientJid: string,
    carousel: InteractiveCarouselMessageContent,
    headerMediaBuilder?: (jid: string, media: ImageMessageContent) => Promise<unknown>,
  ) => {
    buildCalls += 1;

    assert.equal(recipientJid, '5511999999999@s.whatsapp.net');
    assert.equal(carousel, content);

    if (buildCalls === 1) {
      const error = new Error('Failed to fetch remote media');
      error.name = 'RemoteMediaFetchError';
      throw error;
    }

    assert.equal(
      await headerMediaBuilder?.(
        '5511999999999@s.whatsapp.net',
        new ImageMessageContent(undefined, 'https://example.com/iphone.jpg'),
      ),
      undefined,
    );

    return {
      key: { id: 'fallback-message-id' },
      message: {
        viewOnceMessage: {
          message: {
            interactiveMessage: {},
          },
        },
      },
    };
  };

  const messageId = await (provider as any).sendInteractiveCarousel(
    '5511999999999@s.whatsapp.net',
    content,
  );

  assert.equal(messageId, 'fallback-message-id');
  assert.equal(buildCalls, 2);
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].jid, '5511999999999@s.whatsapp.net');
  assert.equal(relayCalls[0].options.messageId, 'fallback-message-id');
});
