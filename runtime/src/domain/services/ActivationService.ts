import crypto from 'crypto';
import QRCode from 'qrcode';
import { env } from '../../application/config/env.js';
import { BaileysProvider } from '../../infrastructure/baileys/BaileysProvider.js';
import {
  Activation,
  ActivationStatus,
} from '../entities/activation/Activation.js';
import {
  ActivationCancelledEvent,
  ActivationCompletedEvent,
  ActivationEvent,
  ActivationExpiredEvent,
  ActivationFailedEvent,
  ActivationPairingCodeUpdatedEvent,
  ActivationQrCodeUpdatedEvent,
} from '../entities/activation/ActivationEvent.js';
import { ActivationMode } from '../entities/activation/ActivationMode.js';
import { SessionReference } from '../entities/operational/SessionReference.js';
import { NatsSubjectBuilder } from '../../infrastructure/nats/NatsSubjectBuilder.js';
import { SessionLifecycleService } from './SessionLifecycleService.js';

type BaileysActivationSupport = Pick<
  BaileysProvider,
  'requestQrCodeActivation' | 'requestPairingCodeActivation'
>;

type ActivationSessionHost = {
  ensureSessionStarted(session: SessionReference): Promise<BaileysActivationSupport>;
};

/**
 * Core synchronous activation workflow for WhatsApp sessions.
 * It is intentionally coupled to the Baileys-based runtime because this project is
 * WhatsApp/Baileys-specific by design.
 */
export class ActivationService {
  constructor(
    private readonly sessionHost: ActivationSessionHost,
    private readonly sessionLifecycleService: SessionLifecycleService,
    private readonly providerId = env.CHANNEL_PROVIDER_ID,
  ) {}

  public async requestQrCode(
    workspaceId: number,
    sessionId?: string,
    waitTimeoutMs = 30000,
  ): Promise<Activation> {
    const session = this.createSessionReference(workspaceId, sessionId);
    await this.sessionLifecycleService.ensureSession(session, new Date().toISOString());
    await this.sessionLifecycleService.beginQrCodeActivation(session, new Date().toISOString());

    try {
      const provider = await this.sessionHost.ensureSessionStarted(session);
      const event = await provider.requestQrCodeActivation(waitTimeoutMs);
      return this.buildActivation(event, ActivationMode.QrCode);
    } catch (error) {
      await this.sessionLifecycleService.failActivation(
        session,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
      );
      throw error;
    }
  }

  public async requestPairingCode(
    workspaceId: number,
    phoneNumber: string,
    sessionId?: string,
    customPairingCode?: string,
    waitTimeoutMs = 30000,
  ): Promise<Activation> {
    if (!phoneNumber.trim()) {
      throw new Error('Pairing code activation requires a non-empty phoneNumber.');
    }

    const session = this.createSessionReference(workspaceId, sessionId);
    await this.sessionLifecycleService.ensureSession(session, new Date().toISOString());
    await this.sessionLifecycleService.beginPairingCodeActivation(
      session,
      phoneNumber,
      new Date().toISOString(),
    );

    try {
      const provider = await this.sessionHost.ensureSessionStarted(session);
      const event = await provider.requestPairingCodeActivation(
        phoneNumber,
        customPairingCode,
        waitTimeoutMs,
      );
      return this.buildActivation(event, ActivationMode.PairingCode);
    } catch (error) {
      await this.sessionLifecycleService.failActivation(
        session,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
      );
      throw error;
    }
  }

  private createSessionReference(workspaceId: number, sessionId?: string): SessionReference {
    if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
      throw new Error('ActivationService requires a positive workspaceId.');
    }

    return new SessionReference(
      this.providerId,
      workspaceId,
      sessionId?.trim() || crypto.randomUUID(),
    );
  }

  private async buildActivation(
    event: ActivationEvent,
    requestedMode: ActivationMode,
  ): Promise<Activation> {
    const eventSubject = NatsSubjectBuilder.getActivationSubject(event.session);

    if (event instanceof ActivationQrCodeUpdatedEvent) {
      return new Activation(
        event.commandId,
        event.correlationId,
        event.activationId,
        event.session,
        ActivationMode.QrCode,
        ActivationStatus.QrCodeReady,
        event.timestamp,
        eventSubject,
        event.qrCode,
        await this.encodeQrCodeBase64(event.qrCode),
      );
    }

    if (event instanceof ActivationPairingCodeUpdatedEvent) {
      return new Activation(
        event.commandId,
        event.correlationId,
        event.activationId,
        event.session,
        ActivationMode.PairingCode,
        ActivationStatus.PairingCodeReady,
        event.timestamp,
        eventSubject,
        undefined,
        undefined,
        event.pairingCode,
        event.phoneNumber,
      );
    }

    if (event instanceof ActivationCompletedEvent) {
      return new Activation(
        event.commandId,
        event.correlationId,
        event.activationId,
        event.session,
        event.mode,
        ActivationStatus.Completed,
        event.timestamp,
        eventSubject,
      );
    }

    if (event instanceof ActivationFailedEvent) {
      return new Activation(
        event.commandId,
        event.correlationId,
        event.activationId,
        event.session,
        requestedMode,
        ActivationStatus.Failed,
        event.timestamp,
        eventSubject,
        undefined,
        undefined,
        undefined,
        undefined,
        event.reason,
      );
    }

    if (event instanceof ActivationExpiredEvent) {
      return new Activation(
        event.commandId,
        event.correlationId,
        event.activationId,
        event.session,
        requestedMode,
        ActivationStatus.Expired,
        event.timestamp,
        eventSubject,
        undefined,
        undefined,
        undefined,
        undefined,
        event.reason,
      );
    }

    if (event instanceof ActivationCancelledEvent) {
      return new Activation(
        event.commandId,
        event.correlationId,
        event.activationId,
        event.session,
        requestedMode,
        ActivationStatus.Cancelled,
        event.timestamp,
        eventSubject,
        undefined,
        undefined,
        undefined,
        undefined,
        event.reason,
      );
    }

    throw new Error(`Unsupported activation event ${event.eventType} for synchronous result mapping.`);
  }

  private async encodeQrCodeBase64(qrCodeText: string): Promise<string> {
    const dataUrl = await QRCode.toDataURL(qrCodeText);
    const dataUrlParts = dataUrl.split(',', 2);

    if (dataUrlParts.length !== 2 || !dataUrlParts[1]) {
      throw new Error('Failed to convert QR code to PNG base64.');
    }

    return dataUrlParts[1];
  }
}
