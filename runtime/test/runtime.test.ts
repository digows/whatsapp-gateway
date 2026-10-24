import { GatewayQueryCloudEventSchema, gatewayStreamNames } from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createClient } from "redis";
import { componentLogger } from "../src/application/configuration/logging.ts";
import { GatewayRuntimeConfigurationSchema } from "../src/application/configuration/runtime-configuration.ts";
import {
  gatewayWorkspaceStorageConfiguration,
  migrateGatewayRuntimeStorage,
} from "../src/application/configuration/storage-configuration.ts";
import { GatewayRuntime } from "../src/application/runtime.ts";
import { BaileysProtocolLogger } from "../src/infrastructure/baileys/protocol-logger.ts";
import { SqlCommandInbox } from "../src/infrastructure/sql/command-inbox.ts";
import { SqlFleetStore } from "../src/infrastructure/sql/fleet-store.ts";
import { openGatewayStorage, type StorageConfiguration } from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
const redisUrl = process.env["GATEWAY_TEST_REDIS_URL"];
if (!temporaryRoot || !postgresUrl || !redisUrl) throw new Error("Explicit owned fixtures required");
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
interface ProcessObservation
{
  readonly process: ChildProcess;
  readonly ready: Promise<string>;
  readonly exited: Promise<number | null>;
  output(): string;
}
function runRuntime(filename: string): ProcessObservation
{
  const child = spawn(process.execPath, [cli, "serve", "--config", filename], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let output = "";
  const exited = new Promise<number | null>((resolve, reject) =>
  {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  const ready = new Promise<string>((resolve, reject) =>
  {
    const timer = setTimeout(() => reject(new Error("Runtime did not become ready")), 15000);
    const observe = (chunk: Buffer): void =>
    {
      output += chunk.toString();
      for (const line of output.split("\n"))
      {
        try
        {
          const event: unknown = JSON.parse(line);
          if (
            typeof event === "object" && event !== null && "event" in event && event.event === "runtime_ready"
            && "httpOrigin" in event && typeof event.httpOrigin === "string"
          )
          {
            clearTimeout(timer);
            resolve(event.httpOrigin);
          }
        }
        catch
        {
          /* The final buffered line may be incomplete. */
        }
      }
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    void exited.then(() =>
    {
      clearTimeout(timer);
      reject(new Error("Runtime exited before readiness"));
    }, reject);
  });
  return { process: child, ready, exited, output: () => output };
}
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} compiled standalone CLI verifies readiness, durable offline intake and graceful SIGTERM`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-runtime-"));
    const workspaceId = randomUUID();
    const runtimeStorage = engine === "sqlite"
      ? { engine, mode: "local", directory }
      : { engine, mode: "cluster", url: postgresUrl };
    const storageConfiguration = gatewayWorkspaceStorageConfiguration(runtimeStorage, workspaceId);
    await migrateGatewayRuntimeStorage(runtimeStorage, [workspaceId]);
    const accountId = randomUUID();
    const token = randomUUID();
    const configuration = {
      storage: runtimeStorage,
      workspaces: [{ workspaceId, accounts: [{ accountId, enabled: false }] }],
      http: { enabled: true, port: 0 },
      principals: [{ id: "operator", httpToken: token, grants: [{ workspaceId, accountIds: [accountId] }] }],
    };
    const filename = join(directory, "operator.json");
    await writeFile(filename, JSON.stringify(configuration), { mode: 0o600 });
    let observation: ProcessObservation | undefined;
    try
    {
      observation = runRuntime(filename);
      const origin = await observation.ready;
      assert.equal((await fetch(origin + "/health/live")).status, 200);
      assert.equal((await fetch(origin + "/health/ready")).status, 200);
      const command = {
        apiVersion: "1",
        workspaceId,
        accountId,
        requestId: randomUUID(),
        type: "presence",
        chatAddress: "200@s.whatsapp.net",
        composing: true,
      };
      const receipt = await fetch(origin + "/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      assert.equal(receipt.status, 202);
      observation.process.kill("SIGTERM");
      assert.equal(await observation.exited, 0);
      assert.ok(observation.output().includes("\"event\":\"runtime_stopped\""));
      assert.ok(!observation.output().includes("socket_starting"));
      assert.ok(!observation.output().includes(token));
      await assert.rejects(fetch(origin + "/health/live"));
      const reopened = await openGatewayStorage(storageConfiguration);
      try
      {
        assert.equal(
          (await new SqlCommandInbox(reopened.workspace(workspaceId)).result(accountId, command.requestId))
            .state,
          "PENDING",
        );
      }
      finally
      {
        await reopened.close();
      }
      assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), configuration);
    }
    finally
    {
      if (observation && observation.process.exitCode === null)
      {
        observation.process.kill("SIGTERM");
        await observation.exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
test("Redis-only runtime opens no HTTP listener and schedules owner-independent queries", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-runtime-"));
  const workspaceId = randomUUID();
  const accountId = randomUUID();
  const prefix = `test:${randomUUID()}`;
  const configuration = {
    storage: { engine: "sqlite", mode: "local", directory },
    workspaces: [{ workspaceId, accounts: [{ accountId, enabled: false }] }],
    http: { enabled: false },
    principals: [{ id: "redis-operator", grants: [{ workspaceId, accountIds: [accountId] }] }],
    redis: {
      transport: { enabled: true, url: redisUrl, prefix },
      bindings: [{ workspaceId, accountId, principalId: "redis-operator" }],
    },
  };
  await migrateGatewayRuntimeStorage(
    configuration.storage,
    configuration.workspaces.map(value => value.workspaceId),
  );
  const runtime = new GatewayRuntime(configuration);
  const client = createClient({ url: redisUrl });
  client.on("error", () => undefined);
  try
  {
    await runtime.start();
    assert.equal(runtime.origin, null);
    assert.equal(runtime.ready, true);
    await client.connect();
    const streams = gatewayStreamNames(prefix, { workspaceId, accountId });
    const requestId = randomUUID();
    await client.xAdd(streams.commands, "*", {
      payload: JSON.stringify({ apiVersion: "1", workspaceId, accountId, requestId, type: "account.get" }),
    });
    let response: unknown;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline)
    {
      const records = await client.xRange(streams.results, "-", "+");
      const record = records?.[0];
      if (record)
      {
        response = JSON.parse(record.message["payload"]!);
        break;
      }
      await delay(10);
    }
    const event = GatewayQueryCloudEventSchema.parse(response);
    assert.equal(event.data.requestId, requestId);
    assert.equal(event.data.response?.type, "account.get");
    await runtime.close();
    assert.equal(runtime.ready, false);
  }
  finally
  {
    await runtime.close();
    if (client.isOpen) await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("component levels preserve protocol diagnostics without serializing private objects or arbitrary strings", () =>
{
  const records: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback)
    {
      records.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: "warn" }, destination);
  const component = componentLogger(logger, { level: "warn", components: { baileys: "trace" } }, "baileys");
  const native = new BaileysProtocolLogger(component);
  native.trace({ qr: "PRIVATE_QR", auth: "PRIVATE_AUTH", message: "PRIVATE_TEXT" }, "PRIVATE_TEXT");
  native.info({ private: "PRIVATE_AUTH" }, "connected to WA");
  logger.info({ event: "must_be_filtered" });
  const output = records.join("");
  assert.ok(!output.includes("PRIVATE_"));
  assert.ok(!output.includes("must_be_filtered"));
  assert.ok(output.includes("unclassified") && output.includes("connected to WA"));
  assert.equal(records.length, 2);
  new BaileysProtocolLogger(component, () => true).error(
    { err: new Error("PRIVATE_STOP") },
    "connection errored",
  );
  const intentional: unknown = JSON.parse(records.at(-1)!);
  assert.ok(
    typeof intentional === "object" && intentional !== null && "level" in intentional
      && intentional.level === 20 && "event" in intentional
      && intentional.event === "socket_closed_intentionally",
  );
  assert.ok(!records.join("").includes("PRIVATE_STOP"));
});
test("operator configuration rejects unauthorized bindings and incompatible storage before startup", () =>
{
  const workspaceId = randomUUID();
  const accountId = randomUUID();
  const base = {
    storage: { engine: "sqlite", mode: "local", directory: "example-workspaces" },
    workspaces: [{ workspaceId }],
    http: { enabled: false },
  };
  assert.throws(() =>
    GatewayRuntimeConfigurationSchema.parse({ ...base, storage: { ...base.storage, mode: "cluster" } })
  );
  assert.throws(() =>
    GatewayRuntimeConfigurationSchema.parse({
      ...base,
      redis: { bindings: [{ workspaceId, accountId, principalId: "missing" }] },
    })
  );
  assert.throws(() => GatewayRuntimeConfigurationSchema.parse({ ...base, http: { enabled: true } }));
});

test("runtime drain stops account placement while an accepted HTTP body is still pending", async () =>
{
  const workspaceId = randomUUID();
  const accountId = randomUUID();
  const token = randomUUID();
  const storageConfiguration: StorageConfiguration = {
    engine: "postgresql",
    mode: "cluster",
    url: postgresUrl,
  };
  const producer = await openGatewayStorage(storageConfiguration);
  let connections = 0;
  const runtime = new GatewayRuntime({
    storage: storageConfiguration,
    workspaces: [{
      workspaceId,
      accounts: [{ accountId, enabled: false }],
      fleet: { reconcileIntervalMs: 20, membershipLifetimeMs: 300 },
    }],
    http: { enabled: true, port: 0, requestTimeoutMs: 300, shutdownTimeoutMs: 500 },
    principals: [{ id: "operator", httpToken: token, grants: [{ workspaceId, accountIds: [accountId] }] }],
  }, () =>
  {
    connections++;
    return new ControlledConnection();
  });
  let pending: ReturnType<typeof request> | undefined;
  try
  {
    await runtime.start();
    assert.ok(runtime.origin);
    pending = request(runtime.origin + "/v1/commands", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": "2",
        expect: "100-continue",
      },
    });
    pending.on("error", () => undefined);
    pending.on("response", response => response.resume());
    pending.flushHeaders();
    await once(pending, "continue");
    pending.write("{");
    const closing = runtime.close();
    const fleet = new SqlFleetStore(producer.workspace(workspaceId));
    await fleet.setDesired({ apiVersion: "1", workspaceId, accountId, expectedRevision: 0, enabled: true });
    await closing;
    assert.equal(connections, 0, "Closing a runtime must stop placement before waiting for HTTP drain");
    assert.equal((await fleet.desired(accountId)).enabled, true);
  }
  finally
  {
    pending?.destroy();
    await runtime.close();
    await producer.close();
  }
});

test("closing during actual SQLite startup cancels readiness and releases local exclusivity", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-start-cancel-"));
  const workspaceId = randomUUID();
  const configuration = {
    storage: { engine: "sqlite", mode: "local", directory },
    workspaces: [{ workspaceId }],
    http: { enabled: false },
  };
  await migrateGatewayRuntimeStorage(
    configuration.storage,
    configuration.workspaces.map(value => value.workspaceId),
  );
  const runtime = new GatewayRuntime(configuration);
  try
  {
    const rejected = assert.rejects(runtime.start(), /cancelled/);
    await runtime.close();
    await rejected;
    assert.equal(runtime.ready, false);
    const reopened = await openGatewayStorage(
      gatewayWorkspaceStorageConfiguration(configuration.storage, workspaceId),
    );
    await reopened.close();
  }
  finally
  {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed HTTP bind closes startup resources and releases the actual SQLite runtime lock", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-bind-failure-"));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const workspaceId = randomUUID();
  const token = randomUUID();
  const configuration = {
    storage: { engine: "sqlite", mode: "local", directory },
    workspaces: [{ workspaceId }],
    http: { enabled: true, port: address.port },
    principals: [{ id: "operator", httpToken: token, grants: [{ workspaceId, accountIds: "*" }] }],
  };
  await migrateGatewayRuntimeStorage(
    configuration.storage,
    configuration.workspaces.map(value => value.workspaceId),
  );
  const runtime = new GatewayRuntime(configuration);
  try
  {
    await assert.rejects(runtime.start(), /EADDRINUSE/);
    assert.equal(runtime.ready, false);
    const reopened = await openGatewayStorage(
      gatewayWorkspaceStorageConfiguration(configuration.storage, workspaceId),
    );
    await reopened.close();
  }
  finally
  {
    await runtime.close();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Redis runtime routes equal account/request IDs through their independently stored workspaces", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-redis-workspaces-"));
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const accountId = randomUUID();
  const requestId = randomUUID();
  const prefix = `test:${randomUUID()}`;
  const configuration = {
    storage: { engine: "sqlite", mode: "local", directory },
    workspaces: [workspaceId, otherWorkspaceId].map(value => ({
      workspaceId: value,
      accounts: [{ accountId, enabled: false }],
    })),
    http: { enabled: false },
    principals: [{
      id: "consumer",
      grants: [workspaceId, otherWorkspaceId].map(value => ({ workspaceId: value, accountIds: [accountId] })),
    }],
    redis: {
      transport: { enabled: true, url: redisUrl, prefix },
      bindings: [workspaceId, otherWorkspaceId].map(value => ({
        workspaceId: value,
        accountId,
        principalId: "consumer",
      })),
    },
  };
  await migrateGatewayRuntimeStorage(configuration.storage, [workspaceId, otherWorkspaceId]);
  const runtime = new GatewayRuntime(configuration);
  const client = createClient({ url: redisUrl });
  client.on("error", () => undefined);
  try
  {
    await runtime.start();
    await client.connect();
    for (const selectedWorkspace of [workspaceId, otherWorkspaceId])
    {
      const streams = gatewayStreamNames(prefix, { workspaceId: selectedWorkspace, accountId });
      await client.xAdd(streams.commands, "*", {
        payload: JSON.stringify({
          apiVersion: "1",
          workspaceId: selectedWorkspace,
          accountId,
          requestId,
          type: "account.get",
        }),
      });
      let observed: unknown;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline)
      {
        const record = (await client.xRange(streams.results, "-", "+"))?.[0];
        if (record)
        {
          observed = JSON.parse(record.message["payload"]!);
          break;
        }
        await delay(10);
      }
      const event = GatewayQueryCloudEventSchema.parse(observed);
      assert.equal(event.workspaceid, selectedWorkspace);
      assert.equal(event.data.requestId, requestId);
      assert.equal(event.data.failure, null);
      const response = event.data.response;
      assert.ok(response?.type === "account.get");
      assert.equal(response.result.workspaceId, selectedWorkspace);
      assert.equal(response.result.accountId, accountId);
    }
  }
  finally
  {
    await runtime.close();
    if (client.isOpen) await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
