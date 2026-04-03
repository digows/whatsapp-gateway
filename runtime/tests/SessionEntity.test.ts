import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationStateKey } from '../src/domain/entities/authentication/AuthenticationStateKey.js';
import { AuthenticationStateQuery } from '../src/domain/entities/authentication/AuthenticationStateQuery.js';
import { AuthenticationStateRecord } from '../src/domain/entities/authentication/AuthenticationStateRecord.js';
import { AuthenticationStateType } from '../src/domain/entities/authentication/AuthenticationStateType.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { Session } from '../src/domain/entities/session/Session.js';
import { SessionActivationState } from '../src/domain/entities/session/SessionActivationState.js';
import { SessionDesiredState } from '../src/domain/entities/session/SessionDesiredState.js';
import { SessionRuntimeState } from '../src/domain/entities/session/SessionRuntimeState.js';

test('Session creates a recoverable operational mirror only after credentials exist', () => {
  const sessionReference = new SessionReference('whatsapp-web', 77, 'numero-01');
  const createdSession = Session.create(sessionReference, '2026-03-30T14:00:00.000Z');

  assert.equal(createdSession.desiredState, SessionDesiredState.Active);
  assert.equal(createdSession.runtimeState, SessionRuntimeState.New);
  assert.equal(createdSession.activationState, SessionActivationState.Idle);
  assert.equal(createdSession.hasPersistedCredentials, false);
  assert.equal(createdSession.isRecoverable(), false);

  const persistedSession = createdSession
    .markPersistedCredentials('2026-03-30T14:01:00.000Z')
    .markConnected('worker-1', '2026-03-30T14:02:00.000Z', '5511999999999@s.whatsapp.net');

  assert.equal(persistedSession.hasPersistedCredentials, true);
  assert.equal(persistedSession.runtimeState, SessionRuntimeState.Connected);
  assert.equal(persistedSession.activationState, SessionActivationState.Completed);
  assert.equal(persistedSession.assignedWorkerId, 'worker-1');
  assert.equal(persistedSession.whatsappJid, '5511999999999@s.whatsapp.net');
  assert.equal(persistedSession.isRecoverable(), true);
});

test('Session knows whether authentication state belongs to it', () => {
  const sessionReference = new SessionReference('whatsapp-web', 88, 'numero-02');
  const session = Session.create(sessionReference, '2026-03-30T14:10:00.000Z');
  const ownedRecord = new AuthenticationStateRecord(
    sessionReference,
    new AuthenticationStateKey(AuthenticationStateType.Credentials, 'default'),
    '{}',
  );
  const foreignReference = new SessionReference('whatsapp-web', 88, 'numero-03');
  const foreignQuery = new AuthenticationStateQuery(
    foreignReference,
    AuthenticationStateType.Credentials,
    ['default'],
  );

  assert.equal(session.ownsAuthenticationStateRecord(ownedRecord), true);
  assert.equal(session.ownsAuthenticationStateQuery(foreignQuery), false);
});

test('Session clears credentials and worker ownership after logout', () => {
  const sessionReference = new SessionReference('whatsapp-web', 99, 'numero-04');
  const session = Session.create(sessionReference, '2026-03-30T14:20:00.000Z')
    .markPersistedCredentials('2026-03-30T14:21:00.000Z')
    .markConnected('worker-9', '2026-03-30T14:22:00.000Z')
    .markLoggedOut('2026-03-30T14:23:00.000Z', 'disconnect:401');

  assert.equal(session.runtimeState, SessionRuntimeState.LoggedOut);
  assert.equal(session.assignedWorkerId, undefined);
  assert.equal(session.hasPersistedCredentials, false);
  assert.equal(session.lastError, 'disconnect:401');
  assert.equal(session.isRecoverable(), false);
});
