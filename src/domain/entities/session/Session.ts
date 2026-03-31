import { AuthenticationStateQuery } from '../authentication/AuthenticationStateQuery.js';
import { AuthenticationStateRecord } from '../authentication/AuthenticationStateRecord.js';
import { SessionReference } from '../operational/SessionReference.js';
import { SessionActivationState } from './SessionActivationState.js';
import { SessionDesiredState } from './SessionDesiredState.js';
import { SessionRuntimeState } from './SessionRuntimeState.js';

/**
 * Durable mirror of one real WhatsApp session.
 * This is the entity that the embedded control plane should reconcile over time,
 * while authentication keys remain only the technical credential storage behind it.
 */
export class Session {
  constructor(
    public readonly reference: SessionReference,
    public readonly desiredState: SessionDesiredState,
    public readonly runtimeState: SessionRuntimeState,
    public readonly activationState: SessionActivationState,
    public readonly hasPersistedCredentials: boolean,
    public readonly createdAt: string,
    public readonly updatedAt: string,
    public readonly assignedWorkerId?: string,
    public readonly phoneNumber?: string,
    public readonly whatsappJid?: string,
    public readonly lastError?: string,
    public readonly lastConnectedAt?: string,
    public readonly lastDisconnectedAt?: string,
  ) {}

  public static create(
    reference: SessionReference,
    createdAt: string,
  ): Session {
    return new Session(
      reference,
      SessionDesiredState.Active,
      SessionRuntimeState.New,
      SessionActivationState.Idle,
      false,
      createdAt,
      createdAt,
    );
  }

  public wantsToBeRunning(): boolean {
    return this.desiredState === SessionDesiredState.Active;
  }

  public isRecoverable(): boolean {
    return this.wantsToBeRunning()
      && this.hasPersistedCredentials
      && this.runtimeState !== SessionRuntimeState.LoggedOut;
  }

  public ownsAuthenticationStateRecord(record: AuthenticationStateRecord): boolean {
    return this.reference.toKey() === record.session.toKey();
  }

  public ownsAuthenticationStateQuery(query: AuthenticationStateQuery): boolean {
    return this.reference.toKey() === query.session.toKey();
  }

  public withDesiredState(
    desiredState: SessionDesiredState,
    updatedAt: string,
  ): Session {
    return this.copy({
      desiredState,
      updatedAt,
    });
  }

  public beginQrCodeActivation(updatedAt: string): Session {
    return this.copy({
      activationState: SessionActivationState.AwaitingQrCode,
      desiredState: SessionDesiredState.Active,
      updatedAt,
      lastError: undefined,
    });
  }

  public beginPairingCodeActivation(
    phoneNumber: string,
    updatedAt: string,
  ): Session {
    if (!phoneNumber.trim()) {
      throw new Error('Session pairing code activation requires a non-empty phoneNumber.');
    }

    return this.copy({
      activationState: SessionActivationState.AwaitingPairingCode,
      desiredState: SessionDesiredState.Active,
      phoneNumber,
      updatedAt,
      lastError: undefined,
    });
  }

  public completeActivation(updatedAt: string): Session {
    return this.copy({
      activationState: SessionActivationState.Completed,
      updatedAt,
      lastError: undefined,
    });
  }

  public failActivation(reason: string, updatedAt: string): Session {
    return this.copy({
      activationState: SessionActivationState.Failed,
      lastError: reason,
      updatedAt,
    });
  }

  public expireActivation(updatedAt: string, reason?: string): Session {
    return this.copy({
      activationState: SessionActivationState.Expired,
      lastError: reason,
      updatedAt,
    });
  }

  public cancelActivation(updatedAt: string, reason?: string): Session {
    return this.copy({
      activationState: SessionActivationState.Cancelled,
      lastError: reason,
      updatedAt,
    });
  }

  public assignWorker(
    workerId: string,
    updatedAt: string,
  ): Session {
    if (!workerId.trim()) {
      throw new Error('Session assignment requires a non-empty workerId.');
    }

    return this.copy({
      assignedWorkerId: workerId,
      updatedAt,
    });
  }

