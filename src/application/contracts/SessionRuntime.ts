import { InboundEvent } from '../../domain/entities/messaging/InboundEvent.js';
import { DeliveryResult } from '../../domain/entities/messaging/DeliveryResult.js';
import { SendMessageCommand } from '../../domain/entities/messaging/SendMessageCommand.js';
import { SessionStatusEvent } from '../../domain/entities/operational/SessionStatus.js';

/**
 * Callback contract implemented by the application service that hosts a session runtime.
 */
export interface SessionRuntimeCallbacks {
  onInboundEvent(event: InboundEvent): Promise<void>;
  onSessionStatus(event: SessionStatusEvent): Promise<void>;
}

/**
 * Runtime contract for one hosted WhatsApp session.
 * Baileys is the current implementation, but the host only depends on this behavior.
 */
export interface SessionRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(command: SendMessageCommand): Promise<DeliveryResult>;
}
