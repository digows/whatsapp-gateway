import { getConfig } from './config.js';
import { closeSocket, createConnectedSocket } from './socket.js';

async function main()
{
  const config = getConfig();
  const socket = await createConnectedSocket(config.authDirectory, config.logLevel);

  try
  {
    console.log(`Connected as: ${socket.user?.id || 'unknown_user'}`);
    console.log('Authentication state saved.');
  }
  finally
  {
    await closeSocket(socket);
  }
}

main().catch(error =>
{
  console.error('[auth] Failed:', error);
  process.exit(1);
});
