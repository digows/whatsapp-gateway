import { SessionReference } from './SessionReference.js';

export enum WorkerCommandAction {
  StartSession = 'start_session',
  StopSession = 'stop_session',
}

/**
 * Control-plane command addressed to one worker process.
 */
export class WorkerCommand {
  constructor(
    public readonly commandId: string,
    public readonly action: WorkerCommandAction,
    public readonly session: SessionReference,
  ) {}
}
