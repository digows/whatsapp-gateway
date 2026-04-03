import { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { ActivationMode } from '../../domain/entities/activation/ActivationMode.js';
import { ActivationService } from '../../domain/services/ActivationService.js';

const workspaceParametersSchema = z.object({
  workspaceId: z.coerce.number().int().positive(),
}).strict();

const activationRequestBodySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal(ActivationMode.QrCode),
    sessionId: z.string().trim().min(1).optional(),
    waitTimeoutMs: z.coerce.number().int().positive().optional(),
  }).strict(),
  z.object({
    mode: z.literal(ActivationMode.PairingCode),
    sessionId: z.string().trim().min(1).optional(),
    phoneNumber: z.string().trim().min(1),
    customPairingCode: z.string().trim().min(1).optional(),
    waitTimeoutMs: z.coerce.number().int().positive().optional(),
  }).strict(),
]);

/**
 * REST resource that exposes synchronous activation requests.
 * The initial QR code or pairing code is returned directly, while subsequent
 * lifecycle updates continue through activation events on NATS.
 */
export class ActivationResource {
  constructor(private readonly activationService: ActivationService) {}

  public register(server: FastifyInstance): void {
    server.post('/api/v1/workspaces/:workspaceId/activations', async (request, reply) => {
      try {
        const parameters = workspaceParametersSchema.parse(request.params);
        const activationRequest = activationRequestBodySchema.parse(request.body);

        if (activationRequest.mode === ActivationMode.QrCode) {
          const activation = await this.activationService.requestQrCode(
            parameters.workspaceId,
            activationRequest.sessionId,
            activationRequest.waitTimeoutMs,
          );
          return reply.code(200).send(activation);
        }

        const activation = await this.activationService.requestPairingCode(
          parameters.workspaceId,
          activationRequest.phoneNumber,
          activationRequest.sessionId,
          activationRequest.customPairingCode,
          activationRequest.waitTimeoutMs,
        );
        return reply.code(200).send(activation);
      } catch (error) {
        return this.sendErrorResponse(reply, error);
      }
    });
  }

  private sendErrorResponse(reply: FastifyReply, error: unknown): FastifyReply {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Invalid activation request.',
        issues: error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const message = error instanceof Error ? error.message : 'Unexpected activation resource error.';

    return reply.code(500).send({
      error: 'Failed to process activation request.',
      message,
    });
  }
}
