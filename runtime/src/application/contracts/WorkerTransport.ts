import { ActivationEvent } from '../../domain/entities/activation/ActivationEvent.js';
import { OutboundCommand } from '../../domain/entities/command/OutboundCommand.js';
import { OutboundCommandResult } from '../../domain/entities/command/OutboundCommandResult.js';
import { DeliveryResult } from '../../domain/entities/messaging/DeliveryResult.js';
import { InboundEvent } from '../../domain/entities/messaging/InboundEvent.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import { SessionStatusEvent } from '../../domain/entities/operational/SessionStatus.js';
import { WorkerCommand } from '../../domain/entities/operational/WorkerCommand.js';

/**
 * Application-level transport contract used by the worker host.
 * NATS is the current adapter, but the host should not depend on its wire details.
 */
export interface WorkerTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publishWorkerCommand(command: WorkerCommand, workerId: string): Promise<void>;
  subscribeWorkerCommands(
    workerId: string,
    handler: (command: WorkerCommand) => Promise<void>,
  ): Promise<void>;
  subscribeCommands(
    session: SessionReference,
    handler: (command: OutboundCommand) => Promise<void>,
  ): Promise<void>;
  disconnectSession(session: SessionReference): Promise<void>;
  publishActivation(event: ActivationEvent): Promise<void>;
  publishInbound(event: InboundEvent): Promise<void>;
  publishDelivery(event: DeliveryResult): Promise<void>;
  publishCommandResult(event: OutboundCommandResult): Promise<void>;
  publishSessionStatus(event: SessionStatusEvent): Promise<void>;
}
