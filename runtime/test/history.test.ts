import {
  GatewayQueryCloudEventSchema,
  GatewayQueryResponseSchema,
  gatewayStreamNames,
} from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createClient } from "redis";
import { GatewayCommandIngress } from "../src/application/command-ingress.ts";
import { Gateway } from "../src/application/gateway.ts";
import { GatewayQueryService } from "../src/application/query-service.ts";
import { GatewayPrincipal } from "../src/domain/authorization.ts";
import { GatewayHttpTransport } from "../src/infrastructure/http/transport.ts";
import { GatewayRedisTransport } from "../src/infrastructure/redis/transport.ts";
import { SqlCommandInbox } from "../src/infrastructure/sql/command-inbox.ts";
import { SqlGatewayHistory } from "../src/infrastructure/sql/history.ts";
import { SqlRedisStreamStore } from "../src/infrastructure/sql/redis-stream-store.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!temporaryRoot || !postgresUrl) throw new Error("Explicit isolated fixtures required");
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} observed history orders provider time, scopes cursors and retains accepted outbound identity`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-history-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "history.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    let storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const accountId = randomUUID();
    const store = storage.workspace(workspaceId);
    const socket = new ControlledConnection();
    const gateway = new Gateway(store, () => socket, {
      minimumDelayMs: 0,
      maximumDelayMs: 0,
      typingDelayMs: 0,
    });
    await store.createAccount(accountId);
    const chatAddress = "200@s.whatsapp.net";
    const scope = { apiVersion: "1" as const, workspaceId, accountId, chatAddress };
    try
    {
      await gateway.start(accountId);
      const lease = await gateway.ownership(accountId);
      const inbound = {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        receivingAddress: "100@s.whatsapp.net",
        chatAddress,
        senderAddress: chatAddress,
        mentionsReceiver: false,
        channelMessageId: "later",
        occurredAt: "2026-01-02T00:00:00.000Z",
        text: "second by provider time",
      };
      await store.retain(lease, inbound, "private native later");
      await store.retain(lease, {
        ...inbound,
        channelMessageId: "earlier",
        occurredAt: "2026-01-01T00:00:00.000Z",
        text: "first by provider time",
      }, "private native earlier");
      const message = {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: chatAddress,
        idempotencyKey: "history-send",
        text: "accepted outbound",
      };
      const accepted = await gateway.send(accountId, message);
      await gateway.send(accountId, message);
      const history = new SqlGatewayHistory(store);
      const first = await history.page({ ...scope, direction: "forward", limit: 2 });
      assert.equal(first.coverage, "GATEWAY_OBSERVED");
      assert.deepEqual(first.messages.map(value => value.message.channelMessageId), ["earlier", "later"]);
      assert.ok(first.nextCursor);
      const next = await history.page({ ...scope, direction: "forward", limit: 2, cursor: first.nextCursor });
      assert.equal(next.messages.length, 1);
      assert.equal(next.messages[0]?.direction, "OUTBOUND");
      assert.equal(next.messages[0]?.timestampSource, "GATEWAY_OBSERVATION");
      assert.equal(next.messages[0]?.message.channelMessageId, accepted.nativeIds[0]);
      assert.equal(next.nextCursor, null);
      const backwards = await history.page({ ...scope, direction: "backward", limit: 2 });
      assert.deepEqual(backwards.messages.map(value => value.message.channelMessageId), [
        "later",
        accepted.nativeIds[0],
      ]);
      await assert.rejects(
        history.page({
          ...scope,
          chatAddress: "300@s.whatsapp.net",
          direction: "forward",
          limit: 2,
          cursor: first.nextCursor,
        }),
        /cursor.*scope/i,
      );
      assert.deepEqual(
        await new SqlGatewayHistory(storage.workspace(randomUUID())).page({
          ...scope,
          workspaceId: randomUUID(),
        }).catch(() => null),
        null,
      );
      const edit = {
        ...inbound,
        contentKind: "EDIT" as const,
        channelMessageId: "edit-event",
        text: "edited body",
        target: { channelMessageId: "later", chatAddress, senderAddress: chatAddress },
      };
      await store.retain(lease, edit, "private edit");
      const edited = await history.message({ ...scope, messageId: "later" });
      assert.equal(edited?.edited, true);
      assert.equal(edited?.message.contentKind, "TEXT");
      assert.equal(edited?.message.occurredAt, inbound.occurredAt);
      await store.retain(lease, {
        channel: "WHATSAPP",
        receivingAddress: "100@s.whatsapp.net",
        senderAddress: chatAddress,
        chatAddress,
        occurredAt: inbound.occurredAt,
        mentionsReceiver: false,
        contentKind: "DELETE",
        channelMessageId: "delete-event",
        target: { channelMessageId: "earlier", chatAddress, senderAddress: chatAddress },
      }, "private delete");
      assert.equal((await history.page({ ...scope, direction: "forward" })).messages.length, 2);
      await gateway.close();
      await storage.close();
      storage = await openGatewayStorage(configuration);
      assert.equal(
        (await new SqlGatewayHistory(storage.workspace(workspaceId)).page({ ...scope })).messages.length,
        2,
      );
      assert.equal(socket.sent.length, 1);
    }
    finally
    {
      await gateway.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} HTTP and Redis share authorized history queries without a connected account or SQL media blobs`, async () =>
  {
    const redisUrl = process.env["GATEWAY_TEST_REDIS_URL"];
    assert.ok(redisUrl);
    const directory = await mkdtemp(join(temporaryRoot, "gateway-query-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "queries.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const accountId = randomUUID();
    const store = storage.workspace(workspaceId);
    await store.createAccount(accountId);
    const gateway = new Gateway(store, () =>
    {
      throw new Error("Queries must not start a socket");
    });
    const history = new SqlGatewayHistory(store);
    const queries = new GatewayQueryService(store, gateway, history);
    const principal = new GatewayPrincipal("query-reader", [{ workspaceId, accountIds: [accountId] }]);
    const token = randomUUID();
    const http = new GatewayHttpTransport({ enabled: true, port: 0 }, [{
      store,
      gateway,
      queries,
      commands: new GatewayCommandIngress(new SqlCommandInbox(store)),
    }], [{ token, principal }]);
    const prefix = `test:${randomUUID()}`;
    const redis = new GatewayRedisTransport(
      new SqlRedisStreamStore(store),
      { enabled: true, url: redisUrl, prefix, reclaimIdleMs: 1 },
      [{ accountId, principal }],
      undefined,
      queries,
    );
    const client = createClient({ url: redisUrl });
    client.on("error", () => undefined);
    try
    {
      await http.start();
      await redis.start();
      await client.connect();
      const query = {
        apiVersion: "1",
        workspaceId,
        accountId,
        requestId: randomUUID(),
        type: "history.page",
        chatAddress: "200@s.whatsapp.net",
      };
      const response = await fetch(http.origin + "/v1/queries", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(query),
      });
      assert.equal(response.status, 200);
      const result = GatewayQueryResponseSchema.parse(await response.json());
      assert.equal(result.type, "history.page");
      if (result.type !== "history.page") throw new Error("Incorrect history response");
      assert.deepEqual(result.result.messages, []);
      assert.equal(result.result.coverage, "GATEWAY_OBSERVED");
      const forbidden = await fetch(http.origin + "/v1/queries", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...query, accountId: randomUUID() }),
      });
      assert.equal(forbidden.status, 403);
      const streams = gatewayStreamNames(prefix, { workspaceId, accountId });
      await client.xAdd(streams.commands, "*", { payload: JSON.stringify(query) });
      assert.equal(await redis.consumeOnce(), 1);
      assert.equal((await client.xPending(streams.commands, "gateway")).pending, 0);
      const events = await client.xRange(streams.results, "-", "+");
      assert.ok(events);
      assert.equal(events.length, 1);
      const event = GatewayQueryCloudEventSchema.parse(JSON.parse(events[0]!.message["payload"]!));
      assert.deepEqual(event.data.response, result);
      assert.equal(event.data.failure, null);
      await client.xAdd(streams.commands, "*", { payload: JSON.stringify(query) });
      await redis.consumeOnce();
      const replay = await client.xRange(streams.results, "-", "+");
      assert.ok(replay);
      assert.equal(replay.length, 2);
      assert.notEqual(replay[0]?.id, replay[1]?.id);
      assert.equal((await store.account(accountId)).generation, 0);
    }
    finally
    {
      await http.close();
      await redis.close();
      await gateway.close();
      if (client.isOpen) await client.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
