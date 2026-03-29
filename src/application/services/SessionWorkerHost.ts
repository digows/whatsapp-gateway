import {
  ChannelSessionAddress,
  ChannelSessionRuntimeCallbacks,
  ChannelWorkerCommand,
  IChannelSessionRuntime,
  IChannelWorkerHost,
  IChannelWorkerTransport,
} from '@jarvix/ts-channel-provider';
import { env } from '../config/env.js';
import { CHANNEL_PROVIDER_ID } from '../config/provider.js';
import { SessionDescriptor } from '../../domain/entities/SessionDescriptor.js';
import { WorkerIdentity } from '../../domain/entities/WorkerIdentity.js';
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
  descriptor: SessionDescriptor;
  runtime: IChannelSessionRuntime;
  lease: SessionLease;
  lockHeartbeat?: NodeJS.Timeout;
  lockHeartbeatStopped?: boolean;
}

type SessionRuntimeFactory = (
  session: SessionDescriptor,
  callbacks: ChannelSessionRuntimeCallbacks,
) => IChannelSessionRuntime;

interface SessionWorkerHostOptions {
  providerId?: string;
  transport?: IChannelWorkerTransport;
  runtimeFactory?: SessionRuntimeFactory;
  workerIdentity?: WorkerIdentity;
}

/**
 * Process-level runtime for the Node worker.
 * It owns NATS connectivity, worker heartbeat, capacity and hosted sessions.
 */
export class SessionWorkerHost implements IChannelWorkerHost {
  private readonly providerId: string;
  private readonly workerIdentity: WorkerIdentity;
  private readonly transport: IChannelWorkerTransport;
  private readonly runtimeFactory: SessionRuntimeFactory;
  private readonly sessionCoordinator: RedisSessionCoordinator;
  private readonly healthReporter: RedisWorkerHealthReporter;
  private readonly sessions = new Map<string, HostedSession>();
  private readonly startingSessions = new Set<string>();
  private readonly stoppingSessions = new Set<string>();

  private started = false;
  private stopPromise?: Promise<void>;

  constructor(options: SessionWorkerHostOptions = {}) {
    this.providerId = options.providerId ?? CHANNEL_PROVIDER_ID;
    this.workerIdentity = options.workerIdentity ?? WorkerIdentity.current();
    this.transport = options.transport ?? new NatsChannelTransport(this.providerId);
    this.runtimeFactory = options.runtimeFactory ?? ((session, callbacks) => new BaileysProvider(session, callbacks));
    this.sessionCoordinator = new RedisSessionCoordinator(this.workerIdentity);
    this.healthReporter = new RedisWorkerHealthReporter(
      this.providerId,
      this.workerIdentity,
      () => this.sessions.size,
    );
  }

  /**
   *
   */
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

  private async stopInternal(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.withShutdownTimeout('stop health reporter', () => this.healthReporter.stop());

    const activeSessions = Array.from(this.sessions.values());
    for (const session of activeSessions) {
      await this.withShutdownTimeout(
        `stop session ${session.descriptor.toLogLabel()}`,
        () => this.stopSession(session.descriptor),
      );
    }

    await Promise.allSettled([
      this.withShutdownTimeout('disconnect transport', () => this.transport.disconnect()),
      this.withShutdownTimeout('close redis', () => RedisConnection.close()),
      this.withShutdownTimeout('close postgres', () => PgConnection.close()),
    ]);

    this.started = false;
  }

