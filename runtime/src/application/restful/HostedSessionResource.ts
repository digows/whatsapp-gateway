import { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { SessionWorkerHost } from '../SessionWorkerHost.js';

const workspaceParametersSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
}).strict();

const sessionParametersSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
  sessionId: z.string().trim().min(1),
}).strict();

type SessionHostAccess = Pick<
  SessionWorkerHost,
  'getProviderId' | 'listHostedSessionSnapshots' | 'getHostedSessionSnapshot'
>;

/**
 * Internal diagnostic view of the sessions currently hosted in this process.
 * This resource is intentionally separate from the public durable Session catalog.
 */
export class HostedSessionResource {
  constructor(private readonly sessionHost: SessionHostAccess) {}

  public register(server: FastifyInstance): void {
    server.get('/internal/v1/workspaces/:workspaceId/hosted-sessions', async (request, reply) => {
      try {
        const parameters = workspaceParametersSchema.parse(request.params);
        const sessions = this.sessionHost
          .listHostedSessionSnapshots()
          .filter(snapshot => snapshot.session.workspaceId === parameters.workspaceId);
        return reply.code(200).send(sessions);
      } catch (error) {
        return this.sendErrorResponse(reply, error);
      }
    });

    server.get('/internal/v1/workspaces/:workspaceId/hosted-sessions/:sessionId', async (request, reply) => {
      try {
        const parameters = sessionParametersSchema.parse(request.params);
        const sessionReference = new SessionReference(
          this.sessionHost.getProviderId(),
          parameters.workspaceId,
          parameters.sessionId.trim(),
        );
        const session = this.sessionHost.getHostedSessionSnapshot(sessionReference);

        if (!session) {
          return reply.code(404).send({
            error: 'Hosted session was not found on this worker.',
          });
        }

        return reply.code(200).send(session);
      } catch (error) {
        return this.sendErrorResponse(reply, error);
      }
    });
  }

  private sendErrorResponse(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Invalid hosted session request.',
        issues: error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const message = error instanceof Error ? error.message : 'Unexpected hosted session resource error.';

    return reply.code(500).send({
      error: 'Failed to process hosted session request.',
      message,
    });
  }
}
