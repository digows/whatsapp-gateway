import {
  type AccountScope,
  AccountScopeSchema,
  GatewayCloudEventSchema,
  GatewayQueryCloudEventSchema,
  gatewayStreamNames,
} from "@digows/whatsapp-gateway-contracts";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "redis";
import { z } from "zod";
import {
  assertCorrelation,
  type GatewayRemoteRequest,
  GatewayRemoteRequestError,
  GatewayRemoteRequestSchema,
  type GatewayRemoteResponse,
  type GatewayRemoteWire,
} from "./remote-client.ts";
export interface GatewayRedisClientConfiguration extends AccountScope
{
  readonly url: string;
  readonly prefix?: string;
  /** Stable, exclusive to this consumer application instance; separate from the gateway group. */
  readonly resultGroup: string;
  readonly timeoutMs?: number;
}
interface PendingResponse
{
  readonly request: GatewayRemoteRequest;
  readonly resolve: (value: GatewayRemoteResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
export class GatewayRedisClient implements GatewayRemoteWire
{
  readonly scope: AccountScope;
  private readonly client;
  private readonly streams;
  private readonly consumer = randomUUID();
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingResponse>();
  private starting: Promise<void> | undefined;
  private loop: Promise<void> | undefined;
  private readonly controller = new AbortController();
  constructor(private readonly configuration: GatewayRedisClientConfiguration)
  {
    this.scope = AccountScopeSchema.parse({
      workspaceId: configuration.workspaceId,
      accountId: configuration.accountId,
    });
    this.streams = gatewayStreamNames(configuration.prefix ?? "gateway:v1", this.scope);
    z.string().min(1).max(128).parse(configuration.resultGroup);
    this.timeoutMs = z.number().int().positive().max(300000).parse(configuration.timeoutMs ?? 120000);
    this.client = createClient({
      url: configuration.url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false, connectTimeout: 5000 },
    });
    this.client.on(
      "error",
      () => this.failPending("Redis result connection failed; preserve operation identities"),
    );
  }
  async start(): Promise<void>
  {
    if (this.controller.signal.aborted) throw new Error("Redis gateway client is closed");
    this.starting ??= (async () =>
    {
      await this.client.connect();
      try
      {
        await this.client.xGroupCreate(this.streams.results, this.configuration.resultGroup, "0-0", {
          MKSTREAM: true,
        });
      }
      catch (error)
      {
        if (!(error instanceof Error) || !error.message.startsWith("BUSYGROUP ")) throw error;
      }
      this.loop = this.readResults();
      void this.loop.catch(() =>
        this.failPending("Redis result reader failed; preserve operation identities")
      );
    })();
    await this.starting;
  }
  async request(input: GatewayRemoteRequest): Promise<GatewayRemoteResponse>
  {
    const request = GatewayRemoteRequestSchema.parse(input);
    if (request.workspaceId !== this.scope.workspaceId || request.accountId !== this.scope.accountId)
    {
      throw new Error("Redis request scope mismatch");
    }
    await this.start();
    if (!this.client.isReady || this.controller.signal.aborted)
    {
      throw new GatewayRemoteRequestError(request, "Redis gateway client is unavailable");
    }
    if (this.pending.size >= 256 || this.pending.has(request.requestId))
    {
      throw new Error("Redis request capacity or request identity conflict");
    }
    return new Promise<GatewayRemoteResponse>((resolve, reject) =>
    {
      const timer = setTimeout(() =>
      {
        this.pending.delete(request.requestId);
        reject(
          new GatewayRemoteRequestError(
            request,
            "Redis gateway request timed out; inspect its original operation key",
          ),
        );
      }, this.timeoutMs);
      this.pending.set(request.requestId, { request, resolve, reject, timer });
      void this.publish(request).catch(() =>
        this.rejectRequest(request.requestId, "Redis request publication failed; acceptance is unconfirmed")
      );
    });
  }
  private async publish(request: GatewayRemoteRequest): Promise<void>
  {
    const commands = this.client.withAbortSignal(
      AbortSignal.any([this.controller.signal, AbortSignal.timeout(Math.min(this.timeoutMs, 10000))]),
    );
    await commands.xAdd(this.streams.commands, "*", { payload: JSON.stringify(request) });
    const persisted = z.tuple([z.number(), z.number()]).parse(
      await commands.sendCommand(["WAITAOF", "1", "0", "5000"]),
    );
    if (persisted[0] !== 1) throw new Error("Redis request was not confirmed in local AOF");
  }
  private async readResults(): Promise<void>
  {
    let cursor = "0-0";
    while (!this.controller.signal.aborted)
    {
      const commands = this.client.withAbortSignal(this.controller.signal);
      const claimed = await commands.xAutoClaim(
        this.streams.results,
        this.configuration.resultGroup,
        this.consumer,
        30000,
        cursor,
        { COUNT: 32 },
      );
      cursor = claimed.nextId;
      if (claimed.deletedMessages.length) throw new Error("Pending result payloads were deleted");
      const fresh = claimed.messages.length
        ? null
        : await commands.xReadGroup(this.configuration.resultGroup, this.consumer, [{
          key: this.streams.results,
          id: ">",
        }], { COUNT: 32 });
      const records = claimed.messages.length
        ? claimed.messages
        : fresh?.flatMap(stream => stream.messages) ?? [];
      for (const record of records)
      {
        const payload = JSON.parse(record.message["payload"] ?? "");
        const query = GatewayQueryCloudEventSchema.safeParse(payload);
        const event = query.success ? query.data : GatewayCloudEventSchema.parse(payload);
        if (event.workspaceid !== this.scope.workspaceId || event.accountid !== this.scope.accountId)
        {
          throw new Error("Redis result scope mismatch");
        }
        const requestId = "requestId" in event.data ? event.data.requestId : null;
        const pending = requestId ? this.pending.get(requestId) : undefined;
        if (pending)
        {
          if (event.type === "com.digows.whatsapp.query.result.v1")
          {
            if (event.data.response) this.complete(pending, event.data.response);
            else this.rejectRequest(pending.request.requestId, `Gateway query failed: ${event.data.failure}`);
          }
          else if (event.type === "com.digows.whatsapp.command.updated.v1")
          {
            if (event.data.response) this.complete(pending, event.data.response);
            else if (event.data.state === "FAILED")
            {
              this.rejectRequest(
                pending.request.requestId,
                "Gateway command execution failed; inspect its operation key",
              );
            }
          }
          else if (
            event.type === "com.digows.whatsapp.ingress.receipt.v1" && event.data.status === "REJECTED"
          )
          {
            this.rejectRequest(pending.request.requestId, `Gateway intake rejected: ${event.data.failure}`);
          }
        }
        await commands.xAck(this.streams.results, this.configuration.resultGroup, record.id);
      }
      if (!records.length) await delay(25, undefined, { signal: this.controller.signal });
    }
  }
  private complete(pending: PendingResponse, response: GatewayRemoteResponse): void
  {
    assertCorrelation(pending.request, response);
    clearTimeout(pending.timer);
    this.pending.delete(pending.request.requestId);
    pending.resolve(response);
  }
  private rejectRequest(requestId: string, message: string): void
  {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.reject(new GatewayRemoteRequestError(pending.request, message));
  }
  private failPending(message: string): void
  {
    for (const requestId of this.pending.keys()) this.rejectRequest(requestId, message);
  }
  async close(): Promise<void>
  {
    this.controller.abort();
    this.failPending("Redis gateway client closed; preserve operation identities");
    await this.starting?.catch(() => undefined);
    await this.loop?.catch(() => undefined);
    if (this.client.isOpen) await this.client.close();
  }
}
export interface GatewayRedisEventsConfiguration extends AccountScope
{
  readonly url: string;
  readonly prefix?: string;
  readonly group: string;
  readonly reclaimIdleMs?: number;
}
/** Application-side event intake. The receiver must finish its handler before fulfillment/ACK. */
export class GatewayRedisEvents
{
  private readonly client;
  private readonly stream: string;
  private readonly scope: AccountScope;
  private readonly consumer = randomUUID();
  private readonly controller = new AbortController();
  private started: Promise<void> | undefined;
  private running: Promise<boolean> | undefined;
  private cursor = "0-0";
  constructor(private readonly configuration: GatewayRedisEventsConfiguration)
  {
    this.scope = AccountScopeSchema.parse({
      workspaceId: configuration.workspaceId,
      accountId: configuration.accountId,
    });
    this.stream = gatewayStreamNames(configuration.prefix ?? "gateway:v1", this.scope).events;
    z.string().min(1).max(128).parse(configuration.group);
    z.number().int().positive().max(300000).parse(configuration.reclaimIdleMs ?? 30000);
    this.client = createClient({
      url: configuration.url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false, connectTimeout: 5000 },
    });
    this.client.on("error", () => undefined);
  }
  async start(): Promise<void>
  {
    if (this.controller.signal.aborted) throw new Error("Redis events are closed");
    this.started ??= (async () =>
    {
      await this.client.connect();
      try
      {
        await this.client.xGroupCreate(this.stream, this.configuration.group, "0-0", { MKSTREAM: true });
      }
      catch (error)
      {
        if (!(error instanceof Error) || !error.message.startsWith("BUSYGROUP ")) throw error;
      }
    })();
    await this.started;
  }
  async consumeOnce(handler: (event: unknown) => Promise<void>): Promise<boolean>
  {
    if (this.running) throw new Error("An event consumption is already active");
    this.running = this.consume(handler);
    try
    {
      return await this.running;
    }
    finally
    {
      this.running = undefined;
    }
  }
  private async consume(handler: (event: unknown) => Promise<void>): Promise<boolean>
  {
    await this.start();
    const commands = this.client.withAbortSignal(this.controller.signal);
    const claimed = await commands.xAutoClaim(
      this.stream,
      this.configuration.group,
      this.consumer,
      this.configuration.reclaimIdleMs ?? 30000,
      this.cursor,
      { COUNT: 1 },
    );
    this.cursor = claimed.nextId;
    if (claimed.deletedMessages.length) throw new Error("Pending event bodies were deleted");
    const fresh = claimed.messages.length
      ? null
      : await commands.xReadGroup(this.configuration.group, this.consumer, [{ key: this.stream, id: ">" }], {
        COUNT: 1,
      });
    const record = claimed.messages[0] ?? fresh?.[0]?.messages[0];
    if (!record) return false;
    const event = GatewayCloudEventSchema.parse(JSON.parse(record.message["payload"] ?? ""));
    if (event.workspaceid !== this.scope.workspaceId || event.accountid !== this.scope.accountId)
    {
      throw new Error("Redis event scope mismatch");
    }
    await handler(event);
    await commands.xAck(this.stream, this.configuration.group, record.id);
    return true;
  }
  async close(): Promise<void>
  {
    this.controller.abort();
    await this.started?.catch(() => undefined);
    await this.running?.catch(() => undefined);
    if (this.client.isOpen) await this.client.close();
  }
}
