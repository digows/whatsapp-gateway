import crypto from 'crypto';
import { env } from './config/env.js';
import { WorkerTransport } from './contracts/WorkerTransport.js';
import { SessionDesiredState } from '../domain/entities/session/SessionDesiredState.js';
import { Session } from '../domain/entities/session/Session.js';
import { WorkerCommand, WorkerCommandAction } from '../domain/entities/operational/WorkerCommand.js';
import { WorkerHeartbeat } from '../domain/entities/operational/WorkerHeartbeat.js';
import { WorkerIdentity } from '../domain/entities/operational/WorkerIdentity.js';
import { SessionRepository } from '../domain/repositories/session/SessionRepository.js';
import { SessionLifecycleService } from '../domain/services/SessionLifecycleService.js';
import { PgSessionRepository } from '../infrastructure/pg/PgSessionRepository.js';
import { RedisLeaderElection } from '../infrastructure/redis/RedisLeaderElection.js';
import { RedisSessionCoordinator } from '../infrastructure/redis/RedisSessionCoordinator.js';
import { RedisWorkerRegistryReader } from '../infrastructure/redis/RedisWorkerRegistryReader.js';

interface PendingWorkerCommand {
  readonly workerId: string;
  readonly expiresAtEpochMs: number;
}

interface EmbeddedControlPlaneOptions {
  providerId?: string;
  sessionLifecycleService?: SessionLifecycleService;
  sessionRepository?: SessionRepository;
  transport: WorkerTransport;
  workerIdentity?: WorkerIdentity;
  sessionCoordinator?: Pick<RedisSessionCoordinator, 'getAssignedWorker'>;
  leaderElection?: Pick<RedisLeaderElection, 'tryAcquireOrRenewLeadership' | 'stop'>;
  workerRegistryReader?: Pick<RedisWorkerRegistryReader, 'listHealthyWorkers'>;
}

/**
 * Embedded single-leader control plane.
 * It reconciles durable Session entities with live worker ownership and capacity,
 * then issues worker commands through the existing broker boundary.
 */
export class EmbeddedControlPlane {
  private readonly providerId: string;
  private readonly workerIdentity: WorkerIdentity;
  private readonly sessionRepository: SessionRepository;
  private readonly sessionLifecycleService: SessionLifecycleService;
  private readonly sessionCoordinator: Pick<RedisSessionCoordinator, 'getAssignedWorker'>;
  private readonly leaderElection: Pick<RedisLeaderElection, 'tryAcquireOrRenewLeadership' | 'stop'>;
  private readonly workerRegistryReader: Pick<RedisWorkerRegistryReader, 'listHealthyWorkers'>;

  private reconcileTimer?: NodeJS.Timeout;
  private reconciliationInFlight = false;
  private currentlyLeads = false;
  private readonly pendingStartCommands = new Map<string, PendingWorkerCommand>();
  private readonly pendingStopCommands = new Map<string, PendingWorkerCommand>();

  constructor(private readonly options: EmbeddedControlPlaneOptions) {
    this.providerId = options.providerId ?? env.CHANNEL_PROVIDER_ID;
    this.workerIdentity = options.workerIdentity ?? WorkerIdentity.current();
    this.sessionRepository = options.sessionRepository ?? new PgSessionRepository();
    this.sessionLifecycleService = options.sessionLifecycleService
      ?? new SessionLifecycleService(this.sessionRepository);
    this.sessionCoordinator = options.sessionCoordinator
      ?? new RedisSessionCoordinator(this.workerIdentity);
    this.leaderElection = options.leaderElection
      ?? new RedisLeaderElection(this.providerId, this.workerIdentity.id);
    this.workerRegistryReader = options.workerRegistryReader
      ?? new RedisWorkerRegistryReader();

    if (env.CONTROL_PLANE_RECONCILE_INTERVAL_MS >= env.CONTROL_PLANE_LEADER_TTL_MS) {
      throw new Error(
        'CONTROL_PLANE_RECONCILE_INTERVAL_MS must be lower than CONTROL_PLANE_LEADER_TTL_MS.',
      );
    }
  }

