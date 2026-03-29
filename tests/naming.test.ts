import assert from 'node:assert/strict';
import test from 'node:test';
import { renderConfigTemplate } from '../src/application/config/renderConfigTemplate.js';
import { NatsSubjectBuilder } from '../src/infrastructure/nats/NatsSubjectBuilder.js';
import { RedisKeyBuilder } from '../src/infrastructure/redis/RedisKeyBuilder.js';

test('renderConfigTemplate replaces placeholders and fails on missing values', () => {
  assert.equal(
    renderConfigTemplate('subject.{provider}.{sessionId}', {
      provider: 'whatsapp-web',
      sessionId: 'session-1',
    }),
    'subject.whatsapp-web.session-1',
  );

  assert.throws(
    () => {
      renderConfigTemplate('subject.{provider}.{sessionId}', {
        provider: 'whatsapp-web',
      });
    },
    /Missing config template placeholder "sessionId"/,
  );
});

test('NatsSubjectBuilder uses the configured default subjects', () => {
  const session = {
    provider: 'whatsapp-web',
    workspaceId: 7,
    sessionId: 'session-a',
  };

  assert.equal(
    NatsSubjectBuilder.getWorkerControlSubject('whatsapp-web', 'worker-1'),
    'gateway.v1.channel.whatsapp-web.worker.worker-1.control',
  );
  assert.equal(
    NatsSubjectBuilder.getSessionSubject(session, 'incoming'),
    'gateway.v1.channel.whatsapp-web.session.7.session-a.incoming',
  );
  assert.equal(
    NatsSubjectBuilder.getSessionSubject(session, 'outgoing'),
    'gateway.v1.channel.whatsapp-web.session.7.session-a.outgoing',
  );
  assert.equal(
    NatsSubjectBuilder.getSessionSubject(session, 'delivery'),
    'gateway.v1.channel.whatsapp-web.session.7.session-a.delivery',
  );
  assert.equal(
    NatsSubjectBuilder.getSessionSubject(session, 'status'),
    'gateway.v1.channel.whatsapp-web.session.7.session-a.status',
  );
  assert.equal(
    NatsSubjectBuilder.getActivationSubject(session),
    'gateway.v1.channel.whatsapp-web.session.7.session-a.activation',
  );
});

test('RedisKeyBuilder uses the configured default keys', () => {
  const session = {
    provider: 'whatsapp-web',
    workspaceId: 7,
    sessionId: 'session-a',
  };

  assert.equal(
    RedisKeyBuilder.getSessionLockKey(session),
    'wa:7:lock:session:session-a',
  );
  assert.equal(
    RedisKeyBuilder.getSessionWorkerRegistryKey(session),
    'wa:7:registry:workers',
  );
  assert.equal(
    RedisKeyBuilder.getClusterAliveKey('worker-1'),
    'wa:cluster:alive:worker-1',
  );
  assert.equal(
    RedisKeyBuilder.getClusterHealthKey(),
    'wa:cluster:health',
  );
  assert.equal(
    RedisKeyBuilder.getAuthRecordKey(7, 'session-a', 'creds', 'default'),
    'wa:7:auth:session-a:creds:default',
  );
  assert.equal(
    RedisKeyBuilder.getAuthRecordKeyPrefix(7, 'session-a', 'app-state-sync-key'),
    'wa:7:auth:session-a:app-state-sync-key:',
  );
  assert.equal(
    RedisKeyBuilder.getAuthSessionPattern(7, 'session-a'),
    'wa:7:auth:session-a:*',
  );
  assert.equal(
    RedisKeyBuilder.getLidMappingKey(7, '12345@lid'),
    'wa:7:lid-mapping:12345@lid',
  );
  assert.equal(
    RedisKeyBuilder.getAntiBanWarmUpKey(session),
    'wa:whatsapp-web:7:antiban:warmup:session-a',
  );
});
