/**
 * Durable runtime mirror of the real WhatsApp session state.
 * Unlike the in-memory host snapshot, this state is meant to survive restarts.
 */
export enum SessionRuntimeState {
  New = 'new',
  Starting = 'starting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Stopping = 'stopping',
  Stopped = 'stopped',
  Failed = 'failed',
  LoggedOut = 'logged_out',
}

export function parseSessionRuntimeState(value: string): SessionRuntimeState {
  switch (value) {
    case SessionRuntimeState.New:
      return SessionRuntimeState.New;
    case SessionRuntimeState.Starting:
      return SessionRuntimeState.Starting;
    case SessionRuntimeState.Connected:
      return SessionRuntimeState.Connected;
    case SessionRuntimeState.Reconnecting:
      return SessionRuntimeState.Reconnecting;
    case SessionRuntimeState.Stopping:
      return SessionRuntimeState.Stopping;
    case SessionRuntimeState.Stopped:
      return SessionRuntimeState.Stopped;
    case SessionRuntimeState.Failed:
      return SessionRuntimeState.Failed;
    case SessionRuntimeState.LoggedOut:
      return SessionRuntimeState.LoggedOut;
    default:
      throw new Error(`Unsupported session runtime state "${value}".`);
  }
}