  public async start(): Promise<void> {
    if (!env.CONTROL_PLANE_ENABLED || this.reconcileTimer) {
      return;
    }

    console.log(
      `[CTRL] Starting embedded control plane participant ${this.workerIdentity.id} for ${this.providerId}.`,
    );

    await this.runReconciliationTick();

    this.reconcileTimer = setInterval(() => {
      void this.runReconciliationTick();
    }, env.CONTROL_PLANE_RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  public async stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }

    this.pendingStartCommands.clear();
    this.pendingStopCommands.clear();
    this.currentlyLeads = false;
    await this.leaderElection.stop();
  }

  private async runReconciliationTick(): Promise<void> {
    if (this.reconciliationInFlight) {
      return;
    }

    this.reconciliationInFlight = true;

    try {
      const leadsNow = await this.leaderElection.tryAcquireOrRenewLeadership();
      if (leadsNow && !this.currentlyLeads) {
        console.log(`[CTRL] ${this.workerIdentity.id} became leader for ${this.providerId}.`);
      } else if (!leadsNow && this.currentlyLeads) {
        console.log(`[CTRL] ${this.workerIdentity.id} lost leadership for ${this.providerId}.`);
      }

      this.currentlyLeads = leadsNow;

      if (!leadsNow) {
        return;
      }

      await this.reconcileSessions();
    } catch (error) {
      console.error('[CTRL] Reconciliation tick failed.', error);
    } finally {
      this.reconciliationInFlight = false;
    }
  }

  private async reconcileSessions(): Promise<void> {
    const sessions = await this.sessionRepository.listByProvider(this.providerId);
    const healthyWorkers = await this.workerRegistryReader.listHealthyWorkers(this.providerId);

    if (healthyWorkers.length === 0) {
      return;
    }

    const healthyWorkersById = new Map(
      healthyWorkers.map(workerHeartbeat => [workerHeartbeat.workerId, workerHeartbeat] as const),
    );
    const plannedLoadByWorkerId = new Map(
      healthyWorkers.map(workerHeartbeat => [workerHeartbeat.workerId, workerHeartbeat.currentSessions]),
    );

    for (const session of sessions) {
      await this.reconcileSingleSession(
        session,
        healthyWorkersById,
        plannedLoadByWorkerId,
      );
    }
  }

  private async reconcileSingleSession(
    session: Session,
    healthyWorkersById: ReadonlyMap<string, WorkerHeartbeat>,
    plannedLoadByWorkerId: Map<string, number>,
  ): Promise<void> {
    const liveOwnerWorkerId = await this.getLiveOwnerWorkerId(session, healthyWorkersById);
    const sessionKey = session.reference.toKey();

    if (liveOwnerWorkerId) {
      this.pendingStartCommands.delete(sessionKey);
      if (session.desiredState === SessionDesiredState.Active) {
        this.pendingStopCommands.delete(sessionKey);
        return;
      }

      if (this.hasFreshPendingCommand(this.pendingStopCommands, session.reference, liveOwnerWorkerId)) {
        return;
      }

      await this.dispatchWorkerCommand(
        liveOwnerWorkerId,
        new WorkerCommand(
          crypto.randomUUID(),
          WorkerCommandAction.StopSession,
          session.reference,
        ),
      );
      this.pendingStopCommands.set(sessionKey, this.createPendingWorkerCommand(liveOwnerWorkerId));
      return;
    }

    this.pendingStopCommands.delete(sessionKey);
    await this.clearStaleWorkerAssignment(session, healthyWorkersById);

    if (session.desiredState !== SessionDesiredState.Active || !session.isRecoverable()) {
      this.pendingStartCommands.delete(sessionKey);
      return;
    }

    if (this.hasFreshPendingCommand(this.pendingStartCommands, session.reference)) {
      return;
    }

    const targetWorker = this.chooseTargetWorker(session, healthyWorkersById, plannedLoadByWorkerId);
    if (!targetWorker) {
      return;
    }

    await this.dispatchWorkerCommand(
      targetWorker.workerId,
      new WorkerCommand(
        crypto.randomUUID(),
        WorkerCommandAction.StartSession,
        session.reference,
      ),
    );

    plannedLoadByWorkerId.set(
      targetWorker.workerId,
      (plannedLoadByWorkerId.get(targetWorker.workerId) ?? targetWorker.currentSessions) + 1,
    );
    this.pendingStartCommands.set(
      sessionKey,
      this.createPendingWorkerCommand(targetWorker.workerId),
    );
  }

