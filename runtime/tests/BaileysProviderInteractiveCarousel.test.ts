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

  assert.equal(waMessage.message.interactiveMessage.carouselMessage.carouselCardType, proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType.HSCROLL_CARDS);
  assert.equal(waMessage.message.interactiveMessage.body.text, 'Featured products');
  assert.equal(waMessage.message.interactiveMessage.footer.text, 'Swipe the cards');
  assert.equal(waMessage.message.interactiveMessage.carouselMessage.cards.length, 1);
  assert.equal(waMessage.message.interactiveMessage.carouselMessage.cards[0].header.title, 'Watch S1');
  assert.equal(waMessage.message.interactiveMessage.carouselMessage.cards[0].nativeFlowMessage.buttons[0].name, 'quick_reply');
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
            'cta_url',
            JSON.stringify({
              display_text: 'See details',
              url: 'https://example.com/iphone',
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
    // All cards already use cta_url so the compatibility filter is a no-op and the
    // carousel reference passed through is the same instance the caller supplied.
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
        interactiveMessage: {},
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

test('BaileysProvider drops carousel cards whose buttons are not all cta_url before relaying', async () => {
  const provider = Object.create(BaileysProvider.prototype) as BaileysProvider & {
    sock: {
      relayMessage: (jid: string, message: unknown, options: { messageId: string }) => Promise<void>;
    };
  };

  const goodCard = new InteractiveCarouselCardContent(
    'iPhone 16',
    undefined,
    new ImageMessageContent(undefined, 'https://example.com/iphone.jpg'),
    'Available now',
    'Cellshop',
    new InteractiveCarouselNativeFlowMessageContent([
      new InteractiveCarouselNativeFlowButton(
        'cta_url',
        JSON.stringify({ display_text: 'Ver', url: 'https://example.com/iphone' }),
      ),
    ]),
  );
  const badCard = new InteractiveCarouselCardContent(
    'Perfume',
    undefined,
    new ImageMessageContent(undefined, 'https://example.com/perfume.jpg'),
    'Available now',
    'New Zone',
    new InteractiveCarouselNativeFlowMessageContent([
      new InteractiveCarouselNativeFlowButton(
        'quick_reply',
        JSON.stringify({ display_text: 'Ver', id: 'see_perfume' }),
      ),
    ]),
  );
  const content = new InteractiveCarouselMessageContent(
    'Featured',
    undefined,
    [goodCard, badCard],
  );

  const relayCalls: Array<{ jid: string; options: { messageId: string } }> = [];
  provider.sock = {
    relayMessage: async (jid, _message, options) => {
      relayCalls.push({ jid, options });
    },
  };

  let lastCarouselPassedToBuilder: InteractiveCarouselMessageContent | undefined;
  (provider as any).buildInteractiveCarouselWAMessage = async (
    _recipientJid: string,
    carousel: InteractiveCarouselMessageContent,
  ) => {
    lastCarouselPassedToBuilder = carousel;
    return {
      key: { id: 'filtered-message-id' },
      message: { interactiveMessage: {} },
    };
  };

  const messageId = await (provider as any).sendInteractiveCarousel(
    '5511999999999@s.whatsapp.net',
    content,
  );

  assert.equal(messageId, 'filtered-message-id');
  assert.equal(relayCalls.length, 1);
  // The quick_reply card was dropped; only the cta_url card reached the builder.
  assert.ok(lastCarouselPassedToBuilder);
  assert.equal(lastCarouselPassedToBuilder!.cards.length, 1);
  assert.equal(lastCarouselPassedToBuilder!.cards[0].headerTitle, 'iPhone 16');
});

test('BaileysProvider rejects carousels where every card has only non-cta_url buttons', async () => {
  const provider = Object.create(BaileysProvider.prototype) as BaileysProvider & {
    sock: {
      relayMessage: (jid: string, message: unknown, options: { messageId: string }) => Promise<void>;
    };
  };

  const content = new InteractiveCarouselMessageContent(
    'Featured',
    undefined,
    [
      new InteractiveCarouselCardContent(
        'Perfume A',
        undefined,
        new ImageMessageContent(undefined, 'https://example.com/a.jpg'),
        'Body A',
        'New Zone',
        new InteractiveCarouselNativeFlowMessageContent([
          new InteractiveCarouselNativeFlowButton(
            'quick_reply',
            JSON.stringify({ display_text: 'Ver', id: 'a' }),
          ),
        ]),
      ),
      new InteractiveCarouselCardContent(
        'Perfume B',
        undefined,
        new ImageMessageContent(undefined, 'https://example.com/b.jpg'),
        'Body B',
        'New Zone',
        new InteractiveCarouselNativeFlowMessageContent([
          new InteractiveCarouselNativeFlowButton(
            'quick_reply',
            JSON.stringify({ display_text: 'Ver', id: 'b' }),
          ),
        ]),
      ),
    ],
  );

  let relayed = false;
  provider.sock = {
    relayMessage: async () => {
      relayed = true;
    },
  };

  await assert.rejects(
    (provider as any).sendInteractiveCarousel('5511999999999@s.whatsapp.net', content),
    /every card uses a non-cta_url button/,
  );
  assert.equal(relayed, false);
});
