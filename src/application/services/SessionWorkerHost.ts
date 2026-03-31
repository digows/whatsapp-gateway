import { env } from '../config/env.js';
import { WorkerTransport } from '../contracts/WorkerTransport.js';
import {
  ActivationEvent,
  ActivationEventType,
} from '../../domain/entities/activation/ActivationEvent.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import {
  SessionStatus,
  SessionStatusEvent,
} from '../../domain/entities/operational/SessionStatus.js';
import { HostedSessionSnapshot } from '../../domain/entities/operational/HostedSessionSnapshot.js';
import {
  WorkerCommand,
  WorkerCommandAction,
} from '../../domain/entities/operational/WorkerCommand.js';
import { WorkerIdentity } from '../../domain/entities/operational/WorkerIdentity.js';
import {
  BaileysProvider,
  BaileysProviderCallbacks,
} from '../../infrastructure/baileys/BaileysProvider.js';
import { NatsChannelTransport } from '../../infrastructure/nats/NatsChannelTransport.js';
import { PgConnection } from '../../infrastructure/pg/PgConnection.js';
import { PgSessionRepository } from '../../infrastructure/pg/PgSessionRepository.js';
import { RedisConnection } from '../../infrastructure/redis/RedisConnection.js';
import {
  RedisSessionCoordinator,
  SessionLease,
} from '../../infrastructure/redis/RedisSessionCoordinator.js';
import { RedisWorkerHealthReporter } from '../../infrastructure/redis/RedisWorkerHealthReporter.js';
import { SessionLifecycleService } from '../../domain/services/SessionLifecycleService.js';

interface HostedSession {
  session: SessionReference;
  provider: BaileysProvider;
  lease: SessionLease;
  status: SessionStatus;
  hostedAt: string;
  updatedAt: string;
  reason?: string;
  lockHeartbeat?: NodeJS.Timeout;
  lockHeartbeatStopped?: boolean;
}

interface SessionWorkerHostOptions {
  providerId?: string;
  sessionLifecycleService?: SessionLifecycleService;
  transport?: WorkerTransport;
  workerIdentity?: WorkerIdentity;
}

/**
 * Application service for one worker process.
 * It coordinates transport, leases, runtime instances and process lifecycle concerns.
 * This is not a domain service because it orchestrates infrastructure-heavy behavior.
 */
export class SessionWorkerHost {
  private readonly providerId: string;
  private readonly workerIdentity: WorkerIdentity;
  private readonly transport: WorkerTransport;
  private readonly sessionCoordinator: RedisSessionCoordinator;
  private readonly healthReporter: RedisWorkerHealthReporter;
  private readonly sessionLifecycleService: SessionLifecycleService;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly startingSessions = new Set<string>();
  private readonly stoppingSessions = new Set<string>();

  private started = false;
  private stopPromise?: Promise<void>;

  constructor(options: SessionWorkerHostOptions = {}) {
    this.providerId = options.providerId ?? env.CHANNEL_PROVIDER_ID;
    this.workerIdentity = options.workerIdentity ?? WorkerIdentity.current();
    this.transport = options.transport ?? new NatsChannelTransport(this.providerId);
    this.sessionLifecycleService = options.sessionLifecycleService
      ?? new SessionLifecycleService(new PgSessionRepository());
    this.sessionCoordinator = new RedisSessionCoordinator(this.workerIdentity);
    this.healthReporter = new RedisWorkerHealthReporter(
      this.providerId,
      this.workerIdentity,
      () => this.sessions.size,
    );
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await PgConnection.initializeSchema();
    await this.transport.connect();
    await this.transport.subscribeWorkerCommands(
      this.workerIdentity.id,
      this.handleWorkerCommand,
    );
    await this.healthReporter.start();

    this.started = true;
    console.log(`[HOST] Worker host online as ${this.workerIdentity.id} for ${this.providerId}`);
  }

  public isStarted(): boolean {
    return this.started;
  }

  public getProviderId(): string {
    return this.providerId;
  }

  public getWorkerId(): string {
    return this.workerIdentity.id;
  }

  public getHostedSessionCount(): number {
    return this.sessions.size;
  }

