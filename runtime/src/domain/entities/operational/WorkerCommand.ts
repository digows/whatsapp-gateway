import { SessionReference } from './SessionReference.js';

export enum WorkerCommandAction {
  StartSession = 'start_session',
  StopSession = 'stop_session',
}

export function parseWorkerCommandAction(value: string): WorkerCommandAction {
  switch (value) {
    case WorkerCommandAction.StartSession:
      return WorkerCommandAction.StartSession;
    case WorkerCommandAction.StopSession:
      return WorkerCommandAction.StopSession;
    default:
      throw new Error(`Unsupported worker command action "${value}".`);
  }
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
