import { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { SessionDesiredState } from '../../domain/entities/session/SessionDesiredState.js';
import { Session } from '../../domain/entities/session/Session.js';
import { SessionRepository } from '../../domain/repositories/session/SessionRepository.js';
import { SessionLifecycleService } from '../../domain/services/SessionLifecycleService.js';
import { SessionWorkerHost } from '../SessionWorkerHost.js';

const workspaceParametersSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
}).strict();

const sessionParametersSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
  sessionId: z.string().trim().min(1),
}).strict();

const updateSessionBodySchema = z.object({
  desiredState: z.nativeEnum(SessionDesiredState),
}).strict();

type SessionCatalogAccess = Pick<SessionRepository, 'findByReference' | 'listByProvider'>;
type SessionLifecycleAccess = Pick<SessionLifecycleService, 'setDesiredState'>;
type SessionHostAccess = Pick<
  SessionWorkerHost,
  'getProviderId' | 'getHostedSessionSnapshot' | 'stopSession'
>;

/**
 * REST resource that exposes the durable multi-pod Session catalog.
 * This is the public operational surface other services should use.
 */
export class SessionResource {
  constructor(
    private readonly sessionCatalog: SessionCatalogAccess,
    private readonly sessionLifecycleService: SessionLifecycleAccess,
    private readonly sessionHost: SessionHostAccess,
  ) {}

  public register(server: FastifyInstance): void {
    server.get('/api/v1/workspaces/:workspaceId/sessions', async (request, reply) => {
      try {
        const parameters = workspaceParametersSchema.parse(request.params);
        const sessions = (await this.sessionCatalog.listByProvider(this.sessionHost.getProviderId()))
          .filter(session => session.reference.workspaceId === parameters.workspaceId);
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
        const session = await this.sessionCatalog.findByReference(sessionReference);

        if (!session) {
          return reply.code(404).send({
            error: 'Session was not found.',
          });
        }

        return reply.code(200).send(session);
      } catch (error) {
        return this.sendErrorResponse(reply, error);
      }
    });

    server.patch('/api/v1/workspaces/:workspaceId/sessions/:sessionId', async (request, reply) => {
      try {
        const parameters = sessionParametersSchema.parse(request.params);
        const body = updateSessionBodySchema.parse(request.body);
        const sessionReference = this.createSessionReference(
          parameters.workspaceId,
          parameters.sessionId,
        );
        const currentSession = await this.sessionCatalog.findByReference(sessionReference);

        if (!currentSession) {
          return reply.code(404).send({
            error: 'Session was not found.',
          });
        }

        const updatedSession = await this.sessionLifecycleService.setDesiredState(
          sessionReference,
          body.desiredState,
          new Date().toISOString(),
        );
        await this.stopLocallyIfNeeded(updatedSession);
        return reply.code(200).send(updatedSession);
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
        const currentSession = await this.sessionCatalog.findByReference(sessionReference);

        if (!currentSession) {
          return reply.code(404).send({
            error: 'Session was not found.',
          });
        }

        const updatedSession = await this.sessionLifecycleService.setDesiredState(
          sessionReference,
          SessionDesiredState.Stopped,
          new Date().toISOString(),
        );
        await this.stopLocallyIfNeeded(updatedSession);
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

  private async stopLocallyIfNeeded(session: Session): Promise<void> {
    if (session.desiredState === SessionDesiredState.Active) {
      return;
    }

    if (!this.sessionHost.getHostedSessionSnapshot(session.reference)) {
      return;
    }

    await this.sessionHost.stopSession(session.reference);
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
