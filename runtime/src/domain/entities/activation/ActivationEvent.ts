import { SessionReference } from '../operational/SessionReference.js';
import { ActivationMode } from './ActivationMode.js';

export enum ActivationEventType {
  Started = 'activation.started',
  QrCodeUpdated = 'activation.qr.updated',
  PairingCodeUpdated = 'activation.pairing_code.updated',
  Completed = 'activation.completed',
  Failed = 'activation.failed',
  Expired = 'activation.expired',
  Cancelled = 'activation.cancelled',
}

/**
 * Base metadata shared by all activation lifecycle events.
 */
export abstract class ActivationEventBase {
  constructor(
    public readonly commandId: string,
    public readonly correlationId: string,
    public readonly activationId: string,
    public readonly session: SessionReference,
    public readonly timestamp: string,
  ) {}
}

export class ActivationStartedEvent extends ActivationEventBase {
  public readonly eventType = ActivationEventType.Started;

  constructor(
    commandId: string,
    correlationId: string,
    activationId: string,
    session: SessionReference,
    timestamp: string,
    public readonly mode: ActivationMode,
    public readonly phoneNumber?: string,
  ) {
    super(commandId, correlationId, activationId, session, timestamp);
  }
}

export class ActivationQrCodeUpdatedEvent extends ActivationEventBase {
  public readonly eventType = ActivationEventType.QrCodeUpdated;

  constructor(
    commandId: string,
    correlationId: string,
    activationId: string,
    session: SessionReference,
    timestamp: string,
    public readonly qrCode: string,
    public readonly sequence: number,
    public readonly expiresAt?: string,
  ) {
    super(commandId, correlationId, activationId, session, timestamp);
  }
}

export class ActivationPairingCodeUpdatedEvent extends ActivationEventBase {
  public readonly eventType = ActivationEventType.PairingCodeUpdated;

  constructor(
    commandId: string,
    correlationId: string,
    activationId: string,
    session: SessionReference,
    timestamp: string,
    public readonly pairingCode: string,
    public readonly sequence: number,
    public readonly phoneNumber?: string,
    public readonly expiresAt?: string,
  ) {
    super(commandId, correlationId, activationId, session, timestamp);
  }
}

export class ActivationCompletedEvent extends ActivationEventBase {
  public readonly eventType = ActivationEventType.Completed;

  constructor(
    commandId: string,
    correlationId: string,
    activationId: string,
    session: SessionReference,
    timestamp: string,
    public readonly mode: ActivationMode,
  ) {
    super(commandId, correlationId, activationId, session, timestamp);
  }
}

export class ActivationFailedEvent extends ActivationEventBase {
  public readonly eventType = ActivationEventType.Failed;

  constructor(
    commandId: string,
    correlationId: string,
    activationId: string,
    session: SessionReference,
    timestamp: string,
    public readonly reason: string,
    public readonly retryable = false,
  ) {
    super(commandId, correlationId, activationId, session, timestamp);
  }
}

export class ActivationExpiredEvent extends ActivationEventBase {
  public readonly eventType = ActivationEventType.Expired;

  constructor(
    commandId: string,
    correlationId: string,
    activationId: string,
    session: SessionReference,
    timestamp: string,
    public readonly reason?: string,
  ) {
    super(commandId, correlationId, activationId, session, timestamp);
  }
}

export class ActivationCancelledEvent extends ActivationEventBase {
  public readonly eventType = ActivationEventType.Cancelled;

  constructor(
    commandId: string,
    correlationId: string,
    activationId: string,
    session: SessionReference,
    timestamp: string,
    public readonly reason?: string,
  ) {
    super(commandId, correlationId, activationId, session, timestamp);
  }
}

export type ActivationEvent =
  | ActivationStartedEvent
  | ActivationQrCodeUpdatedEvent
  | ActivationPairingCodeUpdatedEvent
  | ActivationCompletedEvent
  | ActivationFailedEvent
  | ActivationExpiredEvent
  | ActivationCancelledEvent;
