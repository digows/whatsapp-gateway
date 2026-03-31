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
