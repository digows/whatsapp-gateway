import dotenv from 'dotenv';

dotenv.config();

export function getConfig()
{
  return {
    target: process.env.WA_TARGET,
    authDirectory: process.env.WA_AUTH_DIR || '.auth',
    logLevel: process.env.WA_LOG_LEVEL || 'info',
    cardImage1Url: process.env.WA_CARD_IMAGE_1_URL,
    cardImage2Url: process.env.WA_CARD_IMAGE_2_URL,
    businessJid: process.env.WA_BIZ_JID,
    collectionId: process.env.WA_COLLECTION_ID,
    shopId: process.env.WA_SHOP_ID,
  };
}

export function normalizeRecipientToJid(recipient)
{
  if (!recipient || !recipient.trim())
  {
    throw new Error('Recipient is required. Pass --to or set WA_TARGET.');
  }

  if (recipient.includes('@'))
  {
    return recipient.trim();
  }

  const digits = recipient.replace(/\D/g, '');
  if (!digits)
  {
    throw new Error('Recipient must contain digits or a valid WhatsApp JID.');
  }

  return `${digits}@s.whatsapp.net`;
}

export function readArgument(flagName)
{
  const expectedFlag = `--${flagName}`;
  const flagIndex = process.argv.indexOf(expectedFlag);
  if (flagIndex < 0)
  {
    return undefined;
  }

  const value = process.argv[flagIndex + 1];
  if (!value || value.startsWith('--'))
  {
    throw new Error(`Missing value for ${expectedFlag}.`);
  }

  return value;
}
