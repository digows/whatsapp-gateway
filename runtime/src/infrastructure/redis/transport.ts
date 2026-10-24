import {
  GatewayIdentifierSchema,
  GatewayMediaUploadSchema,
  GatewayQueryCloudEventSchema,
  GatewayQuerySchema,
  gatewayStreamNames,
} from "@digows/whatsapp-gateway-contracts";
import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";
import { createClient } from "redis";
import { z } from "zod";
import type { GatewayQueryService } from "../../application/query-service.ts";
import { GatewayAuthorizationError, type GatewayPrincipal } from "../../domain/authorization.ts";
import type { GatewayStreamKind } from "../../domain/redis-stream-store.ts";
import type { RedisStreamStore } from "../../domain/redis-stream-store.ts";
const EnabledRedisSchema = z.strictObject({
  enabled: z.literal(true),
  url: z.url().refine(value => ["redis:", "rediss:"].includes(new URL(value).protocol), "Expected Redis URL"),
  prefix: z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).default("gateway:v1"),
  group: z.string().min(1).max(128).default("gateway"),
  reclaimIdleMs: z.number().int().positive().max(300000).default(30000),
  commandTimeoutMs: z.number().int().min(100).max(60000).default(10000),
});
export const GatewayRedisConfigurationSchema = z.discriminatedUnion("enabled", [
  EnabledRedisSchema,
  z.strictObject({ enabled: z.literal(false) }),
]);
export type GatewayRedisConfiguration = z.infer<typeof GatewayRedisConfigurationSchema>;
export type GatewayRedisConfigurationInput = z.input<typeof GatewayRedisConfigurationSchema>;
export interface GatewayRedisAccountBinding
{
  readonly accountId: string;
  readonly principal: GatewayPrincipal;
}
interface StreamPublisherTarget
{
  readonly accountId: string;
  readonly stream: string;
  readonly kind: GatewayStreamKind;
}
type NativeRedisClient = ReturnType<typeof createClient>;
const RedisMessageSchema = z.object({
  id: z.string().regex(/^[0-9]+-[0-9]+$/),
  message: z.record(z.string(), z.string()),
});
export class GatewayRedisTransport
{
  private readonly configuration: GatewayRedisConfiguration;
  private readonly client: NativeRedisClient | null;
  private readonly bindings: readonly GatewayRedisAccountBinding[];
  private readonly consumerId = randomUUID();
  private readonly controller = new AbortController();
  private readonly reclaimCursors = new Map<string, string>();
  private verified = false;
  private publishIndex = 0;
  private connecting: Promise<void> | undefined;
  private consuming: Promise<number> | undefined;
  private publishing: Promise<boolean> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly store: RedisStreamStore,
    configuration: GatewayRedisConfigurationInput,
    bindings: readonly GatewayRedisAccountBinding[],
    private readonly logger: Logger = pino(),
    private readonly queries?: GatewayQueryService,
  )
  {
    this.configuration = GatewayRedisConfigurationSchema.parse(configuration);
    this.bindings = bindings.map(binding =>
    {
      const accountId = GatewayIdentifierSchema.parse(binding.accountId);
      binding.principal.authorize({ workspaceId: store.workspaceId, accountId });
      return { accountId, principal: binding.principal };
    });
    if (new Set(this.bindings.map(binding => binding.accountId)).size !== this.bindings.length)
    {
      throw new Error("Duplicate Redis account binding");
    }
    this.client = this.configuration.enabled
      ? createClient({
        url: this.configuration.url,
        disableOfflineQueue: true,
        socket: { reconnectStrategy: false, connectTimeout: 5000 },
      })
      : null;
    this.client?.on("error", () =>
    {
      this.verified = false;
      this.logger.warn({ event: "gateway_redis_connection_failed", workspaceId: this.store.workspaceId });
    });
    this.client?.on("end", () =>
    {
      this.verified = false;
    });
  }
  private commands()
  {
    if (!this.client || !this.configuration.enabled) throw new Error("Redis transport is disabled");
    return this.client.withAbortSignal(
      AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.configuration.commandTimeoutMs)]),
    );
  }
  async start(): Promise<void>
  {
    if (this.controller.signal.aborted) throw new Error("Redis transport is closed");
    if (!this.configuration.enabled) return;
    await this.ensureConnected();
  }
  private async ensureConnected(): Promise<void>
  {
    if (this.client?.isReady && this.verified) return;
    this.connecting ??= this.connectAndVerify();
    const pending = this.connecting;
    try
    {
      await pending;
    }
    finally
    {
      if (this.connecting === pending) this.connecting = undefined;
    }
  }
  private async connectAndVerify(): Promise<void>
  {
    const client = this.client;
    const configuration = this.configuration;
    if (!client || !configuration.enabled) return;
    if (this.controller.signal.aborted) throw new Error("Redis transport is closed");
    if (!client.isOpen)
    {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try
      {
        await Promise.race([
          client.connect(),
          new Promise<never>((_resolve, reject) =>
          {
            timer = setTimeout(() =>
            {
              if (client.isOpen) client.destroy();
              reject(new Error("Redis startup timed out"));
            }, configuration.commandTimeoutMs);
          }),
        ]);
      }
      finally
      {
        clearTimeout(timer);
      }
    }
    const server = await this.commands().info("server");
    if (!/(?:^|\r?\n)redis_version:8\.2\.[0-9]+(?:\r?\n|$)/.test(server))
    {
      throw new Error("Qualified Redis Streams requires Redis 8.2");
    }
    const persistence = await this.commands().info("persistence");
    if (!/(?:^|\r?\n)aof_enabled:1(?:\r?\n|$)/.test(persistence))
    {
      throw new Error("Redis Streams requires AOF persistence");
    }
    const memory = await this.commands().info("memory");
    if (!/(?:^|\r?\n)maxmemory_policy:noeviction(?:\r?\n|$)/.test(memory))
    {
      throw new Error("Redis Streams requires noeviction");
    }
    for (const binding of this.bindings)
    {
      const streams = gatewayStreamNames(configuration.prefix, {
        workspaceId: this.store.workspaceId,
        accountId: binding.accountId,
      });
      await this.store.register(binding.accountId, streams);
      try
      {
        await this.commands().xGroupCreate(streams.commands, configuration.group, "0-0", { MKSTREAM: true });
      }
      catch (error)
      {
        if (!(error instanceof Error) || !error.message.startsWith("BUSYGROUP ")) throw error;
      }
    }
    this.verified = true;
  }
  async consumeOnce(): Promise<number>
  {
    if (!this.configuration.enabled || this.controller.signal.aborted) return 0;
    this.consuming ??= this.consume();
    const pending = this.consuming;
    try
    {
      return await pending;
    }
    finally
    {
      if (this.consuming === pending) this.consuming = undefined;
    }
  }
  private async consume(): Promise<number>
  {
    const configuration = this.configuration;
    if (!configuration.enabled) return 0;
    await this.ensureConnected();
    let consumed = 0;
    for (const binding of this.bindings)
    {
      const streams = gatewayStreamNames(configuration.prefix, {
        workspaceId: this.store.workspaceId,
        accountId: binding.accountId,
      });
      const reclaimed = await this.commands().xAutoClaim(
        streams.commands,
        configuration.group,
        this.consumerId,
        configuration.reclaimIdleMs,
        this.reclaimCursors.get(binding.accountId) ?? "0-0",
        { COUNT: 1 },
      );
      this.reclaimCursors.set(binding.accountId, reclaimed.nextId);
      if (reclaimed.deletedMessages.length)
      {
        throw new Error("Redis removed pending command payloads; inspect stream retention");
      }
      const fresh = reclaimed.messages.length
        ? null
        : await this.commands().xReadGroup(configuration.group, this.consumerId, [{
          key: streams.commands,
          id: ">",
        }], { COUNT: 1 });
      const records = reclaimed.messages.length
        ? reclaimed.messages
        : fresh?.flatMap(stream => stream.messages) ?? [];
      for (const record of records)
      {
        const message = RedisMessageSchema.parse(record);
        let payload: unknown;
        try
        {
          payload = JSON.parse(message.message["payload"] ?? "");
        }
        catch
        {
          payload = null;
        }
        const query = z.union([GatewayQuerySchema, GatewayMediaUploadSchema]).safeParse(payload);
        if (
          query.success && query.data.workspaceId === this.store.workspaceId
          && query.data.accountId === binding.accountId
        )
        {
          const request = query.data;
          let response = null;
          let failure: "UNAVAILABLE" | "UNAUTHORIZED_SCOPE" | null = null;
          try
          {
            if (!this.queries) throw new Error("Redis queries are not configured");
            response = request.type === "media.upload"
              ? await this.queries.upload(binding.principal, request)
              : await this.queries.execute(binding.principal, request);
          }
          catch (error)
          {
            failure = error instanceof GatewayAuthorizationError ? "UNAUTHORIZED_SCOPE" : "UNAVAILABLE";
          }
          const event = GatewayQueryCloudEventSchema.parse({
            specversion: "1.0",
            id: randomUUID(),
            source: "urn:digows:whatsapp-gateway",
            type: "com.digows.whatsapp.query.result.v1",
            subject: `accounts/${binding.accountId}`,
            time: new Date().toISOString(),
            datacontenttype: "application/json",
            workspaceid: request.workspaceId,
            accountid: request.accountId,
            data: {
              apiVersion: "1",
              workspaceId: request.workspaceId,
              accountId: request.accountId,
              requestId: request.requestId,
              response,
              failure,
            },
          });
          await this.publishDurably(streams.results, event);
          await this.commands().xAck(streams.commands, configuration.group, message.id);
          consumed++;
          continue;
        }
        const receipt = await this.store.intake(
          binding.principal,
          binding.accountId,
          streams.commands,
          message.id,
          message.message["payload"] ?? "",
        );
        // Intake/receipt publication must be durable before removing the source PEL entry.
        await this.commands().xAck(streams.commands, configuration.group, message.id);
        consumed++;
        this.logger.info({
          event: "gateway_redis_command_acknowledged",
          workspaceId: this.store.workspaceId,
          accountId: binding.accountId,
          sourceMessageId: message.id,
          status: receipt.status,
        });
      }
    }
    return consumed;
  }
  async publishOnce(): Promise<boolean>
  {
    if (!this.configuration.enabled || this.controller.signal.aborted) return false;
    this.publishing ??= this.publish();
    const pending = this.publishing;
    try
    {
      return await pending;
    }
    finally
    {
      if (this.publishing === pending) this.publishing = undefined;
    }
  }
  private async publish(): Promise<boolean>
  {
    const configuration = this.configuration;
    if (!configuration.enabled) return false;
    await this.ensureConnected();
    const targets: StreamPublisherTarget[] = this.bindings.flatMap(binding =>
    {
      const streams = gatewayStreamNames(configuration.prefix, {
        workspaceId: this.store.workspaceId,
        accountId: binding.accountId,
      });
      return (["results", "events"] as const).map(kind => ({
        accountId: binding.accountId,
        stream: streams[kind],
        kind,
      }));
    });
    for (let offset = 0; offset < targets.length; offset++)
    {
      const index = (this.publishIndex + offset) % targets.length;
      const target = targets[index];
      if (!target) throw new Error("Redis publication target unavailable");
      const work = await this.store.publication(
        target.accountId,
        target.stream,
        target.kind,
        configuration.commandTimeoutMs + 1000,
      );
      if (work.advanced)
      {
        this.publishIndex = (index + 1) % targets.length;
        return true;
      }
      const claim = work.claim;
      if (!claim) continue;
      try
      {
        await this.publishDurably(claim.stream, claim.event);
        await this.store.published(claim);
        this.publishIndex = (index + 1) % targets.length;
        return true;
      }
      catch (error)
      {
        await this.store.releasePublication(claim);
        throw error;
      }
    }
    return false;
  }
  private async publishDurably(stream: string, event: unknown): Promise<void>
  {
    if (!this.configuration.enabled) throw new Error("Redis transport is disabled");
    await this.commands().xAdd(stream, "*", { payload: JSON.stringify(event) });
    const persisted = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).parse(
      await this.commands().sendCommand(["WAITAOF", "1", "0", String(this.configuration.commandTimeoutMs)]),
    );
    if (persisted[0] !== 1) throw new Error("Redis publication was not confirmed in local AOF");
  }
  async trimOnce(retentionMs: number): Promise<void>
  {
    if (!this.configuration.enabled || this.controller.signal.aborted || retentionMs === 0) return;
    z.number().int().positive().max(365 * 86400000).parse(retentionMs);
    await this.ensureConnected();
    const time = z.tuple([z.string().regex(/^[0-9]+$/), z.string().regex(/^[0-9]+$/)]).parse(
      await this.commands().sendCommand(["TIME"]),
    );
    const milliseconds = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
    const threshold = `${Math.max(0, milliseconds - retentionMs)}-0`;
    for (const binding of this.bindings)
    {
      const streams = gatewayStreamNames(this.configuration.prefix, {
        workspaceId: this.store.workspaceId,
        accountId: binding.accountId,
      });
      for (const stream of Object.values(streams))
      {
        await this.commands().xTrim(stream, "MINID", threshold, { strategyModifier: "=", policy: "ACKED" });
      }
    }
  }
  async close(): Promise<void>
  {
    this.closing ??= (async () =>
    {
      this.controller.abort();
      await Promise.allSettled([this.connecting, this.consuming, this.publishing]);
      if (this.client?.isOpen) await this.client.close();
    })();
    await this.closing;
  }
}
