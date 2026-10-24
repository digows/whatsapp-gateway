import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import {
  type GatewayCloudEvent,
  type InboundMessage,
  signGatewayWebhook,
} from "@digows/whatsapp-gateway-contracts";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { Actions, Button, Card, CardText, Chat } from "chat";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  GatewayCommandIngress,
  GatewayCommandWorker,
} from "../../../runtime/src/application/command-ingress.ts";
import { Gateway } from "../../../runtime/src/application/gateway.ts";
import { GatewayQueryService } from "../../../runtime/src/application/query-service.ts";
import { GatewayPrincipal } from "../../../runtime/src/domain/authorization.ts";
import { GatewayHttpTransport } from "../../../runtime/src/infrastructure/http/transport.ts";
import { GatewayRedisTransport } from "../../../runtime/src/infrastructure/redis/transport.ts";
import { SqlCommandInbox } from "../../../runtime/src/infrastructure/sql/command-inbox.ts";
import { SqlGatewayEventLog } from "../../../runtime/src/infrastructure/sql/event-log.ts";
import { SqlGatewayHistory } from "../../../runtime/src/infrastructure/sql/history.ts";
import { SqlRedisStreamStore } from "../../../runtime/src/infrastructure/sql/redis-stream-store.ts";
import {
  type GatewayStorage,
  migrateGatewayStorage,
  openGatewayStorage,
} from "../../../runtime/src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "../../../runtime/test/support/controlled-connection.ts";
import { createMastraGatewayExample } from "../examples/mastra.ts";
import { WhatsAppGatewayAdapter } from "../src/adapter.ts";
import { GatewayRedisClient, GatewayRedisEvents } from "../src/redis-client.ts";
import { GatewayHttpClient, GatewayRemoteClient } from "../src/remote-client.ts";
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
const redisUrl = process.env["GATEWAY_TEST_REDIS_URL"];
if (!temporaryRoot || !postgresUrl || !redisUrl)
{
  throw new Error("Explicit isolated SQL/Redis fixtures required");
}
class RemoteFixture
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
for (const engine of ["sqlite", "postgresql"] as const)
{
  for (const transport of ["http", "redis"] as const)
  {
    test(`${engine}/${transport} actual Chat Adapter handles failure, completion dedupe, stable sends and lifecycle methods`, async () =>
    {
      const fixture = new RemoteFixture();
      let chat: Chat | undefined;
      try
      {
        await fixture.start(engine, transport);
        chat = new Chat({
          userName: "agent",
          adapters: { whatsapp: fixture.adapter },
          state: createMemoryState(),
          concurrency: "concurrent",
        });
        let attempts = 0;
        chat.onDirectMessage(async (thread, message) =>
        {
          attempts++;
          await fixture.adapter.postWithKey(
            thread.id,
            { markdown: `**reply** to ${message.text}` },
            "stable-handler-reply",
          );
          if (attempts === 1) throw new Error("Controlled handler failure after accepted stable-key post");
        });
        await chat.initialize();
        const event = await fixture.inbound();
        assert.equal((await fixture.webhook(event)).status, 503);
        assert.equal((await fixture.webhook(event)).status, 204);
        assert.equal((await fixture.webhook(event)).status, 204);
        assert.equal(attempts, 2);
        assert.equal(fixture.socket.sent.length, 1);
        const result = await fixture.adapter.postWithKey(fixture.thread(), {
          markdown: "**reply** to incoming",
        }, "stable-handler-reply");
        assert.equal(fixture.socket.sent.length, 1);
        assert.equal(result.raw.message.contentKind, "TEXT");
        if (result.raw.message.contentKind !== "TEXT") throw new Error("Text result missing");
        assert.equal(result.raw.message.text, "*reply* to incoming");
        await fixture.adapter.editMessage(fixture.thread(), result.id, "edited");
        assert.equal((await fixture.adapter.fetchMessage(fixture.thread(), result.id))?.text, "edited");
        await fixture.adapter.addReaction(fixture.thread(), result.id, "👍");
        await fixture.adapter.removeReaction(fixture.thread(), result.id, "👍");
        await fixture.adapter.deleteMessage(fixture.thread(), result.id);
        assert.equal(await fixture.adapter.fetchMessage(fixture.thread(), result.id), null);
        assert.equal((await fixture.adapter.fetchMessages(fixture.thread())).messages.length, 1);
        await assert.rejects(
          fixture.adapter.postWithKey(fixture.thread(), "conflicting text", "stable-handler-reply"),
        );
        const card = Card({
          title: "Choose",
          children: [
            CardText("A choice"),
            Actions([Button({ id: "approve", label: "Approve", value: "item-42" })]),
          ],
        });
        const posted = await fixture.adapter.postWithKey(fixture.thread(), card, "interactive-card");
        assert.equal(posted.raw.message.contentKind, "BUTTONS");
        if (posted.raw.message.contentKind !== "BUTTONS") throw new Error("Interactive content unavailable");
        if (
          event.type !== "com.digows.whatsapp.message.received.v1"
          || event.data.message.contentKind !== "TEXT"
        ) throw new Error("Expected incoming text event");
        const { text: _text, contentKind: _kind, ...base } = event.data.message;
        let actionCount = 0;
        let reactionCount = 0;
        let editedCount = 0;
        let deletedCount = 0;
        chat.onAction("approve", async action =>
        {
          assert.equal(action.value, "item-42");
          assert.equal(action.messageId, posted.id);
          actionCount++;
        });
        chat.onReaction(async reaction =>
        {
          assert.equal(reaction.messageId, posted.id);
          reactionCount++;
        });
        chat.onMessageUpdated(async (_thread, message) =>
        {
          assert.equal(message.id, base.channelMessageId);
          assert.equal(message.text, "inbound edit");
          editedCount++;
        });
        chat.onMessageDeleted(async deleted =>
        {
          assert.equal(deleted.messageId, posted.id);
          deletedCount++;
        });
        const selection = await fixture.retainMessage({
          ...base,
          channelMessageId: randomUUID(),
          contentKind: "SELECTION",
          optionId: posted.raw.message.choices[0]!.id,
          originatingChannelMessageId: posted.id,
        });
        assert.equal((await fixture.webhook(selection)).status, 204);
        assert.equal((await fixture.webhook(selection)).status, 204);
        const target = {
          channelMessageId: posted.id,
          chatAddress: base.chatAddress,
          senderAddress: "100@s.whatsapp.net",
        };
        for (const emoji of ["👍", ""])
        {
          const reaction = await fixture.retainMessage({
            ...base,
            channelMessageId: randomUUID(),
            contentKind: "REACTION",
            emoji,
            target,
          });
          assert.equal((await fixture.webhook(reaction)).status, 204);
        }
        const edit = await fixture.retainMessage({
          ...base,
          channelMessageId: randomUUID(),
          contentKind: "EDIT",
          text: "inbound edit",
          target: { ...target, channelMessageId: base.channelMessageId, senderAddress: base.senderAddress },
        });
        assert.equal((await fixture.webhook(edit)).status, 204);
        const deletion = await fixture.retainMessage({
          ...base,
          channelMessageId: randomUUID(),
          contentKind: "DELETE",
          target,
        });
        assert.equal((await fixture.webhook(deletion)).status, 204);
        assert.deepEqual([actionCount, reactionCount, editedCount, deletedCount], [1, 2, 1, 1]);
        fixture.socket.failSend = true;
        await assert.rejects(
          fixture.adapter.postWithKey(fixture.thread(), "unconfirmed native effect", "unknown-native"),
        );
        assert.equal((await fixture.client.operation(fixture.accountId, "unknown-native")).state, "UNKNOWN");

        assert.equal((await fixture.adapter.fetchThread(fixture.thread())).isDM, true);
        await assert.rejects(fixture.adapter.processGatewayEvent({ ...event, accountid: randomUUID() }));
      }
      finally
      {
        await chat?.shutdown();
        await fixture.close();
      }
    });
  }
}