  private async getLiveOwnerWorkerId(
    session: Session,
    healthyWorkersById: ReadonlyMap<string, WorkerHeartbeat>,
  ): Promise<string | undefined> {
    const assignedWorkerId = await this.sessionCoordinator.getAssignedWorker(session.reference);
    if (!assignedWorkerId) {
      return undefined;
    }

    return healthyWorkersById.has(assignedWorkerId) ? assignedWorkerId : undefined;
  }

  private async clearStaleWorkerAssignment(
    session: Session,
    healthyWorkersById: ReadonlyMap<string, WorkerHeartbeat>,
  ): Promise<void> {
    if (!session.assignedWorkerId || healthyWorkersById.has(session.assignedWorkerId)) {
      return;
    }

    try {
      await this.sessionLifecycleService.clearWorkerAssignment(
        session.reference,
        new Date().toISOString(),
      );
    } catch (error) {
      console.error(
        `[CTRL] Failed to clear stale worker assignment for ${session.reference.toLogLabel()}.`,
        error,
      );
    }
  }

  private chooseTargetWorker(
    session: Session,
    healthyWorkersById: ReadonlyMap<string, WorkerHeartbeat>,
    plannedLoadByWorkerId: ReadonlyMap<string, number>,
  ): WorkerHeartbeat | undefined {
    const preferredWorkerId = session.assignedWorkerId;
    if (preferredWorkerId) {
      const preferredWorker = healthyWorkersById.get(preferredWorkerId);
      if (
        preferredWorker
        && (plannedLoadByWorkerId.get(preferredWorkerId) ?? preferredWorker.currentSessions)
          < preferredWorker.maxCapacity
      ) {
        return preferredWorker;
      }
    }

    return Array.from(healthyWorkersById.values())
      .filter(workerHeartbeat =>
        (plannedLoadByWorkerId.get(workerHeartbeat.workerId) ?? workerHeartbeat.currentSessions)
          < workerHeartbeat.maxCapacity)
      .sort((left, right) => {
        const leftLoad = plannedLoadByWorkerId.get(left.workerId) ?? left.currentSessions;
        const rightLoad = plannedLoadByWorkerId.get(right.workerId) ?? right.currentSessions;

        if (leftLoad !== rightLoad) {
          return leftLoad - rightLoad;
        }

        return left.workerId.localeCompare(right.workerId);
      })[0];
  }

  private async dispatchWorkerCommand(
    workerId: string,
    workerCommand: WorkerCommand,
  ): Promise<void> {
    await this.options.transport.publishWorkerCommand(workerCommand, workerId);
  }

  private hasFreshPendingCommand(
    pendingCommands: Map<string, PendingWorkerCommand>,
    sessionReference: Session['reference'],
    workerId?: string,
  ): boolean {
    const sessionKey = sessionReference.toKey();
    const pendingCommand = pendingCommands.get(sessionKey);
    if (!pendingCommand) {
      return false;
    }

    if (pendingCommand.expiresAtEpochMs <= Date.now()) {
      pendingCommands.delete(sessionKey);
      return false;
    }

    if (workerId && pendingCommand.workerId !== workerId) {
      return false;
    }

    return true;
  }

  private createPendingWorkerCommand(workerId: string): PendingWorkerCommand {
    return {
      workerId,
      expiresAtEpochMs: Date.now() + env.CONTROL_PLANE_COMMAND_COOLDOWN_MS,
    };
  }
}
