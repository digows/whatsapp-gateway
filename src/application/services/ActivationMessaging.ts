import { ActivationCommand } from '../../domain/entities/activation/ActivationCommand.js';
import { ActivationEvent } from '../../domain/entities/activation/ActivationEvent.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { WorkerTransport } from '../contracts/WorkerTransport.js';

/**
 * Dedicated application-level messaging rail for activation commands and events.
 * Keeps activation lifecycle traffic separate from chat inbound/outbound traffic.
 */
export class ActivationMessaging {
  constructor(private readonly transport: WorkerTransport) {}

  public async subscribe(
    session: SessionReference,
    handler: (command: ActivationCommand) => Promise<void>,
  ): Promise<void> {
    await this.transport.subscribeActivation(session, handler);
  }

  public async publish(event: ActivationEvent): Promise<void> {
    await this.transport.publishActivation(event);
  }
}
