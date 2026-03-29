import { SessionReference } from '../operational/SessionReference.js';
import { ActivationMode } from './ActivationMode.js';

export enum ActivationCommandAction {
  Start = 'start',
  Cancel = 'cancel',
}

export function parseActivationCommandAction(value: string): ActivationCommandAction {
  switch (value) {
    case ActivationCommandAction.Start:
      return ActivationCommandAction.Start;
    case ActivationCommandAction.Cancel:
      return ActivationCommandAction.Cancel;
    default:
      throw new Error(`Unsupported activation command action "${value}".`);
  }
}

/**
 * Control-plane command that starts or cancels one activation attempt for a session.
 */
export class ActivationCommand {
  constructor(
    public readonly commandId: string,
    public readonly correlationId: string,
    public readonly activationId: string,
    public readonly session: SessionReference,
    public readonly action: ActivationCommandAction,
    public readonly mode?: ActivationMode,
    public readonly phoneNumber?: string,
    public readonly customPairingCode?: string,
  ) {
    if (!commandId.trim()) {
      throw new Error('ActivationCommand requires a non-empty commandId.');
    }

    if (!correlationId.trim()) {
      throw new Error('ActivationCommand requires a non-empty correlationId.');
    }

    if (!activationId.trim()) {
      throw new Error('ActivationCommand requires a non-empty activationId.');
    }

    if (action === ActivationCommandAction.Start && !mode) {
      throw new Error('ActivationCommand start action requires an activation mode.');
    }

    if (action === ActivationCommandAction.Start && mode === ActivationMode.PairingCode) {
      if (!phoneNumber?.trim()) {
        throw new Error('Pairing code activation requires a phoneNumber.');
      }
    }
  }
}
