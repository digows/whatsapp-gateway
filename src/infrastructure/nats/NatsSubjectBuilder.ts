import { env } from '../../application/config/env.js';
import { renderConfigTemplate } from '../../application/config/renderConfigTemplate.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';

export class NatsSubjectBuilder {
  public static getWorkerControlSubject(providerId: string, workerId: string): string {
    return renderConfigTemplate(env.NATS_SUBJECT_CONTROL_TEMPLATE, {
      provider: providerId,
      workerId,
    });
  }

  public static getSessionSubject(
    session: SessionReference,
    eventType: 'incoming' | 'outgoing' | 'delivery' | 'status',
  ): string {
    const template = this.getSessionTemplate(eventType);
    return renderConfigTemplate(template, {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  public static getActivationSubject(session: SessionReference): string {
    return renderConfigTemplate(env.NATS_SUBJECT_ACTIVATION_TEMPLATE, {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  private static getSessionTemplate(
    eventType: 'incoming' | 'outgoing' | 'delivery' | 'status',
  ): string {
    switch (eventType) {
      case 'incoming':
        return env.NATS_SUBJECT_INBOUND_TEMPLATE;
      case 'outgoing':
        return env.NATS_SUBJECT_OUTBOUND_TEMPLATE;
      case 'delivery':
        return env.NATS_SUBJECT_DELIVERY_TEMPLATE;
      case 'status':
        return env.NATS_SUBJECT_STATUS_TEMPLATE;
    }
  }
}
