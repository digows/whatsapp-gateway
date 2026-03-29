async function bootstrapDev(): Promise<void> {
  const [
    { env },
    { SessionWorkerHost },
    { SessionReference },
    { installLibraryLogFilters },
  ] = await Promise.all([
    import('./application/config/env.js'),
    import('./application/services/SessionWorkerHost.js'),
    import('./domain/entities/operational/SessionReference.js'),
    import('./infrastructure/baileys/installLibraryLogFilters.js'),
  ]);

  console.log('Starting WhatsApp Gateway (dev entrypoint)...');
  installLibraryLogFilters();

  const host = new SessionWorkerHost();

  const shutdown = async (signal: string) => {
    console.log(`[DEV] Received ${signal}. Shutting down worker host...`);
    const forceExitTimer = setTimeout(() => {
      console.error('[DEV] Graceful shutdown timeout reached. Forcing process exit.');
      process.exit(1);
    }, 3000);
    forceExitTimer.unref();

    await host.stop().catch(error => {
      console.error('[DEV] Error during shutdown:', error);
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

    const devSession = new SessionReference(
      env.CHANNEL_PROVIDER_ID,
      env.DEV_WORKSPACE_ID,
      env.DEV_SESSION_ID,
    );
    await host.startSession(devSession);
  } catch (error) {
    console.error('Failed to start WhatsApp worker host in dev mode:', error);
    await host.stop().catch(() => {});
    process.exit(1);
  }
}

void bootstrapDev();
