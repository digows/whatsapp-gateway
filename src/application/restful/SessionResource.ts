import { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { SessionWorkerHost } from '../services/SessionWorkerHost.js';

const workspaceParametersSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
}).strict();

const sessionParametersSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
  sessionId: z.string().trim().min(1),
}).strict();

type SessionHostAccess = Pick<
  SessionWorkerHost,
  'getProviderId' | 'listHostedSessionSnapshots' | 'getHostedSessionSnapshot' | 'stopSession'
>;

/**
 * REST resource that exposes the local worker view of hosted sessions.
 * It does not pretend to be a global multi-pod catalog.
 */
export class SessionResource {
  constructor(private readonly sessionHost: SessionHostAccess) {}

  public register(server: FastifyInstance): void {
    server.get('/api/v1/workspaces/:workspaceId/sessions', async (request, reply) => {
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

    server.get('/api/v1/workspaces/:workspaceId/sessions/:sessionId', async (request, reply) => {
      try {
        const parameters = sessionParametersSchema.parse(request.params);
        const sessionReference = this.createSessionReference(
          parameters.workspaceId,
          parameters.sessionId,
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

    server.delete('/api/v1/workspaces/:workspaceId/sessions/:sessionId', async (request, reply) => {
      try {
        const parameters = sessionParametersSchema.parse(request.params);
        const sessionReference = this.createSessionReference(
          parameters.workspaceId,
          parameters.sessionId,
        );
        const snapshot = this.sessionHost.getHostedSessionSnapshot(sessionReference);

        if (!snapshot) {
          return reply.code(404).send({
            error: 'Hosted session was not found on this worker.',
          });
        }

        await this.sessionHost.stopSession(sessionReference);
        return reply.code(204).send();
      } catch (error) {
        return this.sendErrorResponse(reply, error);
      }
    });
  }

  private createSessionReference(workspaceId: number, sessionId: string): SessionReference {
    return new SessionReference(
      this.sessionHost.getProviderId(),
      workspaceId,
      sessionId.trim(),
    );
  }

  private sendErrorResponse(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Invalid session request.',
        issues: error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const message = error instanceof Error ? error.message : 'Unexpected session resource error.';

    return reply.code(500).send({
      error: 'Failed to process session request.',
      message,
    });
  }
}
