/**
 * Durable activation state of a mirrored session.
 * It represents onboarding progress independently from the live QR/code events.
 */
export enum SessionActivationState {
  Idle = 'idle',
  AwaitingQrCode = 'awaiting_qr_code',
  AwaitingPairingCode = 'awaiting_pairing_code',
  Completed = 'completed',
  Expired = 'expired',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export function parseSessionActivationState(value: string): SessionActivationState {
  switch (value) {
    case SessionActivationState.Idle:
      return SessionActivationState.Idle;
    case SessionActivationState.AwaitingQrCode:
      return SessionActivationState.AwaitingQrCode;
    case SessionActivationState.AwaitingPairingCode:
      return SessionActivationState.AwaitingPairingCode;
    case SessionActivationState.Completed:
      return SessionActivationState.Completed;
    case SessionActivationState.Expired:
      return SessionActivationState.Expired;
    case SessionActivationState.Failed:
      return SessionActivationState.Failed;
    case SessionActivationState.Cancelled:
      return SessionActivationState.Cancelled;
    default:
      throw new Error(`Unsupported session activation state "${value}".`);
  }
}
