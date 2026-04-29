import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

function buildLogger(logLevel)
{
  return pino({
    level: logLevel,
  });
}

async function waitForSocketOpen(socket)
{
  return await new Promise((resolve, reject) =>
  {
    const timeout = setTimeout(() =>
    {
      reject(new Error('Timed out waiting for WhatsApp connection to open.'));
    }, 120000);

    socket.ev.on('connection.update', update =>
    {
      if (update.qr)
      {
        console.log('\nScan this QR code in WhatsApp:');
        qrcode.generate(update.qr, { small: true });
      }

      if (update.connection === 'open')
      {
        clearTimeout(timeout);
        resolve({
          shouldRestart: false,
        });
      }

      if (update.connection === 'close')
      {
        const errorMessage = update.lastDisconnect?.error?.message || 'Socket closed before opening.';
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const shouldRestart = statusCode === 515 || errorMessage.includes('restart required');
        clearTimeout(timeout);

        if (shouldRestart)
        {
          resolve({
            shouldRestart: true,
          });
          return;
        }

        reject(new Error(errorMessage));
      }
    });
  });
}

export async function createConnectedSocket(authDirectory, logLevel)
{
  const logger = buildLogger(logLevel);
  const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
  const { version } = await fetchLatestBaileysVersion();
  const maxRestartAttempts = 3;

  for (let attempt = 1; attempt <= maxRestartAttempts; attempt += 1)
  {
    const socket = makeWASocket({
      auth: state,
      version,
      logger,
      syncFullHistory: false,
    });

    socket.ev.on('creds.update', saveCreds);

    const outcome = await waitForSocketOpen(socket);
    if (!outcome.shouldRestart)
    {
      return socket;
    }

    console.log(`[socket] Restart requested by server (${attempt}/${maxRestartAttempts}). Reconnecting...`);
  }

  throw new Error(`Unable to open WhatsApp socket after ${maxRestartAttempts} restart attempts.`);
}

export async function closeSocket(socket)
{
  try
  {
    socket.end();
  }
  catch (_error)
  {
  }
}
