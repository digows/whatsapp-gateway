import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { HealthResource } from '../src/application/restful/HealthResource.js';
import { SessionResource } from '../src/application/restful/SessionResource.js';
import { HostedSessionSnapshot } from '../src/domain/entities/operational/HostedSessionSnapshot.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { SessionStatus } from '../src/domain/entities/operational/SessionStatus.js';

class FakeWorkerHost {
  public stoppedSessions: SessionReference[] = [];

  constructor(
    private readonly started: boolean,
    private readonly providerId: string,
    private readonly workerId: string,
    private hostedSessions: HostedSessionSnapshot[],
  ) {}

  public isStarted(): boolean {
    return this.started;
  }

  public getProviderId(): string {
    return this.providerId;
  }

  public getWorkerId(): string {
    return this.workerId;
  }

  public getHostedSessionCount(): number {
    return this.hostedSessions.length;
  }

  public listHostedSessionSnapshots(): HostedSessionSnapshot[] {
    return [...this.hostedSessions];
  }

  public getHostedSessionSnapshot(
    session: SessionReference,
  ): HostedSessionSnapshot | undefined {
    return this.hostedSessions.find(snapshot => snapshot.session.toKey() === session.toKey());
  }

  public async stopSession(session: SessionReference): Promise<void> {
    this.stoppedSessions.push(session);
    this.hostedSessions = this.hostedSessions
      .filter(snapshot => snapshot.session.toKey() !== session.toKey());
  }
}

function createHostedSessionSnapshot(
  workspaceId: number,
  sessionId: string,
  status = SessionStatus.Connected,
): HostedSessionSnapshot {
  return new HostedSessionSnapshot(
    new SessionReference('whatsapp-web', workspaceId, sessionId),
    status,
    'worker-http-1',
    '2026-03-30T13:00:00.000Z',
    '2026-03-30T13:05:00.000Z',
  );
}

async function createServer(workerHost: FakeWorkerHost) {
  const server = Fastify();

  new HealthResource(workerHost).register(server);
  new SessionResource(workerHost).register(server);

  await server.ready();
  return server;
}

test('HealthResource returns worker health snapshot', async () => {
  const workerHost = new FakeWorkerHost(
    true,
    'whatsapp-web',
    'worker-http-1',
    [createHostedSessionSnapshot(401, 'ready-session')],
  );
  const server = await createServer(workerHost);

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
    });

    assert.equal(response.statusCode, 200);
    const health = response.json();

    assert.equal(health.status, 'ok');
    assert.equal(health.started, true);
    assert.equal(health.providerId, 'whatsapp-web');
    assert.equal(health.workerId, 'worker-http-1');
    assert.equal(health.hostedSessionCount, 1);
  } finally {
    await server.close();
  }
});

test('HealthResource returns HTTP 503 when worker is not ready', async () => {
  const workerHost = new FakeWorkerHost(
    false,
    'whatsapp-web',
    'worker-http-2',
    [],
  );
  const server = await createServer(workerHost);

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/readyz',
    });

    assert.equal(response.statusCode, 503);
    const health = response.json();

    assert.equal(health.status, 'not_ready');
    assert.equal(health.started, false);
  } finally {
    await server.close();
  }
});

test('SessionResource lists and fetches hosted sessions from the local worker view', async () => {
  const workerHost = new FakeWorkerHost(
    true,
    'whatsapp-web',
    'worker-http-1',
    [
      createHostedSessionSnapshot(501, 'session-a'),
      createHostedSessionSnapshot(501, 'session-b', SessionStatus.Reconnecting),
      createHostedSessionSnapshot(999, 'another-workspace'),
    ],
  );
  const server = await createServer(workerHost);

  try {
    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/workspaces/501/sessions',
    });

    assert.equal(listResponse.statusCode, 200);
    const sessions = listResponse.json();

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].session.workspaceId, 501);
    assert.equal(sessions[1].status, 'reconnecting');

    const getResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/workspaces/501/sessions/session-b',
    });

    assert.equal(getResponse.statusCode, 200);
    const session = getResponse.json();

    assert.equal(session.session.sessionId, 'session-b');
    assert.equal(session.workerId, 'worker-http-1');
    assert.equal(session.status, 'reconnecting');
  } finally {
    await server.close();
  }
});

test('SessionResource stops a hosted session and returns 404 when it does not exist', async () => {
  const workerHost = new FakeWorkerHost(
    true,
    'whatsapp-web',
    'worker-http-1',
    [createHostedSessionSnapshot(601, 'session-stop')],
  );
  const server = await createServer(workerHost);

  try {
    const stopResponse = await server.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/601/sessions/session-stop',
    });

    assert.equal(stopResponse.statusCode, 204);
    assert.equal(workerHost.stoppedSessions.length, 1);
    assert.equal(workerHost.stoppedSessions[0]?.sessionId, 'session-stop');

    const missingResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/workspaces/601/sessions/session-stop',
    });

    assert.equal(missingResponse.statusCode, 404);
    assert.equal(
      missingResponse.json().error,
      'Hosted session was not found on this worker.',
    );
  } finally {
    await server.close();
  }
});