for (const transport of ["http", "redis"] as const)
{
  test(`released Mastra 1.79.0 channels and Chat 4.43.0 produce a native reply through ${transport}`, async () =>
  {
    const fixture = new RemoteFixture();
    let mastra: Mastra | undefined;
    let events: GatewayRedisEvents | undefined;
    let modelCalls = 0;
    try
    {
      await fixture.start("sqlite", transport);
      const model = createMockModel({
        mockText: "Native Mastra framework reply",
        version: "v2",
        spyStream: () =>
        {
          modelCalls++;
        },
      });
      if (model.specificationVersion !== "v2") throw new Error("Expected a V2 model fixture");
      const composition = await createMastraGatewayExample({
        adapter: fixture.adapter,
        model,
        state: createMemoryState(),
        storage: new InMemoryStore(),
      });
      mastra = composition.mastra;
      const event = await fixture.inbound();
      if (transport === "http") assert.equal((await fixture.webhook(event)).status, 204);
      else
      {
        events = new GatewayRedisEvents({
          workspaceId: fixture.workspaceId,
          accountId: fixture.accountId,
          url: redisUrl!,
          prefix: fixture.prefix,
          group: `framework-${randomUUID()}`,
          reclaimIdleMs: 1,
        });
        for (let attempt = 0; attempt < 100 && !fixture.socket.sent.length; attempt++)
        {
          await events.consumeOnce(value => fixture.adapter.processGatewayEvent(value));
          await delay(10);
        }
      }
      const deadline = Date.now() + 10000;
      while (!fixture.socket.sent.length && Date.now() < deadline) await delay(10);
      assert.ok(modelCalls > 0, "Native model boundary must execute");
      const history = await fixture.adapter.fetchMessages(fixture.thread());
      assert.ok(history.messages.some(message =>
        message.author.isMe && message.text.includes("Native Mastra framework reply")
      ));
      const before = fixture.socket.sent.length;
      await fixture.adapter.processGatewayEvent(event);
      assert.equal(fixture.socket.sent.length, before);
    }
    finally
    {
      await events?.close();
      await mastra?.shutdown();
      await fixture.close();
    }
  });
}

