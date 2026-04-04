import { SessionReference } from '../operational/SessionReference.js';
import { OutboundCommandFamily } from './OutboundCommand.js';

export enum OutboundCommandResultStatus {
  Succeeded = 'succeeded',
  Failed = 'failed',
  Blocked = 'blocked',
}

export function parseOutboundCommandResultStatus(value: string): OutboundCommandResultStatus {
  switch (value) {
    case OutboundCommandResultStatus.Succeeded:
      return OutboundCommandResultStatus.Succeeded;
    case OutboundCommandResultStatus.Failed:
      return OutboundCommandResultStatus.Failed;
    case OutboundCommandResultStatus.Blocked:
      return OutboundCommandResultStatus.Blocked;
    default:
      throw new Error(`Unsupported outbound command result status "${value}".`);
  }
}

/**
 * Generic execution result for outbound commands that are not plain message deliveries.
 * Result-specific data is intentionally explicit but extensible through the `data` record.
 */
export class OutboundCommandResult {
  constructor(
    public readonly commandId: string,
    public readonly session: SessionReference,
    public readonly family: OutboundCommandFamily,
    public readonly action: string,
    public readonly status: OutboundCommandResultStatus,
    public readonly timestamp: string,
    public readonly reason?: string,
    public readonly data?: Readonly<Record<string, unknown>>,
  ) {}
}