  public async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    this.stopPromise = this.stopInternal();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  public async startSession(session: SessionReference): Promise<void> {
    this.ensureStarted();

    const sessionKey = session.toKey();

    if (this.sessions.has(sessionKey) || this.startingSessions.has(sessionKey)) {
      console.log(`[HOST] ${session.toLogLabel()} is already hosted on this worker.`);
      return;
    }

    if (this.sessions.size + this.startingSessions.size >= env.MAX_CONCURRENT_SESSIONS) {
      throw new Error(
        `Worker capacity exceeded (${this.sessions.size + this.startingSessions.size}/${env.MAX_CONCURRENT_SESSIONS})`,
      );
    }

    console.log(`[HOST] Starting ${session.toLogLabel()}...`);
    this.startingSessions.add(sessionKey);

    try {
      const lease = await this.sessionCoordinator.acquireSessionLock(
        session,
        env.SESSION_LOCK_TTL_MS,
      );
      const callbacks: BaileysProviderCallbacks = {
        onActivationEvent: async event => {
          await this.handleActivationLifecycleUpdate(event);
          await this.publishNonCritical(
            `activation event ${event.eventType} for ${event.session.toLogLabel()}`,
            () => this.transport.publishActivation(event),
          );
        },
        onInboundEvent: async event => {
          await this.publishNonCritical(
            `inbound event ${event.eventType} for ${event.session.toLogLabel()}`,
            () => this.transport.publishInbound(event),
          );
        },
        onSessionStatus: async event => {
          this.updateHostedSessionStatus(
            event.session,
            event.status,
            event.timestamp,
            event.reason,
          );
          await this.handleSessionStatusLifecycleUpdate(event);
          await this.publishNonCritical(
            `session status ${event.status} for ${event.session.toLogLabel()}`,
            () => this.transport.publishSessionStatus(
              new SessionStatusEvent(
                event.session,
                event.status,
                event.timestamp,
                this.workerIdentity.id,
                event.reason,
              ),
            ),
          );

          if (event.status === SessionStatus.LoggedOut || event.status === SessionStatus.Failed) {
            await this.stopSession(event.session);
          }
        },
        onPersistedCredentialsChanged: async (hasPersistedCredentials, timestamp) => {
          await this.handlePersistedCredentialsChanged(
            session,
            hasPersistedCredentials,
            timestamp,
          );
        },
      };
      const provider = new BaileysProvider(session, callbacks);
      const hostedAt = new Date().toISOString();

      const hostedSession: HostedSession = {
        session,
        provider,
        lease,
        status: SessionStatus.Starting,
        hostedAt,
        updatedAt: hostedAt,
      };

      this.sessions.set(sessionKey, hostedSession);
      await this.sessionLifecycleService.markStarting(
        session,
        this.workerIdentity.id,
        hostedAt,
      );
      await this.publishSessionStatus(session, SessionStatus.Starting, undefined, hostedAt);

      await this.transport.subscribeOutgoing(session, async command => {
        const currentSession = this.sessions.get(sessionKey);
        if (!currentSession) {
          throw new Error(`Session ${session.toLogLabel()} is no longer hosted.`);
        }

        const result = await currentSession.provider.send(command);
        await this.publishNonCritical(
          `delivery result for command ${result.commandId}`,
          () => this.transport.publishDelivery(result),
        );
      });

      hostedSession.lockHeartbeat = this.startLockHeartbeat(hostedSession);
      await provider.start();
      console.log(`[HOST] ${session.toLogLabel()} is online.`);
    } catch (error) {
      const hostedSession = this.sessions.get(sessionKey);
      this.sessions.delete(sessionKey);

      if (hostedSession) {
        await this.cleanupSession(hostedSession);
      }

      await this.persistSessionMirrorNonCritical(
        `mark ${session.toLogLabel()} as failed during startup`,
        () => this.sessionLifecycleService.markFailed(
          session,
          new Date().toISOString(),
          error instanceof Error ? error.message : String(error),
        ),
      );
      await this.publishSessionStatus(
        session,
        SessionStatus.Failed,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      this.startingSessions.delete(sessionKey);
    }
  }

  public async ensureSessionStarted(session: SessionReference): Promise<BaileysProvider> {
    await this.startSession(session);

    const sessionKey = session.toKey();
    while (this.startingSessions.has(sessionKey) && !this.sessions.has(sessionKey)) {
      await this.delay(25);
    }

    const hostedSession = this.sessions.get(sessionKey);
    if (!hostedSession) {
      throw new Error(`Failed to host ${session.toLogLabel()} on this worker.`);
    }

    return hostedSession.provider;
  }

  public getHostedProvider(session: SessionReference): BaileysProvider {
    const hostedSession = this.sessions.get(session.toKey());
    if (!hostedSession) {
      throw new Error(`${session.toLogLabel()} is not hosted on this worker.`);
    }

    return hostedSession.provider;
  }

  public getHostedSessionSnapshot(
    session: SessionReference,
  ): HostedSessionSnapshot | undefined {
    const hostedSession = this.sessions.get(session.toKey());
    if (!hostedSession) {
      return undefined;
    }

    return this.createHostedSessionSnapshot(hostedSession);
  }

  public listHostedSessionSnapshots(): HostedSessionSnapshot[] {
    return Array.from(this.sessions.values())
      .map(hostedSession => this.createHostedSessionSnapshot(hostedSession));
  }

  public async stopSession(session: SessionReference): Promise<void> {
    const sessionKey = session.toKey();
    const hostedSession = this.sessions.get(sessionKey);
    if (!hostedSession || this.stoppingSessions.has(sessionKey)) {
      return;
    }

    this.stoppingSessions.add(sessionKey);

    try {
      const shouldPublishStopLifecycle = !this.isTerminalHostedStatus(hostedSession.status);

      if (shouldPublishStopLifecycle) {
        await this.persistSessionMirrorNonCritical(
          `mark ${session.toLogLabel()} as stopping`,
          () => this.sessionLifecycleService.markStopping(
            session,
            new Date().toISOString(),
          ),
        );
        await this.publishSessionStatus(session, SessionStatus.Stopping);
      }

      console.log(`[HOST] Stopping ${session.toLogLabel()}...`);
      await this.cleanupSession(hostedSession);
      this.sessions.delete(sessionKey);

      if (shouldPublishStopLifecycle) {
        await this.persistSessionMirrorNonCritical(
          `mark ${session.toLogLabel()} as stopped`,
          () => this.sessionLifecycleService.markStopped(
            session,
            new Date().toISOString(),
          ),
        );
        await this.publishSessionStatus(session, SessionStatus.Stopped);
      }
    } finally {
      this.sessions.delete(sessionKey);
      this.stoppingSessions.delete(sessionKey);
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.withShutdownTimeout('stop health reporter', () => this.healthReporter.stop());

    const activeSessions = Array.from(this.sessions.values());
    for (const hostedSession of activeSessions) {
      await this.withShutdownTimeout(
        `stop session ${hostedSession.session.toLogLabel()}`,
        () => this.stopSession(hostedSession.session),
      );
    }

    await Promise.allSettled([
      this.withShutdownTimeout('disconnect transport', () => this.transport.disconnect()),
      this.withShutdownTimeout('close redis', () => RedisConnection.close()),
      this.withShutdownTimeout('close postgres', () => PgConnection.close()),
    ]);

    this.started = false;
  }

  private startLockHeartbeat(hostedSession: HostedSession): NodeJS.Timeout {
    hostedSession.lockHeartbeatStopped = false;

    const scheduleNext = (): NodeJS.Timeout => {
      const timer = setTimeout(async () => {
        if (
          hostedSession.lockHeartbeatStopped
          || !this.sessions.has(hostedSession.session.toKey())
        ) {
          return;
        }

        try {
          await hostedSession.lease.extend(env.SESSION_LOCK_TTL_MS);
          if (!hostedSession.lockHeartbeatStopped) {
            hostedSession.lockHeartbeat = scheduleNext();
          }
        } catch (error) {
          console.error(
            `[HOST] Failed to extend lock for ${hostedSession.session.toLogLabel()}:`,
            error,
          );
          void this.stopSession(hostedSession.session);
        }
      }, env.SESSION_LOCK_HEARTBEAT_MS);

      timer.unref();
      return timer;
    };

    return scheduleNext();
  }

  private async cleanupSession(hostedSession: HostedSession): Promise<void> {
    hostedSession.lockHeartbeatStopped = true;
    if (hostedSession.lockHeartbeat) {
      clearTimeout(hostedSession.lockHeartbeat);
      hostedSession.lockHeartbeat = undefined;
    }

    const disconnectTransportPromise = this.withCleanupTimeout(
      `disconnect transport for ${hostedSession.session.toLogLabel()}`,
      () => this.transport.disconnectSession(hostedSession.session),
    ).catch(error => {
      console.warn(
        `[HOST] Non-critical error disconnecting transport for ${hostedSession.session.toLogLabel()}:`,
        error,
      );
    });

    const stopRuntimePromise = this.withCleanupTimeout(
      `stop provider for ${hostedSession.session.toLogLabel()}`,
      () => hostedSession.provider.stop(),
    ).catch(error => {
      console.warn(
        `[HOST] Non-critical error stopping provider for ${hostedSession.session.toLogLabel()}:`,
        error,
      );
    });

    await this.withCleanupTimeout(
      `release lock for ${hostedSession.session.toLogLabel()}`,
      () => hostedSession.lease.release(),
    ).catch(error => {
      console.warn(
        `[HOST] Non-critical error releasing lock for ${hostedSession.session.toLogLabel()}:`,
        error,
      );
    });

    await Promise.allSettled([disconnectTransportPromise, stopRuntimePromise]);
  }

  private async withShutdownTimeout<T>(
    label: string,
    task: () => Promise<T>,
    timeoutMs = 3000,
  ): Promise<T | undefined> {
    try {
      return await this.withTimeout(task(), timeoutMs, label);
    } catch (error) {
      console.warn(`[HOST] Shutdown step timed out or failed: ${label}`, error);
      return undefined;
    }
  }

  private async withCleanupTimeout<T>(
    label: string,
    task: () => Promise<T>,
    timeoutMs = 2000,
  ): Promise<T> {
    return this.withTimeout(task(), timeoutMs, label);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`timeout after ${timeoutMs}ms (${label})`));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private ensureStarted(): void {
    if (!this.started) {
      throw new Error('SessionWorkerHost must be started before hosting sessions.');
    }
  }

  private readonly handleWorkerCommand = async (command: WorkerCommand): Promise<void> => {
    if (command.session.provider !== this.providerId) {
      console.warn(
        `[HOST] Ignoring worker command ${command.commandId} for provider ${command.session.provider}.`,
      );
      return;
    }

    if (command.action === WorkerCommandAction.StartSession) {
      await this.startSession(command.session);
      return;
    }

    if (command.action === WorkerCommandAction.StopSession) {
      await this.stopSession(command.session);
      return;
    }

    console.warn(`[HOST] Unknown worker command action ${command.action}.`);
  };

  private async handleActivationLifecycleUpdate(event: ActivationEvent): Promise<void> {
    await this.persistSessionMirrorNonCritical(
      `mirror activation event ${event.eventType} for ${event.session.toLogLabel()}`,
      async () => {
        switch (event.eventType) {
          case ActivationEventType.Started:
            await this.sessionLifecycleService.ensureSession(event.session, event.timestamp);
            return;
          case ActivationEventType.QrCodeUpdated:
            await this.sessionLifecycleService.beginQrCodeActivation(
              event.session,
              event.timestamp,
            );
            return;
          case ActivationEventType.PairingCodeUpdated:
            if (event.phoneNumber?.trim()) {
              await this.sessionLifecycleService.beginPairingCodeActivation(
                event.session,
                event.phoneNumber,
                event.timestamp,
              );
              return;
            }

            await this.sessionLifecycleService.ensureSession(event.session, event.timestamp);
            return;
          case ActivationEventType.Completed:
            await this.sessionLifecycleService.completeActivation(
              event.session,
              event.timestamp,
            );
            return;
          case ActivationEventType.Failed:
            await this.sessionLifecycleService.failActivation(
              event.session,
              event.reason,
              event.timestamp,
            );
            return;
          case ActivationEventType.Expired:
            await this.sessionLifecycleService.expireActivation(
              event.session,
              event.timestamp,
              event.reason,
            );
            return;
          case ActivationEventType.Cancelled:
            await this.sessionLifecycleService.cancelActivation(
              event.session,
              event.timestamp,
              event.reason,
            );
            return;
        }
      },
    );
  }

  private async handleSessionStatusLifecycleUpdate(event: SessionStatusEvent): Promise<void> {
    await this.persistSessionMirrorNonCritical(
      `mirror session status ${event.status} for ${event.session.toLogLabel()}`,
      async () => {
        switch (event.status) {
          case SessionStatus.Connected:
            await this.sessionLifecycleService.markConnected(
              event.session,
              this.workerIdentity.id,
              event.timestamp,
            );
            return;
          case SessionStatus.Reconnecting:
            await this.sessionLifecycleService.markReconnecting(
              event.session,
              this.workerIdentity.id,
              event.timestamp,
              event.reason,
            );
            return;
          case SessionStatus.LoggedOut:
            await this.sessionLifecycleService.markLoggedOut(
              event.session,
              event.timestamp,
              event.reason,
            );
            return;
          case SessionStatus.Failed:
            await this.sessionLifecycleService.markFailed(
              event.session,
              event.timestamp,
              event.reason ?? 'session_failed',
            );
            return;
          default:
            return;
        }
      },
    );
  }

  private async handlePersistedCredentialsChanged(
    session: SessionReference,
    hasPersistedCredentials: boolean,
    timestamp: string,
  ): Promise<void> {
    await this.persistSessionMirrorNonCritical(
      `mirror persisted credentials=${hasPersistedCredentials} for ${session.toLogLabel()}`,
      () => hasPersistedCredentials
        ? this.sessionLifecycleService.markPersistedCredentials(session, timestamp)
        : this.sessionLifecycleService.clearPersistedCredentials(session, timestamp),
    );
  }

  private async publishSessionStatus(
    session: SessionReference,
    status:
      | SessionStatus.Starting
      | SessionStatus.Stopping
      | SessionStatus.Stopped
      | SessionStatus.Failed,
    reason?: string,
    timestamp = new Date().toISOString(),
  ): Promise<void> {
    this.updateHostedSessionStatus(session, status, timestamp, reason);
    await this.publishNonCritical(
      `session status ${status} for ${session.toLogLabel()}`,
      () => this.transport.publishSessionStatus(
        new SessionStatusEvent(
          session,
          status,
          timestamp,
          this.workerIdentity.id,
          reason,
        ),
      ),
    );
  }

  private updateHostedSessionStatus(
    session: SessionReference,
    status: SessionStatus,
    timestamp: string,
    reason?: string,
  ): void {
    const hostedSession = this.sessions.get(session.toKey());
    if (!hostedSession) {
      return;
    }

    hostedSession.status = status;
    hostedSession.updatedAt = timestamp;
    hostedSession.reason = reason;
  }

  private createHostedSessionSnapshot(hostedSession: HostedSession): HostedSessionSnapshot {
    return new HostedSessionSnapshot(
      hostedSession.session,
      hostedSession.status,
      this.workerIdentity.id,
      hostedSession.hostedAt,
      hostedSession.updatedAt,
      hostedSession.reason,
    );
  }

  private isTerminalHostedStatus(status: SessionStatus): boolean {
    return status === SessionStatus.Failed || status === SessionStatus.LoggedOut;
  }

  private async persistSessionMirrorNonCritical(
    label: string,
    task: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      console.error(`[HOST] Failed to persist durable session mirror for ${label}.`, error);
    }
  }

  private async publishNonCritical(
    label: string,
    publisher: () => Promise<void>,
    attempts = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await publisher();
        return;
      } catch (error) {
        if (attempt >= attempts) {
          console.error(
            `[HOST] Failed to publish ${label} after ${attempts} attempts. Keeping runtime flow alive.`,
            error,
          );
          return;
        }

        console.warn(
          `[HOST] Failed to publish ${label}. Retrying (${attempt}/${attempts})...`,
          error,
        );
        await this.delay(250 * attempt);
      }
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
    });
  }
}