test("native Chat postMessage after handler failure uses fresh operations; explicit stable keys remain required", async () =>
{
  const fixture = new RemoteFixture();
  let chat: Chat | undefined;
  try
  {
    await fixture.start("sqlite", "http");
    chat = new Chat({
      userName: "agent",
      adapters: { whatsapp: fixture.adapter },
      state: createMemoryState(),
      concurrency: "concurrent",
    });
    let attempts = 0;
    chat.onDirectMessage(async (thread) =>
    {
      attempts++;
      await thread.post("Native post has no caller operation key");
      if (attempts === 1) throw new Error("Failure after the accepted post");
    });
    await chat.initialize();
    const event = await fixture.inbound();
    assert.equal((await fixture.webhook(event)).status, 503);
    assert.equal((await fixture.webhook(event)).status, 204);
    assert.equal(
      fixture.socket.sent.length,
      2,
      "Native post intentionally creates a new operation on handler replay",
    );
    assert.notEqual(
      fixture.socket.sent[0]?.options["messageId"],
      fixture.socket.sent[1]?.options["messageId"],
    );
  }
  finally
  {
    await chat?.shutdown();
    await fixture.close();
  }
});

test("actual Redis Chat state preserves completed event identity across Adapter reconstruction", async () =>
{
  const fixture = new RemoteFixture();
  let chat: Chat | undefined;
  const keyPrefix = `sdk-state:${randomUUID()}`;
  try
  {
    await fixture.start("sqlite", "http");
    const event = await fixture.inbound();
    let attempts = 0;
    chat = new Chat({
      userName: "agent",
      adapters: { whatsapp: fixture.adapter },
      state: createRedisState({ url: redisUrl!, keyPrefix }),
      concurrency: "concurrent",
    });
    chat.onDirectMessage(async () =>
    {
      attempts++;
    });
    await chat.initialize();
    await fixture.adapter.processGatewayEvent(event);
    await chat.shutdown();
    fixture.client = new GatewayRemoteClient({
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountId,
    }, new GatewayHttpClient({ url: fixture.http.origin!, token: fixture.token }));
    fixture.adapter = new WhatsAppGatewayAdapter({
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountId,
      client: fixture.client,
      nativeJid: "100@s.whatsapp.net",
      webhookSecret: fixture.secret,
    });
    chat = new Chat({
      userName: "agent",
      adapters: { whatsapp: fixture.adapter },
      state: createRedisState({ url: redisUrl!, keyPrefix }),
      concurrency: "concurrent",
    });
    chat.onDirectMessage(async () =>
    {
      attempts++;
    });
    await chat.initialize();
    await fixture.adapter.processGatewayEvent(event);
    assert.equal(attempts, 1);
  }
  finally
  {
    await chat?.shutdown();
    await fixture.close();
  }
});
