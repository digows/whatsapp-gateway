/**
 * Desired operational policy for a mirrored WhatsApp session.
 * The embedded control plane reconciles the runtime towards this state.
 */
export enum SessionDesiredState {
  Active = 'active',
  Paused = 'paused',
  Stopped = 'stopped',
}

export function parseSessionDesiredState(value: string): SessionDesiredState {
  switch (value) {
    case SessionDesiredState.Active:
      return SessionDesiredState.Active;
    case SessionDesiredState.Paused:
      return SessionDesiredState.Paused;
    case SessionDesiredState.Stopped:
      return SessionDesiredState.Stopped;
    default:
      throw new Error(`Unsupported session desired state "${value}".`);
  }
}
