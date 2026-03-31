import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbeddedControlPlane } from '../src/application/EmbeddedControlPlane.js';
import { WorkerTransport } from '../src/application/contracts/WorkerTransport.js';
import { SessionReference } from '../src/domain/entities/operational/SessionReference.js';
import { WorkerCommand, WorkerCommandAction } from '../src/domain/entities/operational/WorkerCommand.js';
import { WorkerHeartbeat } from '../src/domain/entities/operational/WorkerHeartbeat.js';
import { WorkerIdentity } from '../src/domain/entities/operational/WorkerIdentity.js';
import { Session } from '../src/domain/entities/session/Session.js';
import { SessionDesiredState } from '../src/domain/entities/session/SessionDesiredState.js';
import { SessionLifecycleService } from '../src/domain/services/SessionLifecycleService.js';
import { InMemorySessionRepository } from './support/InMemorySessionRepository.js';

class FakeWorkerTransport implements WorkerTransport {
  public readonly workerCommands: Array<{ workerId: string; command: WorkerCommand }> = [];

  public async connect(): Promise<void> {}
  public async disconnect(): Promise<void> {}
  public async publishWorkerCommand(command: WorkerCommand, workerId: string): Promise<void> {
    this.workerCommands.push({ workerId, command });
  }
  public async subscribeWorkerCommands(): Promise<void> {}
  public async subscribeOutgoing(): Promise<void> {}
  public async disconnectSession(): Promise<void> {}
  public async publishActivation(): Promise<void> {}
  public async publishInbound(): Promise<void> {}
  public async publishDelivery(): Promise<void> {}
  public async publishSessionStatus(): Promise<void> {}
}

class FakeLeaderElection {
  constructor(private readonly leads: boolean) {}

  public async tryAcquireOrRenewLeadership(): Promise<boolean> {
    return this.leads;
  }

  public async stop(): Promise<void> {}
}

class FakeSessionCoordinator {
  constructor(private readonly assignments = new Map<string, string>()) {}

  public async getAssignedWorker(session: SessionReference): Promise<string | null> {
    return this.assignments.get(session.toKey()) ?? null;
  }
}

class FakeWorkerRegistryReader {
  constructor(private readonly healthyWorkers: readonly WorkerHeartbeat[]) {}

  public async listHealthyWorkers(): Promise<readonly WorkerHeartbeat[]> {
    return this.healthyWorkers;
  }
}

test('EmbeddedControlPlane dispatches start_session for recoverable sessions without live owner', async () => {
  const sessionRepository = new InMemorySessionRepository();
  const sessionLifecycleService = new SessionLifecycleService(sessionRepository);
  const sessionReference = new SessionReference('whatsapp-web', 71, 'recover-me');
  await sessionRepository.save(
    Session.create(sessionReference, '2026-03-31T12:00:00.000Z')
      .markPersistedCredentials('2026-03-31T12:01:00.000Z')
      .markStopped('2026-03-31T12:02:00.000Z'),
  );

  const workerTransport = new FakeWorkerTransport();
  const embeddedControlPlane = new EmbeddedControlPlane({
    providerId: 'whatsapp-web',
    sessionRepository,
    sessionLifecycleService,
    transport: workerTransport,
    workerIdentity: new WorkerIdentity('worker-control-1'),
    leaderElection: new FakeLeaderElection(true),
    sessionCoordinator: new FakeSessionCoordinator(),
    workerRegistryReader: new FakeWorkerRegistryReader([
      new WorkerHeartbeat('whatsapp-web', 'worker-a', 5, 50, 0, 64, Date.now()),
      new WorkerHeartbeat('whatsapp-web', 'worker-b', 2, 50, 0, 64, Date.now()),
    ]),
  });

  await embeddedControlPlane.start();
  await embeddedControlPlane.stop();

  assert.equal(workerTransport.workerCommands.length, 1);
  assert.equal(workerTransport.workerCommands[0]?.workerId, 'worker-b');
  assert.equal(
    workerTransport.workerCommands[0]?.command.action,
    WorkerCommandAction.StartSession,
  );
  assert.equal(
    workerTransport.workerCommands[0]?.command.session.toKey(),
    sessionReference.toKey(),
  );
});

test('EmbeddedControlPlane dispatches stop_session when desired state is stopped but owner is still alive', async () => {
  const sessionRepository = new InMemorySessionRepository();
  const sessionLifecycleService = new SessionLifecycleService(sessionRepository);
  const sessionReference = new SessionReference('whatsapp-web', 72, 'stop-me');
  await sessionRepository.save(
    Session.create(sessionReference, '2026-03-31T13:00:00.000Z')
      .markPersistedCredentials('2026-03-31T13:01:00.000Z')
      .markConnected('worker-a', '2026-03-31T13:02:00.000Z')
      .withDesiredState(SessionDesiredState.Stopped, '2026-03-31T13:03:00.000Z'),
  );

  const workerTransport = new FakeWorkerTransport();
  const embeddedControlPlane = new EmbeddedControlPlane({
    providerId: 'whatsapp-web',
    sessionRepository,
    sessionLifecycleService,
    transport: workerTransport,
    workerIdentity: new WorkerIdentity('worker-control-1'),
    leaderElection: new FakeLeaderElection(true),
    sessionCoordinator: new FakeSessionCoordinator(
      new Map([[sessionReference.toKey(), 'worker-a']]),
    ),
    workerRegistryReader: new FakeWorkerRegistryReader([
      new WorkerHeartbeat('whatsapp-web', 'worker-a', 3, 50, 0, 64, Date.now()),
    ]),
  });

  await embeddedControlPlane.start();
  await embeddedControlPlane.stop();

  assert.equal(workerTransport.workerCommands.length, 1);
  assert.equal(workerTransport.workerCommands[0]?.workerId, 'worker-a');
  assert.equal(
    workerTransport.workerCommands[0]?.command.action,
    WorkerCommandAction.StopSession,
  );
});