  public clearWorker(updatedAt: string): Session {
    return this.copy({
      assignedWorkerId: undefined,
      updatedAt,
    });
  }

  public markStarting(
    workerId: string,
    updatedAt: string,
  ): Session {
    return this.copy({
      runtimeState: SessionRuntimeState.Starting,
      assignedWorkerId: workerId,
      updatedAt,
      lastError: undefined,
    });
  }

  public markConnected(
    workerId: string,
    updatedAt: string,
    whatsappJid?: string,
  ): Session {
    return this.copy({
      runtimeState: SessionRuntimeState.Connected,
      activationState: SessionActivationState.Completed,
      assignedWorkerId: workerId,
      whatsappJid,
      updatedAt,
      lastConnectedAt: updatedAt,
      lastError: undefined,
    });
  }

  public markReconnecting(
    workerId: string,
    updatedAt: string,
    reason?: string,
  ): Session {
    return this.copy({
      runtimeState: SessionRuntimeState.Reconnecting,
      assignedWorkerId: workerId,
      updatedAt,
      lastError: reason,
    });
  }

  public markStopping(updatedAt: string): Session {
    return this.copy({
      runtimeState: SessionRuntimeState.Stopping,
      updatedAt,
    });
  }

  public markStopped(updatedAt: string, reason?: string): Session {
    return this.copy({
      runtimeState: SessionRuntimeState.Stopped,
      assignedWorkerId: undefined,
      updatedAt,
      lastDisconnectedAt: updatedAt,
      lastError: reason,
    });
  }

  public markFailed(updatedAt: string, reason: string): Session {
    return this.copy({
      runtimeState: SessionRuntimeState.Failed,
      assignedWorkerId: undefined,
      updatedAt,
      lastDisconnectedAt: updatedAt,
      lastError: reason,
    });
  }

  public markLoggedOut(updatedAt: string, reason?: string): Session {
    return this.copy({
      runtimeState: SessionRuntimeState.LoggedOut,
      assignedWorkerId: undefined,
      updatedAt,
      lastDisconnectedAt: updatedAt,
      lastError: reason,
      hasPersistedCredentials: false,
    });
  }

  public markPersistedCredentials(updatedAt: string): Session {
    return this.copy({
      hasPersistedCredentials: true,
      updatedAt,
    });
  }

  public clearPersistedCredentials(updatedAt: string): Session {
    return this.copy({
      hasPersistedCredentials: false,
      updatedAt,
    });
  }

  private copy(changes: {
    desiredState?: SessionDesiredState;
    runtimeState?: SessionRuntimeState;
    activationState?: SessionActivationState;
    hasPersistedCredentials?: boolean;
    updatedAt?: string;
    assignedWorkerId?: string | undefined;
    phoneNumber?: string | undefined;
    whatsappJid?: string | undefined;
    lastError?: string | undefined;
    lastConnectedAt?: string | undefined;
    lastDisconnectedAt?: string | undefined;
  }): Session {
    return new Session(
      this.reference,
      changes.desiredState ?? this.desiredState,
      changes.runtimeState ?? this.runtimeState,
      changes.activationState ?? this.activationState,
      changes.hasPersistedCredentials ?? this.hasPersistedCredentials,
      this.createdAt,
      changes.updatedAt ?? this.updatedAt,
      'assignedWorkerId' in changes ? changes.assignedWorkerId : this.assignedWorkerId,
      'phoneNumber' in changes ? changes.phoneNumber : this.phoneNumber,
      'whatsappJid' in changes ? changes.whatsappJid : this.whatsappJid,
      'lastError' in changes ? changes.lastError : this.lastError,
      'lastConnectedAt' in changes ? changes.lastConnectedAt : this.lastConnectedAt,
      'lastDisconnectedAt' in changes ? changes.lastDisconnectedAt : this.lastDisconnectedAt,
    );
  }
}
