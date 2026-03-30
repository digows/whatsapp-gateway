import { ActivationEvent } from '../../domain/entities/activation/ActivationEvent.js';
import { DeliveryResult } from '../../domain/entities/messaging/DeliveryResult.js';
import { InboundEvent } from '../../domain/entities/messaging/InboundEvent.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
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
  subscribeWorkerCommands(
    workerId: string,
    handler: (command: WorkerCommand) => Promise<void>,
  ): Promise<void>;
  subscribeOutgoing(
    session: SessionReference,
    handler: (command: SendMessageCommand) => Promise<void>,
  ): Promise<void>;
  disconnectSession(session: SessionReference): Promise<void>;
  publishActivation(event: ActivationEvent): Promise<void>;
  publishInbound(event: InboundEvent): Promise<void>;
  publishDelivery(event: DeliveryResult): Promise<void>;
  publishSessionStatus(event: SessionStatusEvent): Promise<void>;
}
