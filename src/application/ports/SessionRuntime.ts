import { InboundEvent } from '../../domain/entities/messaging/InboundEvent.js';
import { DeliveryResult } from '../../domain/entities/messaging/DeliveryResult.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
import { SessionStatusEvent } from '../../domain/entities/operational/SessionStatus.js';

export interface SessionRuntimeCallbacks {
  onInboundEvent(event: InboundEvent): Promise<void>;
  onSessionStatus(event: SessionStatusEvent): Promise<void>;
}

export interface SessionRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(command: SendMessageCommand): Promise<DeliveryResult>;
}
