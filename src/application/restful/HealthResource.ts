import { FastifyInstance } from 'fastify';
import { SessionWorkerHost } from '../services/SessionWorkerHost.js';
import { WorkerHealthSnapshot } from '../../domain/entities/operational/WorkerHealthSnapshot.js';

type HealthHostAccess = Pick<
  SessionWorkerHost,
  'isStarted' | 'getProviderId' | 'getWorkerId' | 'getHostedSessionCount'
>;

/**
 * Operational health endpoints for Kubernetes and internal infrastructure checks.
 */
export class HealthResource {
  constructor(private readonly sessionWorkerHost: HealthHostAccess) {}

  public register(server: FastifyInstance): void {
    server.get('/healthz', async (_request, reply) => {
      const snapshot = this.createSnapshot();
      const statusCode = snapshot.started ? 200 : 503;
      return reply.code(statusCode).send(snapshot);
    });

    server.get('/readyz', async (_request, reply) => {
      const snapshot = this.createSnapshot();
      const statusCode = snapshot.started ? 200 : 503;
      return reply.code(statusCode).send(snapshot);
    });
  }

  private createSnapshot(): WorkerHealthSnapshot {
    const started = this.sessionWorkerHost.isStarted();

    return new WorkerHealthSnapshot(
      started ? 'ok' : 'not_ready',
      this.sessionWorkerHost.getProviderId(),
      this.sessionWorkerHost.getWorkerId(),
      started,
      this.sessionWorkerHost.getHostedSessionCount(),
      new Date().toISOString(),
    );
  }
}
