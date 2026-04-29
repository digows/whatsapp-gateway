import { proto } from 'baileys';
import { getConfig, normalizeRecipientToJid, readArgument } from './config.js';
import { relayProtoMessage } from './message-relay.js';
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

function buildSingleButtonCard(body, footer, button1Text, button1Id, button2Text, button2Id)
{
  return {
    body: {
      text: body,
    },
    footer: {
      text: footer,
    },
    nativeFlowMessage: {
      messageVersion: 1,
      buttons: [
        buildCardButton(button1Text, button1Id),
        buildCardButton(button2Text, button2Id),
      ],
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
  const body = readArgument('body') || 'Choose one option';
  const footer = readArgument('footer') || 'Native flow button POC';
  const button1Text = readArgument('button1-text') || 'Sport Watch';
  const button1Id = readArgument('button1-id') || 'btn1';
  const button2Text = readArgument('button2-text') || 'Wireless Headphones';
  const button2Id = readArgument('button2-id') || 'btn2';

  const socket = await createConnectedSocket(config.authDirectory, config.logLevel);

  try
  {
    const card = buildSingleButtonCard(body, footer, button1Text, button1Id, button2Text, button2Id);

    const interactiveMessage = proto.Message.InteractiveMessage.create({
      body: {
        text: body,
      },
      footer: {
        text: footer,
      },
      carouselMessage: {
        messageVersion: 1,
        carouselCardType: proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType.HSCROLL_CARDS,
        cards: [card],
      },
    });

    const protoMessage = {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage,
        },
      },
    };

    const messageId = await relayProtoMessage(socket, recipientJid, protoMessage);

    console.log(`[send:interactive:button] Sent to ${recipientJid} with message id: ${messageId}`);
    console.log(`[send:interactive:button] Waiting for ${ackLevel.toUpperCase()} ACK (timeout: ${ackTimeoutMs}ms)...`);

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

    console.log(`[send:interactive:button] ACK confirmed: ${ackResult.statusName}`);
  }
  finally
  {
    await closeSocket(socket);
  }
}

main().catch(error =>
{
  console.error('[send:interactive:button] Failed:', error);
  process.exit(1);
});
