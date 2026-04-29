import assert from 'node:assert/strict';
import test from 'node:test';
import { proto } from 'baileys';
import {
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
