import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { SessionActivationState } from '../src/domain/entities/session/SessionActivationState.js';
import { SessionRuntimeState } from '../src/domain/entities/session/SessionRuntimeState.js';
import { SessionLifecycleService } from '../src/domain/services/SessionLifecycleService.js';
import { InMemorySessionRepository } from './support/InMemorySessionRepository.js';

test('SessionLifecycleService creates and advances the mirrored session lifecycle', async () => {
  const sessionRepository = new InMemorySessionRepository();
  const sessionLifecycleService = new SessionLifecycleService(sessionRepository);
  const sessionReference = new SessionReference('whatsapp-web', 42, 'lifecycle-session');

  await sessionLifecycleService.ensureSession(sessionReference, '2026-03-31T10:00:00.000Z');
  await sessionLifecycleService.beginQrCodeActivation(
    sessionReference,
    '2026-03-31T10:01:00.000Z',
  );
  await sessionLifecycleService.markStarting(
    sessionReference,
    'worker-a',
    '2026-03-31T10:02:00.000Z',
  );
  await sessionLifecycleService.markPersistedCredentials(
    sessionReference,
    '2026-03-31T10:03:00.000Z',
  );
  await sessionLifecycleService.markConnected(
    sessionReference,
    'worker-a',
    '2026-03-31T10:04:00.000Z',
    '5511999999999@s.whatsapp.net',
  );

  const mirroredSession = await sessionRepository.findByReference(sessionReference);

  assert.ok(mirroredSession);
  assert.equal(mirroredSession.runtimeState, SessionRuntimeState.Connected);
  assert.equal(mirroredSession.activationState, SessionActivationState.Completed);
  assert.equal(mirroredSession.assignedWorkerId, 'worker-a');
  assert.equal(mirroredSession.hasPersistedCredentials, true);
  assert.equal(mirroredSession.whatsappJid, '5511999999999@s.whatsapp.net');
});

test('SessionLifecycleService clears durable auth and worker assignment on logout', async () => {
  const sessionRepository = new InMemorySessionRepository();
  const sessionLifecycleService = new SessionLifecycleService(sessionRepository);
  const sessionReference = new SessionReference('whatsapp-web', 43, 'logout-session');

  await sessionLifecycleService.markStarting(
    sessionReference,
    'worker-b',
    '2026-03-31T11:00:00.000Z',
  );
  await sessionLifecycleService.markPersistedCredentials(
    sessionReference,
    '2026-03-31T11:01:00.000Z',
  );
  await sessionLifecycleService.markLoggedOut(
    sessionReference,
    '2026-03-31T11:02:00.000Z',
    'disconnect:401',
  );

  const mirroredSession = await sessionRepository.findByReference(sessionReference);

  assert.ok(mirroredSession);
  assert.equal(mirroredSession.runtimeState, SessionRuntimeState.LoggedOut);
  assert.equal(mirroredSession.hasPersistedCredentials, false);
  assert.equal(mirroredSession.assignedWorkerId, undefined);
  assert.equal(mirroredSession.lastError, 'disconnect:401');
});
