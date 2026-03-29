import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionDescriptor } from '../src/domain/entities/SessionDescriptor.js';
import { WorkerHeartbeat } from '../src/domain/entities/WorkerHeartbeat.js';
import { WorkerIdentity } from '../src/domain/entities/WorkerIdentity.js';

test('SessionDescriptor exposes a stable key and log label', () => {
  const session = new SessionDescriptor('whatsapp-web', 42, 'session-123');

  assert.equal(session.toKey(), 'whatsapp-web:42:session-123');
  assert.equal(
    session.toLogLabel(),
    'whatsapp-web session session-123 (WS: 42)',
  );
});

test('WorkerHeartbeat exports the local contract payload', () => {
  const workerIdentity = WorkerIdentity.current();
  const heartbeat = WorkerHeartbeat.capture(
    'whatsapp-web',
    workerIdentity,
    3,
    50,
  );

  const contract = heartbeat.toContract();

  assert.equal(contract.provider, 'whatsapp-web');
  assert.equal(contract.workerId, workerIdentity.id);
  assert.equal(contract.currentSessions, 3);
  assert.equal(contract.maxCapacity, 50);
  assert.ok(contract.cpuUsageMicros >= 0);
  assert.ok(contract.memoryUsageMb >= 0);
  assert.ok(contract.lastPulse > 0);
});
