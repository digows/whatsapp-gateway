import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
} from 'baileys';
import { readFile } from 'fs/promises';
import path from 'path';
import pino from 'pino';

function isHttpUrl(value)
{
  return value.startsWith('http://') || value.startsWith('https://');
}

function buildMediaUploadInput(imageSource)
{
  if (isHttpUrl(imageSource))
  {
    return { url: imageSource };
  }

  return undefined;
}

async function buildLocalMediaUploadInput(imageSource)
{
  const absolutePath = path.resolve(process.cwd(), imageSource);
  const buffer = await readFile(absolutePath);
  return buffer;
}

export async function createImageMessageForInteractiveCard(socket, recipientJid, imageSource)
{
  const mediaInput = buildMediaUploadInput(imageSource)
    || await buildLocalMediaUploadInput(imageSource);

  const prepared = await prepareWAMessageMedia(
    {
      image: mediaInput,
    },
    {
      upload: socket.waUploadToServer,
      mediaCache: undefined,
      options: {},
      logger: pino({ level: 'silent' }),
      jid: recipientJid,
    },
  );

  if (!prepared.imageMessage)
  {
    throw new Error('Unable to build imageMessage for interactive card.');
  }

  return prepared.imageMessage;
}

export async function relayProtoMessage(socket, recipientJid, protoMessage, relayOptions = {})
{
  if (!socket.user?.id)
  {
    throw new Error('Socket user is not available. Connection is not ready.');
  }

  const waMessage = generateWAMessageFromContent(
    recipientJid,
    protoMessage,
    {
      userJid: socket.user.id,
    },
  );

  await socket.relayMessage(
    recipientJid,
    waMessage.message,
    {
      messageId: waMessage.key.id,
      ...relayOptions,
    },
  );

  return waMessage.key.id;
}
