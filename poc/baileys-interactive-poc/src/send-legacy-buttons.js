import { proto } from 'baileys';
import { getConfig, normalizeRecipientToJid, readArgument } from './config.js';
import { relayProtoMessage } from './message-relay.js';
import { closeSocket, createConnectedSocket } from './socket.js';
import { waitForAck } from './wait-for-ack.js';

async function main()
{
  const config = getConfig();
  const recipientArgument = readArgument('to');
  const recipientJid = normalizeRecipientToJid(recipientArgument || config.target);
  const ackLevel = readArgument('ack') || 'server';
  const ackTimeoutMs = Number(readArgument('ack-timeout-ms') || 30000);

  const title = readArgument('title') || 'Options';
  const body = readArgument('body') || 'Choose one option';
  const footer = readArgument('footer') || 'Baileys buttonsMessage POC';

  const socket = await createConnectedSocket(config.authDirectory, config.logLevel);

  try
  {
    const messageId = await relayProtoMessage(socket, recipientJid, {
      buttonsMessage: {
        headerType: proto.Message.ButtonsMessage.HeaderType.TEXT,
        text: title,
        contentText: body,
        footerText: footer,
        buttons: [
          {
            buttonId: 'opt_1',
            buttonText: { displayText: 'Option 1' },
            type: proto.Message.ButtonsMessage.Button.Type.RESPONSE,
          },
          {
            buttonId: 'opt_2',
            buttonText: { displayText: 'Option 2' },
            type: proto.Message.ButtonsMessage.Button.Type.RESPONSE,
          },
          {
            buttonId: 'opt_3',
            buttonText: { displayText: 'Option 3' },
            type: proto.Message.ButtonsMessage.Button.Type.RESPONSE,
          },
        ],
      },
    });

    console.log(`[send:legacy:buttons] Sent to ${recipientJid} with message id: ${messageId}`);
    console.log(`[send:legacy:buttons] Waiting for ${ackLevel.toUpperCase()} ACK (timeout: ${ackTimeoutMs}ms)...`);

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

    console.log(`[send:legacy:buttons] ACK confirmed: ${ackResult.statusName}`);
  }
  finally
  {
    await closeSocket(socket);
  }
}

main().catch(error =>
{
  console.error('[send:legacy:buttons] Failed:', error);
  process.exit(1);
});
