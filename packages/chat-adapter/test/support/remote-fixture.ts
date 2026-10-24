import {
  type GatewayCloudEvent,
  type InboundMessage,
  signGatewayWebhook,
} from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  GatewayCommandIngress,
  GatewayCommandWorker,
} from "../../../../runtime/src/application/command-ingress.ts";
import { Gateway } from "../../../../runtime/src/application/gateway.ts";
import { GatewayQueryService } from "../../../../runtime/src/application/query-service.ts";
import { GatewayPrincipal } from "../../../../runtime/src/domain/authorization.ts";
import { GatewayHttpTransport } from "../../../../runtime/src/infrastructure/http/transport.ts";
import { GatewayRedisTransport } from "../../../../runtime/src/infrastructure/redis/transport.ts";
import { SqlCommandInbox } from "../../../../runtime/src/infrastructure/sql/command-inbox.ts";
import { SqlGatewayEventLog } from "../../../../runtime/src/infrastructure/sql/event-log.ts";
import { SqlGatewayHistory } from "../../../../runtime/src/infrastructure/sql/history.ts";
import { SqlRedisStreamStore } from "../../../../runtime/src/infrastructure/sql/redis-stream-store.ts";
import {
  type GatewayStorage,
  migrateGatewayStorage,
  openGatewayStorage,
} from "../../../../runtime/src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "../../../../runtime/test/support/controlled-connection.ts";
import { WhatsAppGatewayAdapter } from "../../src/adapter.ts";
import { GatewayRedisClient } from "../../src/redis-client.ts";
import { GatewayHttpClient, GatewayRemoteClient } from "../../src/remote-client.ts";
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
const redisUrl = process.env["GATEWAY_TEST_REDIS_URL"];
if (!temporaryRoot || !postgresUrl || !redisUrl)
{
  throw new Error("Explicit isolated SQL/Redis fixtures required");
}
export class RemoteFixture
{
  readonly workspaceId = randomUUID();
  readonly accountId = randomUUID();
  readonly socket = new ControlledConnection();
  readonly token = randomUUID();
  readonly secret = randomUUID();
  readonly prefix = `test:${randomUUID()}`;
  directory = "";
  storage!: GatewayStorage;
  gateway!: Gateway;
  http!: GatewayHttpTransport;
  redis!: GatewayRedisTransport;
  client!: GatewayRemoteClient;
  adapter!: WhatsAppGatewayAdapter;
  private readonly controller = new AbortController();
  private loop: Promise<void> | undefined;
  async start(engine: "sqlite" | "postgresql", transport: "http" | "redis"): Promise<void>
  {
    this.directory = await mkdtemp(join(temporaryRoot!, "gateway-sdk-"));
    const configuration = engine === "sqlite"
      ? { engine, mode: "local" as const, filename: join(this.directory, "sdk.sqlite") }
      : { engine, mode: "cluster" as const, url: postgresUrl! };
    await migrateGatewayStorage(configuration);
    this.storage = await openGatewayStorage(configuration);
    const store = this.storage.workspace(this.workspaceId);
    await store.createAccount(this.accountId);
    this.gateway = new Gateway(store, () => this.socket, {
      minimumDelayMs: 0,
      maximumDelayMs: 0,
      typingDelayMs: 0,
    });
    const principal = new GatewayPrincipal("sdk-consumer", [{
      workspaceId: this.workspaceId,
      accountIds: [this.accountId],
    }]);
    const inbox = new SqlCommandInbox(store);
    const queries = new GatewayQueryService(store, this.gateway, new SqlGatewayHistory(store), this.gateway);
    this.http = new GatewayHttpTransport({ enabled: true, port: 0 }, [{
      store,
      gateway: this.gateway,
      commands: new GatewayCommandIngress(inbox),
      queries,
    }], [{ token: this.token, principal }]);
    this.redis = new GatewayRedisTransport(
      new SqlRedisStreamStore(store),
      { enabled: true, url: redisUrl!, prefix: this.prefix, reclaimIdleMs: 1 },
      [{ accountId: this.accountId, principal }],
      undefined,
      queries,
    );
    await this.http.start();
    await this.redis.start();
    await this.gateway.start(this.accountId);
    const scope = { workspaceId: this.workspaceId, accountId: this.accountId };
    this.client = new GatewayRemoteClient(
      scope,
      transport === "http"
        ? new GatewayHttpClient({
          url: this.http.origin!,
          token: this.token,
          pollIntervalMs: 5,
          timeoutMs: 5000,
        })
        : new GatewayRedisClient({
          ...scope,
          url: redisUrl!,
          prefix: this.prefix,
          resultGroup: `sdk-${randomUUID()}`,
          timeoutMs: 5000,
        }),
    );
    this.adapter = new WhatsAppGatewayAdapter({
      ...scope,
      client: this.client,
      nativeJid: "100@s.whatsapp.net",
      webhookSecret: this.secret,
    });
    const worker = new GatewayCommandWorker(inbox, this.gateway);
    this.loop = (async () =>
    {
      while (!this.controller.signal.aborted)
      {
        await this.redis.consumeOnce();
        await worker.runOne(await this.gateway.ownership(this.accountId));
        for (let index = 0; index < 100 && await this.redis.publishOnce(); index++)
        {
          /* bounded publication drain */
        }
        await delay(5);
      }
    })();
  }
  async inbound(messageId = randomUUID(), text = "incoming"): Promise<GatewayCloudEvent>
  {
    const message: InboundMessage = {
      channel: "WHATSAPP",
      contentKind: "TEXT",
      receivingAddress: "100@s.whatsapp.net",
      senderAddress: "200@s.whatsapp.net",
      chatAddress: "200@s.whatsapp.net",
      channelMessageId: messageId,
      mentionsReceiver: false,
      occurredAt: new Date().toISOString(),
      text,
    };
    return this.retainMessage(message);
  }
  async retainMessage(message: InboundMessage): Promise<GatewayCloudEvent>
  {
    const store = this.storage.workspace(this.workspaceId);
    await store.retain(
      await this.gateway.ownership(this.accountId),
      message,
      JSON.stringify({
        key: { id: message.channelMessageId, remoteJid: message.chatAddress },
        message: { conversation: "fixture" },
      }),
    );
    const events = await new SqlGatewayEventLog(store).after(this.accountId, 0, 1000);
    const event = events.find(item =>
      item.type === "com.digows.whatsapp.message.received.v1"
      && item.data.message.channelMessageId === message.channelMessageId
    );
    assert.ok(event);
    return event;
  }
  async receiveMessage(message: InboundMessage): Promise<GatewayCloudEvent | null>
  {
    await this.socket.events.received(
      message,
      JSON.stringify({
        key: { id: message.channelMessageId, remoteJid: message.chatAddress },
        message: { conversation: "fixture" },
      }),
    );
    const events = await new SqlGatewayEventLog(this.storage.workspace(this.workspaceId))
      .after(this.accountId, 0, 1000);
    return events.find(event =>
      event.type === "com.digows.whatsapp.message.received.v1"
      && event.data.message.channelMessageId === message.channelMessageId
    ) ?? null;
  }
  async webhook(event: GatewayCloudEvent): Promise<Response>
  {
    const body = Buffer.from(JSON.stringify(event));
    const signature = await signGatewayWebhook(
      this.secret,
      event.id,
      String(Math.floor(Date.now() / 1000)),
      body,
    );
    return this.adapter.handleWebhook(
      new Request("http://consumer.invalid/webhook", {
        method: "POST",
        headers: {
          "x-gateway-event-id": signature.eventId,
          "x-gateway-timestamp": signature.timestamp,
          "x-gateway-signature": signature.signature,
        },
        body,
      }),
    );
  }
  thread(): string
  {
    return this.adapter.encodeThreadId({
      workspaceId: this.workspaceId,
      accountId: this.accountId,
      chatId: "200@s.whatsapp.net",
    });
  }
  async close(): Promise<void>
  {
    this.controller.abort();
    await this.loop;
    await this.adapter?.disconnect();
    await this.http?.close();
    await this.redis?.close();
    await this.gateway?.close();
    await this.storage?.close();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
