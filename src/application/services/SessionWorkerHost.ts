import { env } from '../config/env.js';
import { SessionRuntime, SessionRuntimeCallbacks } from '../contracts/SessionRuntime.js';
import { WorkerTransport } from '../contracts/WorkerTransport.js';
import { ActivationMessaging } from './ActivationMessaging.js';
import { SessionReference } from '../../domain/entities/operational/SessionReference.js';
import {
  SessionStatus,
  SessionStatusEvent,
} from '../../domain/entities/operational/SessionStatus.js';
import {
  WorkerCommand,
  WorkerCommandAction,
} from '../../domain/entities/operational/WorkerCommand.js';
import { WorkerIdentity } from '../../domain/entities/operational/WorkerIdentity.js';
import { BaileysProvider } from '../../infrastructure/baileys/BaileysProvider.js';
import { NatsChannelTransport } from '../../infrastructure/nats/NatsChannelTransport.js';
import { PgConnection } from '../../infrastructure/pg/PgConnection.js';
import { RedisConnection } from '../../infrastructure/redis/RedisConnection.js';
import {
  RedisSessionCoordinator,
  SessionLease,
} from '../../infrastructure/redis/RedisSessionCoordinator.js';
import { RedisWorkerHealthReporter } from '../../infrastructure/redis/RedisWorkerHealthReporter.js';

interface HostedSession {
  session: SessionReference;
  runtime: SessionRuntime;
  lease: SessionLease;
  lockHeartbeat?: NodeJS.Timeout;
  lockHeartbeatStopped?: boolean;
}

type SessionRuntimeFactory = (
  session: SessionReference,
  callbacks: SessionRuntimeCallbacks,
) => SessionRuntime;

interface SessionWorkerHostOptions {
  providerId?: string;
  transport?: WorkerTransport;
  runtimeFactory?: SessionRuntimeFactory;
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
  private readonly activationMessaging: ActivationMessaging;
  private readonly runtimeFactory: SessionRuntimeFactory;
  private readonly sessionCoordinator: RedisSessionCoordinator;
  private readonly healthReporter: RedisWorkerHealthReporter;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly startingSessions = new Set<string>();
  private readonly stoppingSessions = new Set<string>();

  private started = false;
  private stopPromise?: Promise<void>;

  constructor(options: SessionWorkerHostOptions = {}) {
    this.providerId = options.providerId ?? env.CHANNEL_PROVIDER_ID;
    this.workerIdentity = options.workerIdentity ?? WorkerIdentity.current();
    this.transport = options.transport ?? new NatsChannelTransport(this.providerId);
    this.activationMessaging = new ActivationMessaging(this.transport);
    this.runtimeFactory = options.runtimeFactory
      ?? ((session, callbacks) => new BaileysProvider(session, callbacks));
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
      const runtime = this.runtimeFactory(session, {
        onActivationEvent: async event => {
          await this.activationMessaging.publish(event);
        },
        onInboundEvent: async event => {
          await this.transport.publishInbound(event);
        },
        onSessionStatus: async event => {
          await this.transport.publishSessionStatus(
            new SessionStatusEvent(
              event.session,
              event.status,
              event.timestamp,
              this.workerIdentity.id,
              event.reason,
            ),
          );

          if (event.status === SessionStatus.LoggedOut || event.status === SessionStatus.Failed) {
            await this.stopSession(event.session);
          }
        },
      });

      const hostedSession: HostedSession = {
        session,
        runtime,
        lease,
      };

      this.sessions.set(sessionKey, hostedSession);
      await this.publishSessionStatus(session, SessionStatus.Starting);

      await this.transport.subscribeOutgoing(session, async command => {
        const currentSession = this.sessions.get(sessionKey);
        if (!currentSession) {
          throw new Error(`Session ${session.toLogLabel()} is no longer hosted.`);
        }

        const result = await currentSession.runtime.send(command);
        await this.transport.publishDelivery(result);
      });

      await this.activationMessaging.subscribe(session, async command => {
        const currentSession = this.sessions.get(sessionKey);
        if (!currentSession) {
          throw new Error(`Session ${session.toLogLabel()} is no longer hosted.`);
        }

        await currentSession.runtime.handleActivationCommand(command);
      });

      hostedSession.lockHeartbeat = this.startLockHeartbeat(hostedSession);
      await runtime.start();
      console.log(`[HOST] ${session.toLogLabel()} is online.`);
    } catch (error) {
      const hostedSession = this.sessions.get(sessionKey);
      this.sessions.delete(sessionKey);

      if (hostedSession) {
        await this.cleanupSession(hostedSession);
      }

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

  public async stopSession(session: SessionReference): Promise<void> {
    const sessionKey = session.toKey();
    const hostedSession = this.sessions.get(sessionKey);
    if (!hostedSession || this.stoppingSessions.has(sessionKey)) {
      return;
    }

    this.stoppingSessions.add(sessionKey);
    this.sessions.delete(sessionKey);

    try {
      await this.publishSessionStatus(session, SessionStatus.Stopping);
      console.log(`[HOST] Stopping ${session.toLogLabel()}...`);
      await this.cleanupSession(hostedSession);
      await this.publishSessionStatus(session, SessionStatus.Stopped);
    } finally {
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
      `stop runtime for ${hostedSession.session.toLogLabel()}`,
      () => hostedSession.runtime.stop(),
    ).catch(error => {
      console.warn(
        `[HOST] Non-critical error stopping runtime for ${hostedSession.session.toLogLabel()}:`,
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

  private async publishSessionStatus(
    session: SessionReference,
    status:
      | SessionStatus.Starting
      | SessionStatus.Stopping
      | SessionStatus.Stopped
      | SessionStatus.Failed,
    reason?: string,
  ): Promise<void> {
    await this.transport.publishSessionStatus(
      new SessionStatusEvent(
        session,
        status,
        new Date().toISOString(),
        this.workerIdentity.id,
        reason,
      ),
    );
  }
}
