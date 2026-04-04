import { env } from '../../application/config/env.js';
import { renderConfigTemplate } from '../../application/config/renderConfigTemplate.js';
import { OutboundCommandFamily } from '../../domain/entities/command/OutboundCommand.js';
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
    eventType: 'incoming' | 'delivery' | 'status',
  ): string {
    const template = this.getSessionTemplate(eventType);
    return renderConfigTemplate(template, {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  public static getCommandSubject(
    session: SessionReference,
    family: OutboundCommandFamily,
  ): string {
    return renderConfigTemplate(env.NATS_SUBJECT_COMMAND_TEMPLATE, {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      family,
    });
  }

  public static getCommandResultSubject(
    session: SessionReference,
    family: OutboundCommandFamily,
  ): string {
    return renderConfigTemplate(env.NATS_SUBJECT_COMMAND_RESULT_TEMPLATE, {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      family,
    });
  }

  public static getActivationSubject(session: SessionReference): string {
    return renderConfigTemplate(env.NATS_SUBJECT_ACTIVATION_TEMPLATE, {
      provider: session.provider,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
  }

  public static getJetStreamSubjects(providerId: string): string[] {
    return [
      env.NATS_SUBJECT_CONTROL_TEMPLATE,
      env.NATS_SUBJECT_INBOUND_TEMPLATE,
      env.NATS_SUBJECT_COMMAND_TEMPLATE,
      env.NATS_SUBJECT_DELIVERY_TEMPLATE,
      env.NATS_SUBJECT_COMMAND_RESULT_TEMPLATE,
      env.NATS_SUBJECT_STATUS_TEMPLATE,
      env.NATS_SUBJECT_ACTIVATION_TEMPLATE,
    ].map(template => this.toJetStreamSubjectPattern(template, providerId));
  }

  private static getSessionTemplate(
    eventType: 'incoming' | 'delivery' | 'status',
  ): string {
    switch (eventType) {
      case 'incoming':
        return env.NATS_SUBJECT_INBOUND_TEMPLATE;
      case 'delivery':
        return env.NATS_SUBJECT_DELIVERY_TEMPLATE;
      case 'status':
        return env.NATS_SUBJECT_STATUS_TEMPLATE;
    }
  }

  private static toJetStreamSubjectPattern(template: string, providerId: string): string {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, placeholderName: string) => {
      if (placeholderName === 'provider') {
        return providerId;
      }

      return '*';
    });
  }
}
