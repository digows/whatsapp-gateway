import { env } from '../../application/config/env.js';
import { renderConfigTemplate } from '../../application/config/renderConfigTemplate.js';
import { ProviderId, SessionAddress } from '../../shared/contracts/gateway.js';

export class NatsSubjectBuilder {
  public static getWorkerControlSubject(providerId: ProviderId, workerId: string): string {
    return renderConfigTemplate(env.NATS_SUBJECT_CONTROL_TEMPLATE, {
      provider: providerId,
      workerId,
    });
  }

  public static getSessionSubject(
    session: SessionAddress,
    eventType: 'incoming' | 'outgoing' | 'delivery' | 'status',
  ): string {
    const template = this.getSessionTemplate(eventType);
    return renderConfigTemplate(template, {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  public static getActivationSubject(session: SessionAddress): string {
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
