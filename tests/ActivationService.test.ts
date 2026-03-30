import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivationStatus } from '../src/domain/entities/activation/Activation.js';
import {
  ActivationCompletedEvent,
  ActivationFailedEvent,
  ActivationPairingCodeUpdatedEvent,
  ActivationQrCodeUpdatedEvent,
} from '../src/domain/entities/activation/ActivationEvent.js';
import { ActivationMode } from '../src/domain/entities/activation/ActivationMode.js';
import { DeliveryResult, DeliveryStatus } from '../src/domain/entities/messaging/DeliveryResult.js';
import { SendMessageCommand } from '../src/domain/entities/messaging/SendMessageCommand.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { ActivationService } from '../src/domain/services/ActivationService.js';

class FakeBaileysProvider {
  constructor(
    private readonly qrCodeEventFactory: () => Promise<ActivationQrCodeUpdatedEvent>,
    private readonly pairingCodeEventFactory: () => Promise<ActivationPairingCodeUpdatedEvent>,
  ) {}

  public async send(command: SendMessageCommand): Promise<DeliveryResult> {
    return new DeliveryResult(
      command.commandId,
      command.session,
      command.message.chatId,
      DeliveryStatus.Sent,
      new Date().toISOString(),
    );
  }

  public async requestQrCodeActivation(_waitTimeoutMs?: number): Promise<ActivationQrCodeUpdatedEvent> {
    return this.qrCodeEventFactory();
  }

  public async requestPairingCodeActivation(
    _phoneNumber: string,
    _customPairingCode?: string,
    _waitTimeoutMs?: number,
  ): Promise<ActivationPairingCodeUpdatedEvent> {
    return this.pairingCodeEventFactory();
  }
}

function createFakeHost(
  provider: FakeBaileysProvider,
  onEnsureSessionStarted?: (session: SessionReference) => void,
): { ensureSessionStarted(session: SessionReference): Promise<FakeBaileysProvider> } {
  return {
    async ensureSessionStarted(session: SessionReference): Promise<FakeBaileysProvider> {
      onEnsureSessionStarted?.(session);
      return provider;
    },
  };
}

test('ActivationService generates a session id and returns QR code base64', async () => {
  let ensuredSession: SessionReference | undefined;
  const provider = new FakeBaileysProvider(
    async () => {
      if (!ensuredSession) {
        throw new Error('session should be ensured before activation');
      }

      return new ActivationQrCodeUpdatedEvent(
        'cmd-qr-1',
        'corr-qr-1',
        'act-qr-1',
        ensuredSession,
        '2026-03-30T10:00:00.000Z',
        'qr-text-payload',
        1,
      );
    },
    async () => {
      throw new Error('pairing path not expected');
    },
  );
  const service = new ActivationService(
    createFakeHost(provider, session => {
      ensuredSession = session;
    }),
  );

  const activation = await service.requestQrCode(11);

  assert.equal(activation.mode, ActivationMode.QrCode);
  assert.equal(activation.status, ActivationStatus.QrCodeReady);
  assert.equal(activation.qrCodeText, 'qr-text-payload');
  assert.ok(activation.qrCodeBase64);
  assert.doesNotMatch(activation.qrCodeBase64 ?? '', /^data:/);
  assert.ok(activation.session.sessionId.length > 0);
  assert.equal(activation.session.sessionId, ensuredSession?.sessionId);
  assert.equal(
    activation.eventSubject,
    `gateway.v1.channel.whatsapp-web.session.11.${activation.session.sessionId}.activation`,
  );
});

test('ActivationService preserves explicit session id and returns pairing code', async () => {
  const session = new SessionReference('whatsapp-web', 12, 'session-pairing');
  const provider = new FakeBaileysProvider(
    async () => {
      throw new Error('qr path not expected');
    },
    async () => new ActivationPairingCodeUpdatedEvent(
      'cmd-pair-1',
      'corr-pair-1',
      'act-pair-1',
      session,
      '2026-03-30T10:05:00.000Z',
      '123-456',
      1,
      '+5511999999999',
    ),
  );
  const service = new ActivationService(createFakeHost(provider));

  const activation = await service.requestPairingCode(
    12,
    '+5511999999999',
    'session-pairing',
    'CUSTOM01',
  );

  assert.equal(activation.mode, ActivationMode.PairingCode);
  assert.equal(activation.status, ActivationStatus.PairingCodeReady);
  assert.equal(activation.session.sessionId, 'session-pairing');
  assert.equal(activation.pairingCode, '123-456');
  assert.equal(activation.phoneNumber, '+5511999999999');
  assert.equal(activation.eventSubject, 'gateway.v1.channel.whatsapp-web.session.12.session-pairing.activation');
});

test('ActivationService returns completed activation when session is already connected', async () => {
  const session = new SessionReference('whatsapp-web', 13, 'connected-session');
  const provider = new FakeBaileysProvider(
    async () => new ActivationQrCodeUpdatedEvent(
      'unused',
      'unused',
      'unused',
      session,
      '2026-03-30T10:10:00.000Z',
      'unused',
      1,
    ),
    async () => new ActivationPairingCodeUpdatedEvent(
      'unused',
      'unused',
      'unused',
      session,
      '2026-03-30T10:10:00.000Z',
      'unused',
      1,
      '+5511999999999',
    ),
  );
  provider.requestQrCodeActivation = async () => new ActivationCompletedEvent(
    'cmd-done-1',
    'corr-done-1',
    'act-done-1',
    session,
    '2026-03-30T10:10:00.000Z',
    ActivationMode.QrCode,
  );

  const service = new ActivationService(createFakeHost(provider));
  const activation = await service.requestQrCode(13, 'connected-session');

  assert.equal(activation.status, ActivationStatus.Completed);
  assert.equal(activation.qrCodeText, undefined);
});

test('ActivationService returns failed activation with reason', async () => {
  const session = new SessionReference('whatsapp-web', 14, 'failed-session');
  const provider = new FakeBaileysProvider(
    async () => new ActivationQrCodeUpdatedEvent(
      'unused',
      'unused',
      'unused',
      session,
      '2026-03-30T10:15:00.000Z',
      'unused',
      1,
    ),
    async () => {
      throw new Error('pairing path not expected');
    },
  );
  provider.requestQrCodeActivation = async () => new ActivationFailedEvent(
    'cmd-fail-1',
    'corr-fail-1',
    'act-fail-1',
    session,
    '2026-03-30T10:15:00.000Z',
    'activation socket unavailable',
  );

  const service = new ActivationService(createFakeHost(provider));
  const activation = await service.requestQrCode(14, 'failed-session');

  assert.equal(activation.status, ActivationStatus.Failed);
  assert.equal(activation.failureReason, 'activation socket unavailable');
  assert.equal(activation.mode, ActivationMode.QrCode);
});
