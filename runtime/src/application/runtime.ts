import { type AccountScope } from "@digows/whatsapp-gateway-contracts";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import { GatewayPrincipal } from "../domain/authorization.ts";
import { describeWhatsAppError } from "../domain/error-details.ts";
import { BaileysConnection } from "../infrastructure/baileys/baileys-connection.ts";
import { GatewayHttpTransport, type GatewayHttpWorkspace } from "../infrastructure/http/transport.ts";
import { GatewayRedisTransport } from "../infrastructure/redis/transport.ts";
import { createMediaStorage, type MediaStorageResources } from "../infrastructure/s3/configuration.ts";
import { SqlCommandInbox } from "../infrastructure/sql/command-inbox.ts";
import { SqlFleetStore } from "../infrastructure/sql/fleet-store.ts";
import { type SqlGatewayStore } from "../infrastructure/sql/gateway-store.ts";
import { SqlGatewayHistory } from "../infrastructure/sql/history.ts";
import { SqlRedisStreamStore } from "../infrastructure/sql/redis-stream-store.ts";
import { type GatewayStorage, openGatewayStorage } from "../infrastructure/sql/storage.ts";
import { SqlWebhookOutbox } from "../infrastructure/sql/webhook-outbox.ts";
import { GatewayWebhookDispatcher } from "../infrastructure/webhook/dispatcher.ts";
import { GatewayCommandIngress } from "./command-ingress.ts";
import { componentLogger, createRuntimeLogger } from "./configuration/logging.ts";
import {
  type GatewayRuntimeConfiguration,
  GatewayRuntimeConfigurationSchema,
} from "./configuration/runtime-configuration.ts";
import { gatewayWorkspaceStorageConfiguration } from "./configuration/storage-configuration.ts";
import { GatewayFleetParticipant } from "./fleet-participant.ts";
import { Gateway, type GatewayConnectionFactory } from "./gateway.ts";
import { GatewayQueryService } from "./query-service.ts";
interface RuntimeWorkspace extends GatewayHttpWorkspace
{
  readonly store: SqlGatewayStore;
  readonly participant: GatewayFleetParticipant;
  readonly redis: GatewayRedisTransport;
  readonly outbox: SqlWebhookOutbox;
  readonly dispatcher: GatewayWebhookDispatcher;
  sqlHealthy: boolean;
  redisHealthy: boolean;
}
export class GatewayRuntime
{
  readonly configuration: GatewayRuntimeConfiguration;
  readonly logger: Logger;
  private readonly workspaces: RuntimeWorkspace[] = [];
  private readonly loops: Promise<void>[] = [];
  private readonly controller = new AbortController();
  private readonly storageResources: GatewayStorage[] = [];
  private media: MediaStorageResources | null = null;
  private http: GatewayHttpTransport | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private running = false;
  constructor(input: unknown, private readonly connectionFactory?: GatewayConnectionFactory)
  {
    this.configuration = GatewayRuntimeConfigurationSchema.parse(input);
    this.logger = createRuntimeLogger(this.configuration.logging);
  }
  get origin(): string | null
  {
    return this.http?.origin ?? null;
  }
  get ready(): boolean
  {
    return this.running && !this.controller.signal.aborted
      && this.workspaces.every(workspace => workspace.sqlHealthy && workspace.redisHealthy);
  }
  private scopeLogger(component: Parameters<typeof componentLogger>[2], scope?: AccountScope): Logger
  {
    const logger = componentLogger(this.logger, this.configuration.logging, component);
    return scope ? logger.child({ workspaceId: scope.workspaceId, accountId: scope.accountId }) : logger;
  }
  async start(): Promise<void>
  {
    if (this.closing) throw new Error("Runtime is closed");
    this.starting ??= this.initialize();
    try
    {
      await this.starting;
    }
    catch (error)
    {
      await this.close();
      throw error;
    }
  }
  private assertStarting(): void
  {
    if (this.controller.signal.aborted) throw new Error("Runtime startup was cancelled");
  }
  private async initialize(): Promise<void>
  {
    const configuration = this.configuration;
    this.scopeLogger("runtime").info({
      event: "runtime_starting",
      storageEngine: configuration.storage.engine,
      storageMode: configuration.storage.mode,
      httpEnabled: configuration.http.enabled,
      redisEnabled: configuration.redis.transport.enabled,
      webhooksEnabled: configuration.webhooks.enabled,
    });
    const sharedStorage = configuration.storage.engine === "postgresql"
      ? await openGatewayStorage(configuration.storage, this.scopeLogger("runtime"))
      : undefined;
    if (sharedStorage) this.storageResources.push(sharedStorage);
    this.assertStarting();
    this.media = createMediaStorage(configuration.media, {
      maximumBytes: configuration.gateway.maximumMediaBytes,
      timeoutMs: configuration.gateway.mediaTimeoutMs,
    });
    const principals = new Map(
      configuration.principals.map(value => [value.id, new GatewayPrincipal(value.id, value.grants)]),
    );
    for (const entry of configuration.workspaces)
    {
      this.assertStarting();
      const storage = sharedStorage ?? await openGatewayStorage(
        gatewayWorkspaceStorageConfiguration(configuration.storage, entry.workspaceId),
        this.scopeLogger("runtime").child({ workspaceId: entry.workspaceId }),
      );
      if (!sharedStorage) this.storageResources.push(storage);
      this.assertStarting();
      const store = storage.workspace(entry.workspaceId);
      const gateway = new Gateway(
        store,
        (account, lease) =>
          this.connectionFactory
            ? this.connectionFactory(account, lease)
            : new BaileysConnection(
              store,
              lease,
              this.media?.repository ?? null,
              undefined,
              30000,
              10000,
              this.scopeLogger("baileys", account).child({ generation: lease.generation }),
            ),
        configuration.gateway,
        this.media?.repository,
        this.scopeLogger("sessions").child({ workspaceId: entry.workspaceId }),
      );
      const fleet = new SqlFleetStore(store);
      const queries = new GatewayQueryService(store, gateway, new SqlGatewayHistory(store), gateway);
      const redis = new GatewayRedisTransport(
        new SqlRedisStreamStore(store),
        configuration.redis.transport,
        configuration.redis.bindings.filter(binding => binding.workspaceId === entry.workspaceId).map(
          binding =>
          {
            const principal = principals.get(binding.principalId);
            if (!principal) throw new Error("Redis principal is unavailable");
            return { accountId: binding.accountId, principal };
          },
        ),
        this.scopeLogger("redis").child({ workspaceId: entry.workspaceId }),
        queries,
      );
      const outbox = new SqlWebhookOutbox(store, configuration.webhooks.policy);
      const workspace: RuntimeWorkspace = {
        store,
        gateway,
        queries,
        fleet,
        commands: new GatewayCommandIngress(new SqlCommandInbox(store)),
        participant: new GatewayFleetParticipant(
          fleet,
          gateway,
          entry.fleet,
          this.scopeLogger("fleet").child({ workspaceId: entry.workspaceId }),
        ),
        redis,
        outbox,
        dispatcher: new GatewayWebhookDispatcher(
          outbox,
          { enabled: configuration.webhooks.enabled },
          this.scopeLogger("webhooks").child({ workspaceId: entry.workspaceId }),
        ),
        sqlHealthy: true,
        redisHealthy: true,
      };
      this.workspaces.push(workspace);
      for (const account of entry.accounts)
      {
        this.assertStarting();
        await store.createAccount(account.accountId);
        if (account.enabled !== undefined)
        {
          const desired = await fleet.desired(account.accountId);
          if (desired.enabled !== account.enabled)
          {
            await fleet.setDesired({
              apiVersion: "1",
              workspaceId: entry.workspaceId,
              accountId: account.accountId,
              expectedRevision: desired.revision,
              enabled: account.enabled,
            });
          }
        }
      }
      const configuredDestinations = configuration.webhooks.destinations.filter(destination =>
        destination.workspaceId === entry.workspaceId
      );
      for (const destination of await outbox.destinations())
      {
        if (
          !configuredDestinations.some(configured =>
            configured.accountId === destination.accountId && configured.id === destination.id
          )
        ) await outbox.configure({ ...destination, enabled: false });
      }
      for (const destination of configuredDestinations) await outbox.configure(destination);
      await redis.start();
    }
    this.assertStarting();
    this.http = new GatewayHttpTransport(
      configuration.http,
      this.workspaces,
      configuration.principals.flatMap(value =>
      {
        const principal = principals.get(value.id);
        return value.httpToken && principal ? [{ token: value.httpToken, principal }] : [];
      }),
      this.scopeLogger("http"),
      configuration.redis.transport.enabled ? configuration.redis.transport.prefix : "gateway:v1",
      { isReady: () => this.ready, isAccepting: () => this.running && !this.controller.signal.aborted },
    );
    await this.http.start();
    this.assertStarting();
    for (const workspace of this.workspaces)
    {
      this.assertStarting();
      await workspace.participant.start();
    }
    this.assertStarting();
    this.running = true;
    for (const workspace of this.workspaces)
    {
      if (configuration.redis.transport.enabled)
      {
        let lastTrim = Date.now();
        this.loops.push(this.loop("redis", 100, async () =>
        {
          try
          {
            await workspace.redis.consumeOnce();
            await workspace.redis.publishOnce();
            if (Date.now() - lastTrim >= 30000)
            {
              await workspace.redis.trimOnce(configuration.redis.retentionMs);
              lastTrim = Date.now();
            }
            workspace.redisHealthy = true;
          }
          catch (error)
          {
            workspace.redisHealthy = false;
            throw error;
          }
        }));
      }
      if (configuration.webhooks.enabled)
      {
        this.loops.push(this.loop("webhooks", 100, async () =>
        {
          await workspace.dispatcher.runOnce();
        }));
      }
      this.loops.push(this.loop("runtime", 5000, async () =>
      {
        try
        {
          await workspace.store.transaction(transaction => workspace.store.databaseTime(transaction));
          workspace.sqlHealthy = true;
        }
        catch (error)
        {
          workspace.sqlHealthy = false;
          throw error;
        }
      }));
    }
    this.scopeLogger("runtime").info({
      event: "runtime_ready",
      workspaceCount: this.workspaces.length,
      httpOrigin: this.origin,
      storageEngine: configuration.storage.engine,
    });
  }
  private async loop(
    component: Parameters<typeof componentLogger>[2],
    intervalMs: number,
    action: () => Promise<void>,
  ): Promise<void>
  {
    while (!this.controller.signal.aborted)
    {
      try
      {
        await action();
      }
      catch (error)
      {
        if (!this.controller.signal.aborted)
        {
          this.scopeLogger(component).error({
            event: "runtime_background_operation_failed",
            failure: describeWhatsAppError(error),
          });
        }
      }
      try
      {
        await delay(intervalMs, undefined, { signal: this.controller.signal });
      }
      catch
      {
        return;
      }
    }
  }
  async close(): Promise<void>
  {
    this.closing ??= (async () =>
    {
      this.controller.abort();
      this.running = false;
      await this.starting?.catch(() => undefined);
      this.scopeLogger("runtime").info({ event: "runtime_stopping" });
      const failures: unknown[] = [];
      const settle = async (action: () => Promise<void>): Promise<void> =>
      {
        try
        {
          await action();
        }
        catch (error)
        {
          failures.push(error);
        }
      };
      const participants = this.workspaces.map(workspace => settle(() => workspace.participant.close()));
      await settle(async () =>
      {
        await this.http?.close();
      });
      for (const workspace of this.workspaces) await settle(() => workspace.dispatcher.close());
      for (const workspace of this.workspaces) await settle(() => workspace.redis.close());
      await Promise.allSettled(this.loops);
      await Promise.all(participants);
      for (const storage of this.storageResources) await settle(() => storage.close());
      this.media?.client.destroy();
      this.scopeLogger("runtime").info({ event: "runtime_stopped", cleanupFailures: failures.length });
      if (failures.length) throw new AggregateError(failures, "Runtime cleanup failed");
    })();
    await this.closing;
  }
}
