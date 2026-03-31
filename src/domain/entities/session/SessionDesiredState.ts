/**
 * Desired operational policy for a mirrored WhatsApp session.
 * The embedded control plane reconciles the runtime towards this state.
 */
export enum SessionDesiredState {
  Active = 'active',
  Paused = 'paused',
  Stopped = 'stopped',
}
