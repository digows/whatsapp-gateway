import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticationStateType } from '../src/domain/entities/authentication/AuthenticationStateType.js';
import { parseMessageContentType } from '../src/domain/entities/messaging/MessageContentType.js';
import { parseChatType } from '../src/domain/entities/messaging/MessageContext.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { parseWorkerCommandAction } from '../src/domain/entities/operational/WorkerCommand.js';
import { WorkerHeartbeat } from '../src/domain/entities/operational/WorkerHeartbeat.js';
import { WorkerIdentity } from '../src/domain/entities/operational/WorkerIdentity.js';

test('SessionReference exposes a stable key and log label', () => {
  const session = new SessionReference('whatsapp-web', 42, 'session-123');

  assert.equal(session.toKey(), 'whatsapp-web:42:session-123');
  assert.equal(
    session.toLogLabel(),
    'whatsapp-web session session-123 (WS: 42)',
  );
});

test('WorkerHeartbeat exports the registry payload', () => {
  const workerIdentity = WorkerIdentity.current();
  const heartbeat = WorkerHeartbeat.capture(
    'whatsapp-web',
    workerIdentity,
    3,
    50,
  );

  const payload = heartbeat.toRegistryPayload();

  assert.equal(payload.provider, 'whatsapp-web');
  assert.equal(payload.worker_id, workerIdentity.id);
  assert.equal(payload.current_sessions, 3);
  assert.equal(payload.max_capacity, 50);
  assert.ok(Number(payload.cpu_usage) >= 0);
  assert.ok(Number(payload.memory_usage_mb) >= 0);
  assert.ok(Number(payload.last_pulse) > 0);
});

test('domain parsers reject unsupported external values', () => {
  assert.equal(parseWorkerCommandAction('start_session'), 'start_session');
  assert.equal(parseChatType('group'), 'group');
  assert.equal(parseMessageContentType('document'), 'document');

  assert.throws(() => {
    parseWorkerCommandAction('restart_session');
  }, /Unsupported worker command action/);

  assert.throws(() => {
    parseChatType('channel');
  }, /Unsupported chat type/);

  assert.throws(() => {
    parseMessageContentType('sticker');
  }, /Unsupported message content type/);
});

test('AuthenticationStateType centralizes known key kinds', () => {
  assert.equal(
    AuthenticationStateType.fromValue('creds'),
    AuthenticationStateType.Credentials,
  );
  assert.equal(AuthenticationStateType.IdentityKey.isBinary(), true);
  assert.equal(AuthenticationStateType.AppStateSyncKey.isAppStateSyncKey(), true);
  assert.equal(
    AuthenticationStateType.fromValue('future-baileys-type').value,
    'future-baileys-type',
  );
});
