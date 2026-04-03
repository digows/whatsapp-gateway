import { SessionReference } from '../operational/SessionReference.js';

export enum DeliveryStatus {
  Sent = 'sent',
  Failed = 'failed',
  Blocked = 'blocked',
}

/**
 * Result emitted after an outbound send attempt finishes inside a session runtime.
 */
export class DeliveryResult {
  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly recipientId: string,
    public readonly status: DeliveryStatus,
    public readonly timestamp: string,
    public readonly providerMessageId?: string,
    public readonly reason?: string,
  ) {}
}