  public async startSession(session: ChannelSessionAddress): Promise<void> {
    this.ensureStarted();

    const descriptor = this.toDescriptor(session);
    const sessionKey = descriptor.toKey();

    if (this.sessions.has(sessionKey) || this.startingSessions.has(sessionKey)) {
      console.log(`[HOST] ${descriptor.toLogLabel()} is already hosted on this worker.`);
      return;
    }

    if (this.sessions.size + this.startingSessions.size >= env.MAX_CONCURRENT_SESSIONS) {
      throw new Error(
        `Worker capacity exceeded (${this.sessions.size + this.startingSessions.size}/${env.MAX_CONCURRENT_SESSIONS})`,
      );
    }

    console.log(`[HOST] Starting ${descriptor.toLogLabel()}...`);
    this.startingSessions.add(sessionKey);

    try {
      const lease = await this.sessionCoordinator.acquireSessionLock(
        descriptor,
        env.SESSION_LOCK_TTL_MS,
      );
      const runtime = this.runtimeFactory(descriptor, {
        onIncomingMessage: async event => {
          await this.transport.publishIncoming(event);
        },
        onSessionStatus: async event => {
          await this.transport.publishSessionStatus({
            ...event,
            workerId: this.workerIdentity.id,
          });

          if (event.status === 'logged_out' || event.status === 'failed') {
            await this.stopSession(event.session);
          }
        },
      });

      const hostedSession: HostedSession = {
        descriptor,
        runtime,
        lease,
      };

      this.sessions.set(sessionKey, hostedSession);
      await this.publishSessionStatus(descriptor, 'starting');

      await this.transport.subscribeOutgoing(descriptor, async command => {
        const currentSession = this.sessions.get(sessionKey);
        if (!currentSession) {
          throw new Error(`Session ${descriptor.toLogLabel()} is no longer hosted.`);
        }

        const result = await currentSession.runtime.send(command);
        await this.transport.publishDelivery(result);
      });

      hostedSession.lockHeartbeat = this.startLockHeartbeat(hostedSession);
      await runtime.start();
      console.log(`[HOST] ${descriptor.toLogLabel()} is online.`);
    } catch (error) {
      const hostedSession = this.sessions.get(sessionKey);
      this.sessions.delete(sessionKey);

      if (hostedSession) {
        await this.cleanupSession(hostedSession);
      }

      await this.publishSessionStatus(
        descriptor,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      this.startingSessions.delete(sessionKey);
    }
  }

  /**
   *
   * @param session
   */
  public async stopSession(session: ChannelSessionAddress): Promise<void> {
    const descriptor = this.toDescriptor(session);
    const sessionKey = descriptor.toKey();
    const hostedSession = this.sessions.get(sessionKey);
    if (!hostedSession || this.stoppingSessions.has(sessionKey)) {
      return;
    }

    this.stoppingSessions.add(sessionKey);
    this.sessions.delete(sessionKey);

    try {
      await this.publishSessionStatus(descriptor, 'stopping');
      console.log(`[HOST] Stopping ${descriptor.toLogLabel()}...`);
      await this.cleanupSession(hostedSession);
      await this.publishSessionStatus(descriptor, 'stopped');
    } finally {
      this.stoppingSessions.delete(sessionKey);
    }
  }

  private startLockHeartbeat(session: HostedSession): NodeJS.Timeout {
    session.lockHeartbeatStopped = false;

    const scheduleNext = (): NodeJS.Timeout => {
      const timer = setTimeout(async () => {
        if (session.lockHeartbeatStopped || !this.sessions.has(session.descriptor.toKey())) {
          return;
        }

        try {
          await session.lease.extend(env.SESSION_LOCK_TTL_MS);
          if (!session.lockHeartbeatStopped) {
            session.lockHeartbeat = scheduleNext();
          }
        } catch (error) {
          console.error(
            `[HOST] Failed to extend lock for ${session.descriptor.toLogLabel()}:`,
            error,
          );
          void this.stopSession(session.descriptor);
        }
      }, env.SESSION_LOCK_HEARTBEAT_MS);

      timer.unref();
      return timer;
    };

    return scheduleNext();
  }

  private async cleanupSession(session: HostedSession): Promise<void> {
    session.lockHeartbeatStopped = true;
    if (session.lockHeartbeat) {
      clearTimeout(session.lockHeartbeat);
      session.lockHeartbeat = undefined;
    }

    const disconnectTransportPromise = this.withCleanupTimeout(
      `disconnect transport for ${session.descriptor.toLogLabel()}`,
      () => this.transport.disconnectSession(session.descriptor),
    ).catch(error => {
      console.warn(
        `[HOST] Non-critical error disconnecting transport for ${session.descriptor.toLogLabel()}:`,
        error,
      );
    });

    const stopRuntimePromise = this.withCleanupTimeout(
      `stop runtime for ${session.descriptor.toLogLabel()}`,
      () => session.runtime.stop(),
    ).catch(error => {
      console.warn(
        `[HOST] Non-critical error stopping runtime for ${session.descriptor.toLogLabel()}:`,
        error,
      );
    });

    await this.withCleanupTimeout(
      `release lock for ${session.descriptor.toLogLabel()}`,
      () => session.lease.release(),
    ).catch(error => {
      console.warn(
        `[HOST] Non-critical error releasing lock for ${session.descriptor.toLogLabel()}:`,
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

  private readonly handleWorkerCommand = async (command: ChannelWorkerCommand): Promise<void> => {
    if (command.session.provider !== this.providerId) {
      console.warn(
        `[HOST] Ignoring worker command ${command.commandId} for provider ${command.session.provider}.`,
      );
      return;
    }

    if (command.action === 'start_session') {
      await this.startSession(command.session);
      return;
    }

    if (command.action === 'stop_session') {
      await this.stopSession(command.session);
      return;
    }

    console.warn(`[HOST] Unknown worker command action ${(command as any).action}.`);
  };

  private toDescriptor(session: ChannelSessionAddress): SessionDescriptor {
    return new SessionDescriptor(
      session.provider,
      session.workspaceId,
      session.sessionId,
    );
  }

  private async publishSessionStatus(
    session: SessionDescriptor,
    status: 'starting' | 'stopping' | 'stopped' | 'failed',
    reason?: string,
  ): Promise<void> {
    await this.transport.publishSessionStatus({
      session,
      workerId: this.workerIdentity.id,
      status,
      reason,
      timestamp: new Date().toISOString(),
    });
  }
}
