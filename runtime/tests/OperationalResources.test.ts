import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { HealthResource } from '../src/application/restful/HealthResource.js';
import { HostedSessionResource } from '../src/application/restful/HostedSessionResource.js';
import { SessionResource } from '../src/application/restful/SessionResource.js';
import { HostedSessionSnapshot } from '../src/domain/entities/operational/HostedSessionSnapshot.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { Session } from '../src/domain/entities/session/Session.js';
import { SessionDesiredState } from '../src/domain/entities/session/SessionDesiredState.js';
import { SessionStatus } from '../src/domain/entities/operational/SessionStatus.js';
import { SessionLifecycleService } from '../src/domain/services/SessionLifecycleService.js';
import { InMemorySessionRepository } from './support/InMemorySessionRepository.js';

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

async function createServer(
  workerHost: FakeWorkerHost,
  durableSessions: readonly Session[] = [],
) {
  const sessionRepository = new InMemorySessionRepository();
  for (const durableSession of durableSessions) {
    await sessionRepository.save(durableSession);
  }

  const sessionLifecycleService = new SessionLifecycleService(sessionRepository);
  const server = Fastify();

  new HealthResource(workerHost).register(server);
  new SessionResource(sessionRepository, sessionLifecycleService, workerHost).register(server);
  new HostedSessionResource(workerHost).register(server);

  await server.ready();
  return {
    server,
    sessionLifecycleService,
    sessionRepository,
  };
}

function createDurableSession(
  workspaceId: number,
  sessionId: string,
): Session {
  return Session.create(
    new SessionReference('whatsapp-web', workspaceId, sessionId),
    '2026-03-30T12:55:00.000Z',
  );
}

test('HealthResource returns worker health snapshot', async () => {
  const workerHost = new FakeWorkerHost(
    true,
    'whatsapp-web',
    'worker-http-1',
    [createHostedSessionSnapshot(401, 'ready-session')],
  );
  const { server } = await createServer(workerHost);

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
  const { server } = await createServer(workerHost);

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

test('SessionResource lists and fetches durable sessions from the global session catalog', async () => {
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
  const durableSessions = [
    createDurableSession(501, 'session-a')
      .markPersistedCredentials('2026-03-30T13:00:00.000Z')
      .markConnected('worker-http-1', '2026-03-30T13:05:00.000Z'),
    createDurableSession(501, 'session-b')
      .markPersistedCredentials('2026-03-30T13:10:00.000Z')
      .markReconnecting('worker-http-2', '2026-03-30T13:15:00.000Z', 'disconnect:515'),
    createDurableSession(999, 'another-workspace')
      .markPersistedCredentials('2026-03-30T13:20:00.000Z'),
  ];
  const { server } = await createServer(workerHost, durableSessions);

  try {
    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/workspaces/501/sessions',
    });

    assert.equal(listResponse.statusCode, 200);
    const sessions = listResponse.json();

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].reference.workspaceId, 501);
    assert.equal(sessions[1].runtimeState, 'reconnecting');

    const getResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/workspaces/501/sessions/session-b',
    });

    assert.equal(getResponse.statusCode, 200);
    const session = getResponse.json();

    assert.equal(session.reference.sessionId, 'session-b');
    assert.equal(session.assignedWorkerId, 'worker-http-2');
    assert.equal(session.runtimeState, 'reconnecting');
  } finally {
    await server.close();
  }
});

test('HostedSessionResource exposes only the local worker view', async () => {
  const workerHost = new FakeWorkerHost(
    true,
    'whatsapp-web',
    'worker-http-1',
    [
      createHostedSessionSnapshot(777, 'local-a'),
      createHostedSessionSnapshot(777, 'local-b', SessionStatus.Reconnecting),
    ],
  );
  const { server } = await createServer(workerHost);

  try {
    const listResponse = await server.inject({
      method: 'GET',
      url: '/internal/v1/workspaces/777/hosted-sessions',
    });

    assert.equal(listResponse.statusCode, 200);
    assert.equal(listResponse.json().length, 2);

    const getResponse = await server.inject({
      method: 'GET',
      url: '/internal/v1/workspaces/777/hosted-sessions/local-b',
    });

    assert.equal(getResponse.statusCode, 200);
    assert.equal(getResponse.json().status, 'reconnecting');
  } finally {
    await server.close();
  }
});

test('SessionResource updates desired state in the durable catalog even when the session is not local', async () => {
  const workerHost = new FakeWorkerHost(
    true,
    'whatsapp-web',
    'worker-http-1',
    [],
  );
  const durableSession = createDurableSession(888, 'remote-session')
    .markPersistedCredentials('2026-03-30T14:00:00.000Z')
    .markConnected('worker-http-2', '2026-03-30T14:05:00.000Z');
  const { server, sessionRepository } = await createServer(workerHost, [durableSession]);

  try {
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/v1/workspaces/888/sessions/remote-session',
      payload: {
        desiredState: 'paused',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().desiredState, 'paused');
    assert.equal(workerHost.stoppedSessions.length, 0);
    assert.equal(
      (await sessionRepository.findByReference(
        new SessionReference('whatsapp-web', 888, 'remote-session'),
      ))?.desiredState,
      SessionDesiredState.Paused,
    );
  } finally {
    await server.close();
  }
});

test('SessionResource stops a session globally and the hosted view disappears locally', async () => {
  const workerHost = new FakeWorkerHost(
    true,
    'whatsapp-web',
    'worker-http-1',
    [createHostedSessionSnapshot(601, 'session-stop')],
  );
  const sessionReference = new SessionReference('whatsapp-web', 601, 'session-stop');
  const durableSession = createDurableSession(601, 'session-stop')
    .markPersistedCredentials('2026-03-30T13:00:00.000Z')
    .markConnected('worker-http-1', '2026-03-30T13:05:00.000Z');
  const { server, sessionRepository } = await createServer(workerHost, [durableSession]);

  try {
    const stopResponse = await server.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/601/sessions/session-stop',
    });

    assert.equal(stopResponse.statusCode, 204);
    assert.equal(workerHost.stoppedSessions.length, 1);
    assert.equal(workerHost.stoppedSessions[0]?.sessionId, 'session-stop');
    assert.equal(
      (await sessionRepository.findByReference(sessionReference))?.desiredState,
      SessionDesiredState.Stopped,
    );

    const publicSessionResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/workspaces/601/sessions/session-stop',
    });

    assert.equal(publicSessionResponse.statusCode, 200);
    assert.equal(publicSessionResponse.json().desiredState, 'stopped');

    const missingHostedResponse = await server.inject({
      method: 'GET',
      url: '/internal/v1/workspaces/601/hosted-sessions/session-stop',
    });

    assert.equal(missingHostedResponse.statusCode, 404);
    assert.equal(missingHostedResponse.json().error, 'Hosted session was not found on this worker.');
  } finally {
    await server.close();
  }
});
