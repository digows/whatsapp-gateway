import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
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
