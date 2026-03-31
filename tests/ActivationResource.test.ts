import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ActivationResource } from '../src/application/restful/ActivationResource.js';
import { ActivationPairingCodeUpdatedEvent, ActivationQrCodeUpdatedEvent } from '../src/domain/entities/activation/ActivationEvent.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { ActivationService } from '../src/domain/services/ActivationService.js';
import { SessionLifecycleService } from '../src/domain/services/SessionLifecycleService.js';
import { InMemorySessionRepository } from './support/InMemorySessionRepository.js';

class FakeBaileysProvider {
  public lastQrCodeWaitTimeoutMs?: number;
  public lastPairingCodeRequest?: {
    phoneNumber: string;
    customPairingCode?: string;
    waitTimeoutMs?: number;
  };

  constructor(
    private readonly qrCodeEventFactory: () => Promise<ActivationQrCodeUpdatedEvent>,
    private readonly pairingCodeEventFactory: () => Promise<ActivationPairingCodeUpdatedEvent>,
  ) {}

  public async requestQrCodeActivation(waitTimeoutMs?: number): Promise<ActivationQrCodeUpdatedEvent> {
    this.lastQrCodeWaitTimeoutMs = waitTimeoutMs;
    return this.qrCodeEventFactory();
  }

  public async requestPairingCodeActivation(
    phoneNumber: string,
    customPairingCode?: string,
    waitTimeoutMs?: number,
  ): Promise<ActivationPairingCodeUpdatedEvent> {
    this.lastPairingCodeRequest = {
      phoneNumber,
      customPairingCode,
      waitTimeoutMs,
    };
    return this.pairingCodeEventFactory();
  }
}

async function createServer(
  provider: FakeBaileysProvider,
  onEnsureSessionStarted?: (session: SessionReference) => void,
) {
  const sessionLifecycleService = new SessionLifecycleService(new InMemorySessionRepository());
  const activationService = new ActivationService({
    async ensureSessionStarted(session: SessionReference): Promise<FakeBaileysProvider> {
      onEnsureSessionStarted?.(session);
      return provider;
    },
  }, sessionLifecycleService);

  const server = Fastify();
  new ActivationResource(activationService).register(server);
  await server.ready();
  return server;
}

test('ActivationResource returns QR code activation payload synchronously', async () => {
  let ensuredSession: SessionReference | undefined;
  const provider = new FakeBaileysProvider(
    async () => {
      if (!ensuredSession) {
        throw new Error('Expected session to be ensured before requesting activation.');
      }

      return new ActivationQrCodeUpdatedEvent(
        'cmd-http-qr-1',
        'corr-http-qr-1',
        'act-http-qr-1',
        ensuredSession,
        '2026-03-30T12:00:00.000Z',
        'http-qr-payload',
        1,
      );
    },
    async () => {
      throw new Error('Pairing code path was not expected.');
    },
  );
  const server = await createServer(
    provider,
    session => {
      ensuredSession = session;
    },
  );

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/workspaces/101/activations',
      payload: {
        mode: 'qr',
        waitTimeoutMs: 45000,
      },
    });

    assert.equal(response.statusCode, 200);
    const activation = response.json();

    assert.equal(activation.status, 'qr_code_ready');
    assert.equal(activation.mode, 'qr');
    assert.equal(activation.session.workspaceId, 101);
    assert.ok(activation.session.sessionId);
    assert.equal(activation.session.sessionId, ensuredSession?.sessionId);
    assert.equal(activation.qrCodeText, 'http-qr-payload');
    assert.ok(activation.qrCodeBase64);
    assert.equal(
      activation.eventSubject,
      `gateway.v1.channel.whatsapp-web.session.101.${activation.session.sessionId}.activation`,
    );
    assert.equal(provider.lastQrCodeWaitTimeoutMs, 45000);
  } finally {
    await server.close();
  }
});

test('ActivationResource returns pairing code activation payload synchronously', async () => {
  const session = new SessionReference('whatsapp-web', 202, 'rest-session');
  const provider = new FakeBaileysProvider(
    async () => {
      throw new Error('QR path was not expected.');
    },
    async () => new ActivationPairingCodeUpdatedEvent(
      'cmd-http-pair-1',
      'corr-http-pair-1',
      'act-http-pair-1',
      session,
      '2026-03-30T12:05:00.000Z',
      '123-456',
      1,
      '+5511999999999',
    ),
  );
  const server = await createServer(provider);

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/workspaces/202/activations',
      payload: {
        mode: 'pairing_code',
        sessionId: 'rest-session',
        phoneNumber: '+5511999999999',
        customPairingCode: 'CUSTOM01',
        waitTimeoutMs: 60000,
      },
    });

    assert.equal(response.statusCode, 200);
    const activation = response.json();

    assert.equal(activation.status, 'pairing_code_ready');
    assert.equal(activation.mode, 'pairing_code');
    assert.equal(activation.session.sessionId, 'rest-session');
    assert.equal(activation.pairingCode, '123-456');
    assert.equal(activation.phoneNumber, '+5511999999999');
    assert.deepEqual(provider.lastPairingCodeRequest, {
      phoneNumber: '+5511999999999',
      customPairingCode: 'CUSTOM01',
      waitTimeoutMs: 60000,
    });
  } finally {
    await server.close();
  }
});

test('ActivationResource rejects invalid activation requests with HTTP 400', async () => {
  const provider = new FakeBaileysProvider(
    async () => {
      throw new Error('QR path was not expected.');
    },
    async () => {
      throw new Error('Pairing code path was not expected.');
    },
  );
  const server = await createServer(provider);

  try {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/workspaces/303/activations',
      payload: {
        mode: 'pairing_code',
      },
    });

    assert.equal(response.statusCode, 400);
    const body = response.json();

    assert.equal(body.error, 'Invalid activation request.');
    assert.ok(Array.isArray(body.issues));
    assert.equal(body.issues[0]?.path, 'phoneNumber');
  } finally {
    await server.close();
  }
});
