import { createMemoryState } from "@chat-adapter/state-memory";
import { createRedisState } from "@chat-adapter/state-redis";
import type { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { Actions, Button, Card, CardText, Chat } from "chat";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMastraGatewayExample } from "../examples/mastra.ts";
import { WhatsAppGatewayAdapter } from "../src/adapter.ts";
import { GatewayRedisEvents } from "../src/redis-client.ts";
import { GatewayHttpClient, GatewayRemoteClient } from "../src/remote-client.ts";
import { RemoteFixture } from "./support/remote-fixture.ts";
const redisUrl = process.env["GATEWAY_TEST_REDIS_URL"];
if (!redisUrl) throw new Error("Explicit isolated Redis fixture required");
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
