import { proto } from 'baileys';
import { getConfig, normalizeRecipientToJid, readArgument } from './config.js';
import { createImageMessageForInteractiveCard, relayProtoMessage } from './message-relay.js';
import { closeSocket, createConnectedSocket } from './socket.js';
import { waitForAck } from './wait-for-ack.js';

function buildCardButton(displayText, buttonId)
{
  return {
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: displayText,
      id: buttonId,
    }),
  };
}

function buildCarouselCard(imageMessage, title, description, buttonText, buttonId)
{
  return {
    header: {
      hasMediaAttachment: true,
      imageMessage,
      title,
    },
    body: {
      text: description,
    },
    nativeFlowMessage: {
      messageVersion: 1,
      buttons: [buildCardButton(buttonText, buttonId)],
    },
  };
}

async function main()
{
  const config = getConfig();
  const recipientArgument = readArgument('to');
  const recipientJid = normalizeRecipientToJid(recipientArgument || config.target);
  const ackLevel = readArgument('ack') || 'server';
  const ackTimeoutMs = Number(readArgument('ack-timeout-ms') || 30000);

  const image1 = readArgument('image1') || config.cardImage1Url;
  const image2 = readArgument('image2') || config.cardImage2Url;

  if (!image1 || !image2)
  {
    throw new Error('Two image sources are required. Set WA_CARD_IMAGE_1_URL and WA_CARD_IMAGE_2_URL or pass --image1 and --image2.');
  }

  const socket = await createConnectedSocket(config.authDirectory, config.logLevel);

  try
  {
    const cardImage1 = await createImageMessageForInteractiveCard(socket, recipientJid, image1);
    const cardImage2 = await createImageMessageForInteractiveCard(socket, recipientJid, image2);

    const card1 = buildCarouselCard(
      cardImage1,
      'Sport Watch',
      'Model S1 with GPS and water resistance.',
      'See Sport Watch',
      'card_watch_s1',
    );

    const card2 = buildCarouselCard(
      cardImage2,
      'Wireless Headphones',
      'Model H2 with active noise cancellation.',
      'See Headphones',
      'card_headphones_h2',
    );

    const interactiveMessage = proto.Message.InteractiveMessage.create({
      body: {
        text: 'Product showcase',
      },
      footer: {
        text: 'Swipe cards and choose one product',
      },
      carouselMessage: {
        messageVersion: 1,
        carouselCardType: proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType.HSCROLL_CARDS,
        cards: [card1, card2],
      },
    });

    const messageId = await relayProtoMessage(socket, recipientJid, {
      interactiveMessage,
    });

    console.log(`[send:interactive:carousel] Sent to ${recipientJid} with message id: ${messageId}`);
    console.log(`[send:interactive:carousel] Waiting for ${ackLevel.toUpperCase()} ACK (timeout: ${ackTimeoutMs}ms)...`);

    const ackResult = await waitForAck(
      socket,
      {
        id: messageId,
        remoteJid: recipientJid,
      },
      {
        ackLevel,
        timeoutMs: ackTimeoutMs,
      },
    );

    console.log(`[send:interactive:carousel] ACK confirmed: ${ackResult.statusName}`);
  }
  finally
  {
    await closeSocket(socket);
  }
}

main().catch(error =>
{
  console.error('[send:interactive:carousel] Failed:', error);
  process.exit(1);
});
