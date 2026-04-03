import { SessionReference } from '../operational/SessionReference.js';
import { ActivationMode } from './ActivationMode.js';

export enum ActivationStatus {
  QrCodeReady = 'qr_code_ready',
  PairingCodeReady = 'pairing_code_ready',
  Completed = 'completed',
  Failed = 'failed',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

/**
 * Synchronous activation result returned by the core service.
 * It contains the initial artifact that the caller can use immediately and the
 * event subject that should be observed for subsequent lifecycle updates.
 */
export class Activation {
  constructor(
    public readonly commandId: string,
    public readonly correlationId: string,
    public readonly activationId: string,
    public readonly session: SessionReference,
    public readonly mode: ActivationMode,
    public readonly status: ActivationStatus,
    public readonly startedAt: string,
    public readonly eventSubject: string,
    public readonly qrCodeText?: string,
    public readonly qrCodeBase64?: string,
    public readonly pairingCode?: string,
    public readonly phoneNumber?: string,
    public readonly failureReason?: string,
  ) {
    if (status === ActivationStatus.QrCodeReady) {
      if (!qrCodeText || !qrCodeBase64) {
        throw new Error('QR code activation requires qrCodeText and qrCodeBase64.');
      }
    }

    if (status === ActivationStatus.PairingCodeReady && !pairingCode) {
      throw new Error('Pairing code activation requires pairingCode.');
    }
  }
}
