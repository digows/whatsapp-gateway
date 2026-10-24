import { Parser } from "@asyncapi/parser";
import { GatewayCloudEventSchema, gatewayStreamNames } from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createClient } from "redis";
import { GatewayCommandWorker } from "../src/application/command-ingress.ts";
import { Gateway } from "../src/application/gateway.ts";
import { GatewayPrincipal } from "../src/domain/authorization.ts";
import { createGatewayAsyncApi } from "../src/infrastructure/redis/asyncapi.ts";
import { GatewayRedisTransport } from "../src/infrastructure/redis/transport.ts";
import { SqlCommandInbox } from "../src/infrastructure/sql/command-inbox.ts";
import { SqlRedisStreamStore } from "../src/infrastructure/sql/redis-stream-store.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
const redisUrl = process.env["GATEWAY_TEST_REDIS_URL"];
if (!temporaryRoot || !postgresUrl || !redisUrl)
{
  throw new Error("Explicit isolated SQL/Redis fixtures required");
}
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} real Redis commands ACK durable scoped intake and publish native outcomes without duplicate sends`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "streams.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const accountId = randomUUID();
    const prefix = `test:${randomUUID()}`;
    const store = storage.workspace(workspaceId);
    await store.createAccount(accountId);
    const principal = new GatewayPrincipal("producer", [{ workspaceId, accountIds: [accountId] }]);
    const streamStore = new SqlRedisStreamStore(store);
    const transport = new GatewayRedisTransport(streamStore, {
      enabled: true,
      url: redisUrl,
      prefix,
      reclaimIdleMs: 1,
    }, [{ accountId, principal }]);
    const client = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    client.on("error", () => undefined);
    const socket = new ControlledConnection();
    const gateway = new Gateway(store, () => socket, {
      minimumDelayMs: 0,
      maximumDelayMs: 0,
      typingDelayMs: 0,
    });
    const streams = gatewayStreamNames(prefix, { workspaceId, accountId });
    const command = {
      apiVersion: "1",
      workspaceId,
      accountId,
      requestId: randomUUID(),
      type: "send",
      message: {
        channel: "WHATSAPP",
        contentKind: "TEXT",
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: "200@s.whatsapp.net",
        idempotencyKey: "redis-effect",
        text: "one native effect",
      },
    };
    try
    {
      await client.connect();
      await transport.start();
      const first = await client.xAdd(streams.commands, "*", { payload: JSON.stringify(command) });
      await transport.consumeOnce();
      assert.equal((await client.xPending(streams.commands, "gateway")).pending, 0);
      assert.equal((await streamStore.receipt(accountId, streams.commands, first)).status, "QUEUED");
      assert.equal(await store.operation(accountId, command.message.idempotencyKey).catch(() => null), null);
      assert.equal(socket.sent.length, 0);
      await client.xAdd(streams.commands, "*", { payload: JSON.stringify(command) });
      await transport.consumeOnce();
      await gateway.start(accountId);
      const worker = new GatewayCommandWorker(new SqlCommandInbox(store), gateway);
      assert.equal(await worker.runOne(await gateway.ownership(accountId)), true);
      assert.equal(await worker.runOne(await gateway.ownership(accountId)), false);
      assert.equal(socket.sent.length, 1);
      for (let iteration = 0; iteration < 100 && await transport.publishOnce(); iteration++)
      {
        /* Drain committed publications. */
      }
      const results = await client.xRange(streams.results, "-", "+");
      assert.ok(results);
      const envelopes = results.map(result =>
        GatewayCloudEventSchema.parse(JSON.parse(result.message["payload"]!))
      );
      assert.ok(envelopes.some(event =>
        event.type === "com.digows.whatsapp.command.updated.v1" && event.data.state === "COMPLETED"
      ));
      assert.ok(envelopes.every(event =>
        event.workspaceid === workspaceId && event.accountid === accountId
      ));
      await client.xAdd(streams.commands, "*", {
        payload: JSON.stringify({ ...command, accountId: randomUUID() }),
      });
      await transport.consumeOnce();
      assert.equal((await client.xPending(streams.commands, "gateway")).pending, 0);
      assert.equal(socket.sent.length, 1);
    }
    finally
    {
      await transport.close();
      await gateway.close();
      if (client.isOpen) await client.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

class IntakeCheckpointFailure extends SqlRedisStreamStore
{
  failOnce = true;
  override async intake(...arguments_: Parameters<SqlRedisStreamStore["intake"]>)
  {
    const receipt = await super.intake(...arguments_);
    if (this.failOnce)
    {
      this.failOnce = false;
      throw new Error("Injected failure before Redis ACK");
    }
    return receipt;
  }
}
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} pending Redis intake reclaims after restart without another SQL command or native effect`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-ack-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "ack.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const store = storage.workspace(workspaceId);
    const account = await store.createAccount();
    const accountId = account.accountId;
    const prefix = `test:${randomUUID()}`;
    const streams = gatewayStreamNames(prefix, { workspaceId, accountId });
    const principal = new GatewayPrincipal("fixture", [{ workspaceId, accountIds: [accountId] }]);
    const source = new IntakeCheckpointFailure(store);
    let transport = new GatewayRedisTransport(source, {
      enabled: true,
      url: redisUrl,
      prefix,
      reclaimIdleMs: 1,
    }, [{ accountId, principal }]);
    const client = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    client.on("error", () => undefined);
    const socket = new ControlledConnection();
    const gateway = new Gateway(store, () => socket, {
      minimumDelayMs: 0,
      maximumDelayMs: 0,
      typingDelayMs: 0,
    });
    try
    {
      await client.connect();
      await transport.start();
      const command = {
        apiVersion: "1",
        workspaceId,
        accountId,
        requestId: randomUUID(),
        type: "send",
        message: {
          channel: "WHATSAPP",
          contentKind: "TEXT",
          senderAddress: "100@s.whatsapp.net",
          recipientAddress: "200@s.whatsapp.net",
          idempotencyKey: "ack-effect",
          text: "one effect",
        },
      };
      const id = await client.xAdd(streams.commands, "*", { payload: JSON.stringify(command) });
      await assert.rejects(transport.consumeOnce(), /before Redis ACK/);
      assert.equal((await client.xPending(streams.commands, "gateway")).pending, 1);
      assert.equal((await source.receipt(accountId, streams.commands, id)).status, "QUEUED");
      await transport.close();
      transport = new GatewayRedisTransport(new SqlRedisStreamStore(store), {
        enabled: true,
        url: redisUrl,
        prefix,
        reclaimIdleMs: 1,
      }, [{ accountId, principal }]);
      await transport.start();
      await transport.consumeOnce();
      assert.equal((await client.xPending(streams.commands, "gateway")).pending, 0);
      await store.transaction(async transaction =>
        assert.equal(
          (await transaction.selectFrom("command").selectAll().where("workspace_id", "=", workspaceId).where(
            "account_id",
            "=",
            accountId,
          ).execute()).length,
          1,
        )
      );
      await gateway.start(accountId);
      const worker = new GatewayCommandWorker(new SqlCommandInbox(store), gateway);
      await worker.runOne(await gateway.ownership(accountId));
      assert.equal(socket.sent.length, 1);
      const forged = await client.xAdd(streams.commands, "*", {
        payload: JSON.stringify({ ...command, accountId: randomUUID() }),
      });
      await transport.consumeOnce();
      assert.equal((await source.receipt(accountId, streams.commands, forged)).failure, "UNAUTHORIZED_SCOPE");
      const conflict = await client.xAdd(streams.commands, "*", {
        payload: JSON.stringify({ ...command, message: { ...command.message, text: "changed" } }),
      });
      await transport.consumeOnce();
      assert.equal((await source.receipt(accountId, streams.commands, conflict)).failure, "CONFLICT");
      assert.equal((await client.xPending(streams.commands, "gateway")).pending, 0);
      assert.equal(socket.sent.length, 1);
    }
    finally
    {
      await transport.close();
      await gateway.close();
      if (client.isOpen) await client.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Redis ACL credentials restrict account streams and forged payload scope is durably rejected", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-acl-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    filename: join(directory, "acl.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  const store = storage.workspace(workspaceId);
  const first = await store.createAccount();
  const second = await store.createAccount();
  const accountId = first.accountId;
  const prefix = `test:${randomUUID()}`;
  const streams = gatewayStreamNames(prefix, { workspaceId, accountId });
  const foreign = gatewayStreamNames(prefix, { workspaceId, accountId: second.accountId });
  const admin = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
  admin.on("error", () => undefined);
  const producerName = `producer-${randomUUID()}`;
  const runtimeName = `runtime-${randomUUID()}`;
  const password = randomUUID();
  let producer: ReturnType<typeof createClient> | undefined;
  let transport: GatewayRedisTransport | undefined;
  try
  {
    await admin.connect();
    await admin.sendCommand([
      "ACL",
      "SETUSER",
      producerName,
      "on",
      `>${password}`,
      "-@all",
      "+hello",
      "+ping",
      "+client|setinfo",
      "+xadd",
      `~${streams.commands}`,
    ]);
    await admin.sendCommand([
      "ACL",
      "SETUSER",
      runtimeName,
      "on",
      `>${password}`,
      "-@all",
      "+hello",
      "+ping",
      "+client|setinfo",
      "+info",
      "+xgroup|create",
      "+xautoclaim",
      "+xreadgroup",
      "+xack",
      "+xadd",
      "+waitaof",
      "+xtrim",
      "+time",
      `~${prefix}:${workspaceId}:${accountId}:*`,
    ]);
    const producerUrl = new URL(redisUrl);
    producerUrl.username = producerName;
    producerUrl.password = password;
    const runtimeUrl = new URL(redisUrl);
    runtimeUrl.username = runtimeName;
    runtimeUrl.password = password;
    producer = createClient({ url: producerUrl.toString(), socket: { reconnectStrategy: false } });
    producer.on("error", () => undefined);
    await producer.connect();
    const principal = new GatewayPrincipal("account-specific-producer", [{
      workspaceId,
      accountIds: [accountId],
    }]);
    const source = new SqlRedisStreamStore(store);
    transport = new GatewayRedisTransport(source, { enabled: true, url: runtimeUrl.toString(), prefix }, [{
      accountId,
      principal,
    }]);
    await transport.start();
    await assert.rejects(producer.xAdd(foreign.commands, "*", { payload: "forbidden" }), /NOPERM/);
    const command = {
      apiVersion: "1",
      workspaceId,
      accountId: second.accountId,
      requestId: randomUUID(),
      type: "presence",
      chatAddress: "200@s.whatsapp.net",
      composing: false,
    };
    const id = await producer.xAdd(streams.commands, "*", { payload: JSON.stringify(command) });
    await transport.consumeOnce();
    const receipt = await source.receipt(accountId, streams.commands, id);
    assert.equal(receipt.failure, "UNAUTHORIZED_SCOPE");
    assert.equal(receipt.accountId, accountId);
    assert.equal(receipt.command, null);
    assert.equal((await admin.xPending(streams.commands, "gateway")).pending, 0);
    for (let index = 0; index < 20 && await transport.publishOnce(); index++)
    {
      /* Publish the bounded rejection. */
    }
    const results = await admin.xRange(streams.results, "-", "+");
    assert.ok(results?.length);
    await assert.rejects(producer.xRange(streams.results, "-", "+"), /NOPERM/);
    await admin.sendCommand(["CLIENT", "KILL", "USER", runtimeName, "SKIPME", "YES"]);
    const valid = { ...command, accountId, requestId: randomUUID() };
    const validId = await producer.xAdd(streams.commands, "*", { payload: JSON.stringify(valid) });
    for (let attempt = 0; attempt < 3; attempt++)
    {
      try
      {
        await transport.consumeOnce();
        break;
      }
      catch (error)
      {
        if (attempt === 2) throw error;
      }
    }
    assert.equal((await source.receipt(accountId, streams.commands, validId)).status, "QUEUED");
  }
  finally
  {
    await transport?.close();
    if (producer?.isOpen) await producer.close();
    if (admin.isOpen)
    {
      await admin.sendCommand(["ACL", "DELUSER", producerName, runtimeName]);
      await admin.close();
    }
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class PublicationCheckpointFailure extends SqlRedisStreamStore
{
  override async published(): Promise<boolean>
  {
    throw new Error("Injected failure after Redis fsync");
  }
}
test("Redis publication retries a committed event ID after local AOF acknowledgement and failed SQL cursor", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-publish-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    filename: join(directory, "publication.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  const store = storage.workspace(workspaceId);
  const account = await store.createAccount();
  const accountId = account.accountId;
  const prefix = `test:${randomUUID()}`;
  const streams = gatewayStreamNames(prefix, { workspaceId, accountId });
  const principal = new GatewayPrincipal("fixture", [{ workspaceId, accountIds: "*" }]);
  let transport = new GatewayRedisTransport(new PublicationCheckpointFailure(store), {
    enabled: true,
    url: redisUrl,
    prefix,
  }, [{ accountId, principal }]);
  const client = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
  client.on("error", () => undefined);
  const lease = await store.acquire(accountId);
  try
  {
    await client.connect();
    await transport.start();
    await store.setState(lease, "CONNECTED", "100@s.whatsapp.net");
    await assert.rejects(async () =>
    {
      for (let index = 0; index < 10 && await transport.publishOnce(); index++)
      {
      }
    }, /after Redis fsync/);
    const first = await client.xRange(streams.events, "-", "+");
    assert.ok(first?.length === 1);
    await transport.close();
    transport = new GatewayRedisTransport(new SqlRedisStreamStore(store), {
      enabled: true,
      url: redisUrl,
      prefix,
    }, [{ accountId, principal }]);
    await transport.start();
    for (let index = 0; index < 20 && await transport.publishOnce(); index++)
    {
    }
    const replay = await client.xRange(streams.events, "-", "+");
    assert.ok(replay?.length === 2);
    assert.deepEqual(JSON.parse(replay[0]!.message["payload"]!), JSON.parse(replay[1]!.message["payload"]!));
    assert.equal(await transport.publishOnce(), false);
  }
  finally
  {
    await transport.close();
    await lease.release();
    if (client.isOpen) await client.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Redis ACKED retention preserves pending and unread command bodies", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-retention-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    filename: join(directory, "retention.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  const store = storage.workspace(workspaceId);
  const account = await store.createAccount();
  const accountId = account.accountId;
  const prefix = `test:${randomUUID()}`;
  const streams = gatewayStreamNames(prefix, { workspaceId, accountId });
  const principal = new GatewayPrincipal("fixture", [{ workspaceId, accountIds: "*" }]);
  const transport = new GatewayRedisTransport(new SqlRedisStreamStore(store), {
    enabled: true,
    url: redisUrl,
    prefix,
  }, [{ accountId, principal }]);
  const client = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
  client.on("error", () => undefined);
  try
  {
    await client.connect();
    await transport.start();
    for (const id of ["1-0", "2-0", "3-0"])
    {
      await client.xAdd(streams.commands, id, { payload: "retained fixture body" });
    }
    const received = await client.xReadGroup("gateway", "paused-consumer", [{
      key: streams.commands,
      id: ">",
    }], { COUNT: 1 });
    assert.equal(received?.[0]?.messages[0]?.id, "1-0");
    await transport.trimOnce(1);
    assert.deepEqual((await client.xRange(streams.commands, "-", "+"))?.map(message => message.id), [
      "1-0",
      "2-0",
      "3-0",
    ]);
    await client.xAck(streams.commands, "gateway", "1-0");
    await transport.trimOnce(1);
    assert.deepEqual((await client.xRange(streams.commands, "-", "+"))?.map(message => message.id), [
      "2-0",
      "3-0",
    ]);
    assert.equal((await client.xPending(streams.commands, "gateway")).pending, 0);
  }
  finally
  {
    await transport.close();
    if (client.isOpen) await client.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Redis startup rejects missing persistence and eviction; disabled transport needs no connection", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-capability-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    filename: join(directory, "capability.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  const store = storage.workspace(workspaceId);
  const source = new SqlRedisStreamStore(store);
  const disabled = new GatewayRedisTransport(source, { enabled: false }, []);
  const admin = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
  admin.on("error", () => undefined);
  const first = new GatewayRedisTransport(source, { enabled: true, url: redisUrl }, []);
  const second = new GatewayRedisTransport(source, { enabled: true, url: redisUrl }, []);
  try
  {
    await disabled.start();
    assert.equal(await disabled.consumeOnce(), 0);
    assert.equal(await disabled.publishOnce(), false);
    await admin.connect();
    await admin.sendCommand(["CONFIG", "SET", "appendonly", "no"]);
    await assert.rejects(first.start(), /AOF persistence/);
    await admin.sendCommand(["CONFIG", "SET", "appendonly", "yes"]);
    await admin.sendCommand(["CONFIG", "SET", "maxmemory-policy", "allkeys-lru"]);
    await assert.rejects(second.start(), /noeviction/);
  }
  finally
  {
    if (admin.isOpen)
    {
      await admin.sendCommand(["CONFIG", "SET", "appendonly", "yes"]);
      await admin.sendCommand(["CONFIG", "SET", "maxmemory-policy", "noeviction"]);
      await admin.close();
    }
    await disabled.close();
    await first.close();
    await second.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated AsyncAPI validates actual owning command and CloudEvent schemas", async () =>
{
  const parser = new Parser();
  const parsed = await parser.parse(JSON.stringify(createGatewayAsyncApi()));
  assert.ok(parsed.document, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics.filter(diagnostic => diagnostic.severity === 0), []);
  assert.equal(parsed.document.version(), "3.0.0");
});
