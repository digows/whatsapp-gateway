import { SessionReference } from '../operational/SessionReference.js';

export enum DeliveryStatus {
  Sent = 'sent',
  Failed = 'failed',
  Blocked = 'blocked',
}

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
