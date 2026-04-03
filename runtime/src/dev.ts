async function bootstrapDev(): Promise<void> {
  const [
    { env },
    { EmbeddedControlPlane },
    { SessionWorkerHost },
    { SessionReference },
    { WorkerIdentity },
    { SessionLifecycleService },
    { installLibraryLogFilters },
    { NatsChannelTransport },
    { PgSessionRepository },
  ] = await Promise.all([
    import('./application/config/env.js'),
    import('./application/EmbeddedControlPlane.js'),
    import('./application/SessionWorkerHost.js'),
    import('./domain/entities/operational/SessionReference.js'),
    import('./domain/entities/operational/WorkerIdentity.js'),
    import('./domain/services/SessionLifecycleService.js'),
    import('./infrastructure/baileys/installLibraryLogFilters.js'),
    import('./infrastructure/nats/NatsChannelTransport.js'),
    import('./infrastructure/pg/PgSessionRepository.js'),
  ]);

  console.log('Starting WhatsApp Gateway (dev entrypoint)...');
  installLibraryLogFilters();

  const sessionLifecycleService = new SessionLifecycleService(new PgSessionRepository());
  const workerIdentity = WorkerIdentity.current();
  const transport = new NatsChannelTransport(env.CHANNEL_PROVIDER_ID);
  const host = new SessionWorkerHost({
    sessionLifecycleService,
    transport,
    workerIdentity,
  });
  const embeddedControlPlane = new EmbeddedControlPlane({
    sessionLifecycleService,
    transport,
    workerIdentity,
  });

  const shutdown = async (signal: string) => {
    console.log(`[DEV] Received ${signal}. Shutting down worker host...`);
    const forceExitTimer = setTimeout(() => {
      console.error('[DEV] Graceful shutdown timeout reached. Forcing process exit.');
      process.exit(1);
    }, 3000);
    forceExitTimer.unref();

    await embeddedControlPlane.stop().catch(error => {
      console.error('[DEV] Error stopping embedded control plane:', error);
    });
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
    await embeddedControlPlane.start();

    const devSession = new SessionReference(
      env.CHANNEL_PROVIDER_ID,
      env.DEV_WORKSPACE_ID,
      env.DEV_SESSION_ID,
    );
    await host.startSession(devSession);
  } catch (error) {
    console.error('Failed to start WhatsApp worker host in dev mode:', error);
    await embeddedControlPlane.stop().catch(() => {});
    await host.stop().catch(() => {});
    process.exit(1);
  }
}

void bootstrapDev();
