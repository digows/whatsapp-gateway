import Fastify from 'fastify';
import { env } from './application/config/env.js';
import { ActivationResource } from './application/restful/ActivationResource.js';
import { HealthResource } from './application/restful/HealthResource.js';
import { SessionResource } from './application/restful/SessionResource.js';
import { SessionWorkerHost } from './application/services/SessionWorkerHost.js';
import { ActivationService } from './domain/services/ActivationService.js';
import { SessionService } from './domain/services/SessionService.js';
import { installLibraryLogFilters } from './infrastructure/baileys/installLibraryLogFilters.js';

async function bootstrapMain(): Promise<void> {
  console.log('Starting WhatsApp Gateway...');
  installLibraryLogFilters();

  const host = new SessionWorkerHost();
  const activationService = new ActivationService(host);
  const sessionService = new SessionService(host);
  const httpServer = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  new HealthResource(host).register(httpServer);
  new ActivationResource(activationService).register(httpServer);
  new SessionResource(sessionService).register(httpServer);

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[MAIN] Received ${signal}. Shutting down HTTP server and worker host...`);
    const forceExitTimer = setTimeout(() => {
      console.error('[MAIN] Graceful shutdown timeout reached. Forcing process exit.');
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();

    await httpServer.close().catch(error => {
      console.error('[MAIN] Error while closing HTTP server:', error);
    });
    await host.stop().catch(error => {
      console.error('[MAIN] Error while stopping worker host:', error);
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
    await httpServer.listen({
      host: env.HTTP_HOST,
      port: env.HTTP_PORT,
    });
    console.log(`[HTTP] REST API listening on http://${env.HTTP_HOST}:${env.HTTP_PORT}`);
  } catch (error) {
    console.error('Failed to start WhatsApp Gateway:', error);
    await httpServer.close().catch(() => {});
    await host.stop().catch(() => {});
    process.exit(1);
  }
}

void bootstrapMain();
