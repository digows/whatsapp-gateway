import { SessionWorkerHost } from './application/services/SessionWorkerHost.js';
import { installLibraryLogFilters } from './infrastructure/baileys/installLibraryLogFilters.js';

async function bootstrapMain(): Promise<void> {
  console.log('Starting Jarvix WhatsApp Web Provider (worker entrypoint)...');
  installLibraryLogFilters();

  const host = new SessionWorkerHost();

  const shutdown = async (signal: string) => {
    console.log(`[MAIN] Received ${signal}. Shutting down worker host...`);
    const forceExitTimer = setTimeout(() => {
      console.error('[MAIN] Graceful shutdown timeout reached. Forcing process exit.');
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();

    await host.stop().catch(error => {
      console.error('[MAIN] Error during shutdown:', error);
    });
    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  try {
    await host.start();
  } catch (error) {
    console.error('Failed to start WhatsApp worker host:', error);
    await host.stop().catch(() => {});
    process.exit(1);
  }
}

void bootstrapMain();
