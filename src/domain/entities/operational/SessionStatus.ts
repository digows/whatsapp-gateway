import { SessionReference } from './SessionReference.js';

export enum SessionStatus {
  Starting = 'starting',
  Stopping = 'stopping',
  Stopped = 'stopped',
  Failed = 'failed',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  LoggedOut = 'logged_out',
}

export class SessionStatusEvent {
  constructor(
    public readonly session: SessionReference,
    public readonly status: SessionStatus,
    public readonly timestamp: string,
    public readonly workerId?: string,
    public readonly reason?: string,
  ) {}
}
