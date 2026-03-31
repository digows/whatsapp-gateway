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
