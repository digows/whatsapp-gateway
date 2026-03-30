import { SessionStatus } from './SessionStatus.js';
import { SessionReference } from './SessionReference.js';

/**
 * Local runtime view of a session currently hosted by one worker process.
 * This is not a global catalog record. It reflects only what the current worker owns.
 */
export class HostedSessionSnapshot {
  constructor(
    public readonly session: SessionReference,
    public readonly status: SessionStatus,
    public readonly workerId: string,
    public readonly hostedAt: string,
    public readonly updatedAt: string,
    public readonly reason?: string,
  ) {}
}
