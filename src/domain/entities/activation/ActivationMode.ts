/**
 * Supported activation strategies for pairing a WhatsApp session.
 */
export enum ActivationMode {
  QrCode = 'qr',
  PairingCode = 'pairing_code',
}

export function parseActivationMode(value: string): ActivationMode {
  switch (value) {
    case ActivationMode.QrCode:
      return ActivationMode.QrCode;
    case ActivationMode.PairingCode:
      return ActivationMode.PairingCode;
    default:
      throw new Error(`Unsupported activation mode "${value}".`);
  }
}
