import Fastify from 'fastify';
import { EmbeddedControlPlane } from './application/EmbeddedControlPlane.js';
import { SessionWorkerHost } from './application/SessionWorkerHost.js';
import { env } from './application/config/env.js';
import { ActivationResource } from './application/restful/ActivationResource.js';
import { HealthResource } from './application/restful/HealthResource.js';
import { HostedSessionResource } from './application/restful/HostedSessionResource.js';
import { SessionResource } from './application/restful/SessionResource.js';
import { WorkerIdentity } from './domain/entities/operational/WorkerIdentity.js';
import { ActivationService } from './domain/services/ActivationService.js';
import { SessionLifecycleService } from './domain/services/SessionLifecycleService.js';
import { installLibraryLogFilters } from './infrastructure/baileys/installLibraryLogFilters.js';
import { NatsChannelTransport } from './infrastructure/nats/NatsChannelTransport.js';
import { PgSessionRepository } from './infrastructure/pg/PgSessionRepository.js';

async function bootstrapMain(): Promise<void> {
  console.log('Starting WhatsApp Gateway...');
  installLibraryLogFilters();

  const sessionRepository = new PgSessionRepository();
  const sessionLifecycleService = new SessionLifecycleService(sessionRepository);
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
  const activationService = new ActivationService(host, sessionLifecycleService);
  const httpServer = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  new HealthResource(host).register(httpServer);
  new ActivationResource(activationService).register(httpServer);
  new SessionResource(
    sessionRepository,
    sessionLifecycleService,
    host,
  ).register(httpServer);
  new HostedSessionResource(host).register(httpServer);

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
    await embeddedControlPlane.stop().catch(error => {
      console.error('[MAIN] Error while stopping embedded control plane:', error);
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
    await embeddedControlPlane.start();
    await httpServer.listen({
      host: env.HTTP_HOST,
      port: env.HTTP_PORT,
    });
    console.log(`[HTTP] REST API listening on http://${env.HTTP_HOST}:${env.HTTP_PORT}`);
  } catch (error) {
    console.error('Failed to start WhatsApp Gateway:', error);
    await httpServer.close().catch(() => {});
    await embeddedControlPlane.stop().catch(() => {});
    await host.stop().catch(() => {});
    process.exit(1);
  }
}

void bootstrapMain();
