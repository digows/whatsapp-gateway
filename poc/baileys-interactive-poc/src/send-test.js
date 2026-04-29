import { getConfig, normalizeRecipientToJid, readArgument } from './config.js';
import { closeSocket, createConnectedSocket } from './socket.js';
import { waitForAck } from './wait-for-ack.js';

function buildMessageText()
{
  const customText = readArgument('text');
  if (customText)
  {
    return customText;
  }

  return `POC plain text test at ${new Date().toISOString()}`;
}

async function main()
{
  const config = getConfig();
  const recipientArgument = readArgument('to');
  const recipientJid = normalizeRecipientToJid(recipientArgument || config.target);
  const messageText = buildMessageText();
  const ackLevel = readArgument('ack') || 'server';
  const ackTimeoutMs = Number(readArgument('ack-timeout-ms') || 30000);

  const socket = await createConnectedSocket(config.authDirectory, config.logLevel);

  try
  {
    const response = await socket.sendMessage(recipientJid, {
      text: messageText,
    });

    if (!response?.key?.id)
    {
      throw new Error('sendMessage returned no message key id.');
    }

    console.log(`[send:test] Sent to ${recipientJid} with message id: ${response.key.id}`);
    console.log(`[send:test] Text: ${messageText}`);
    console.log(`[send:test] Waiting for ${ackLevel.toUpperCase()} ACK (timeout: ${ackTimeoutMs}ms)...`);

    const ackResult = await waitForAck(socket, response.key, {
      ackLevel,
      timeoutMs: ackTimeoutMs,
    });

    console.log(`[send:test] ACK confirmed: ${ackResult.statusName}`);
  }
  finally
  {
    await closeSocket(socket);
  }
}

main().catch(error =>
{
  console.error('[send:test] Failed:', error);
  process.exit(1);
});
