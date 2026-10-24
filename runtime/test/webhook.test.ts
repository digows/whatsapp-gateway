import {
  GatewayCloudEventSchema,
  signGatewayWebhook,
  verifyGatewayWebhook,
} from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { SqlGatewayEventLog } from "../src/infrastructure/sql/event-log.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { SqlWebhookOutbox } from "../src/infrastructure/sql/webhook-outbox.ts";
import { GatewayWebhookDispatcher } from "../src/infrastructure/webhook/dispatcher.ts";
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!temporaryRoot || !postgresUrl) throw new Error("Explicit isolated fixtures required");
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} webhook outbox signs scoped events and deletes success work without replaying history`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-webhook-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "webhooks.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const store = storage.workspace(workspaceId);
    const account = await store.createAccount();
    const accountId = account.accountId;
    const secret = randomBytes(32).toString("hex");
    const received: string[] = [];
    const server = createServer((request, response) =>
    {
      void (async () =>
      {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const signature = {
          eventId: String(request.headers["x-gateway-event-id"]),
          timestamp: String(request.headers["x-gateway-timestamp"]),
          signature: String(request.headers["x-gateway-signature"]),
        };
        assert.equal(await verifyGatewayWebhook(secret, signature, body), true);
        assert.equal(await verifyGatewayWebhook(secret, signature, Buffer.from("altered")), false);
        const event = GatewayCloudEventSchema.parse(JSON.parse(body.toString()));
        assert.equal(event.accountid, accountId);
        assert.equal(event.workspaceid, workspaceId);
        assert.equal(signature.eventId, event.id);
        received.push(event.id);
        response.writeHead(204);
        response.end();
      })().catch(error =>
      {
        response.writeHead(500);
        response.end(String(error));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const outbox = new SqlWebhookOutbox(store);
    const destinationId = randomUUID();
    const dispatcher = new GatewayWebhookDispatcher(outbox, { enabled: true });
    const lease = await store.acquire(accountId);
    try
    {
      await outbox.configure({
        workspaceId,
        accountId,
        id: destinationId,
        url: `http://127.0.0.1:${address.port}/events`,
        secret,
        enabled: true,
      });
      // Configuration does not backfill old account-created events.
      assert.equal(await dispatcher.runOnce(), false);
      await store.setState(lease, "CONNECTED", "100@s.whatsapp.net");
      const otherWorkspace = new SqlWebhookOutbox(storage.workspace(randomUUID()));
      assert.deepEqual(await otherWorkspace.destinations(), []);
      assert.deepEqual(await otherWorkspace.deliveries(accountId, destinationId), []);
      await assert.rejects(
        otherWorkspace.claim({
          workspaceId,
          accountId,
          id: destinationId,
          url: `http://127.0.0.1:${address.port}/events`,
          secret,
          enabled: true,
        }),
        /scope mismatch/,
      );
      assert.equal(await dispatcher.runOnce(), true);
      assert.equal(received.length, 1);
      assert.equal(await dispatcher.runOnce(), false);
      assert.deepEqual(await outbox.deliveries(accountId, destinationId), []);
      const history = await new SqlGatewayEventLog(store).after(accountId, 0, 100);
      assert.ok(history.some(event => event.id === received[0]));
      assert.equal((await store.account(accountId)).state, "CONNECTED");
    }
    finally
    {
      await dispatcher.close();
      await lease.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

class FailingWebhookCompletion extends SqlWebhookOutbox
{
  override async complete(): Promise<boolean>
  {
    throw new Error("Injected failure after receiver acceptance");
  }
}
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} restart reclaims accepted-but-uncommitted delivery with identical bytes and event ID`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-webhook-restart-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "restart.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    let storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const accountId = randomUUID();
    const destinationId = randomUUID();
    const bodies: Buffer[] = [];
    const server = createServer((request, response) =>
    {
      void (async () =>
      {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(Buffer.concat(chunks));
        response.writeHead(204);
        response.end();
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const store = storage.workspace(workspaceId);
    const outbox = new FailingWebhookCompletion(store);
    let dispatcher = new GatewayWebhookDispatcher(outbox, { enabled: true });
    await store.createAccount(accountId);
    const lease = await store.acquire(accountId);
    try
    {
      await outbox.configure({
        workspaceId,
        accountId,
        id: destinationId,
        url: `http://127.0.0.1:${address.port}/events`,
        secret: randomBytes(32).toString("hex"),
        enabled: true,
      });
      await store.setState(lease, "CONNECTED", "100@s.whatsapp.net");
      await assert.rejects(dispatcher.runOnce(), /after receiver acceptance/);
      assert.equal(bodies.length, 1);
      assert.equal((await outbox.deliveries(accountId, destinationId))[0]?.state, "DELIVERING");
      await dispatcher.close();
      await lease.release();
      await store.transaction(async transaction =>
      {
        await transaction.updateTable("webhook_delivery").set({
          lease_until: new Date(0).toISOString(),
          next_attempt_at: new Date(0).toISOString(),
        }).where("workspace_id", "=", workspaceId).where("account_id", "=", accountId).where(
          "destination_id",
          "=",
          destinationId,
        ).execute();
      });
      await storage.close();
      storage = await openGatewayStorage(configuration);
      const recovered = new SqlWebhookOutbox(storage.workspace(workspaceId));
      dispatcher = new GatewayWebhookDispatcher(recovered, { enabled: true });
      assert.equal(await dispatcher.runOnce(), true);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0], bodies[1]);
      assert.equal(await dispatcher.runOnce(), false);
      assert.deepEqual(await recovered.deliveries(accountId, destinationId), []);
      assert.equal((await storage.workspace(workspaceId).account(accountId)).state, "CONNECTED");
    }
    finally
    {
      await dispatcher.close();
      await lease.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} outbox claims are exclusive, stale completion is rejected and expiry differs from terminal retention`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-webhook-policy-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "policy.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const store = storage.workspace(workspaceId);
    const account = await store.createAccount();
    const accountId = account.accountId;
    const destination = {
      workspaceId,
      accountId,
      id: randomUUID(),
      url: "http://127.0.0.1:1/not-contacted",
      secret: randomBytes(32).toString("hex"),
      enabled: true,
    };
    const outbox = new SqlWebhookOutbox(store, {
      maximumAttempts: 2,
      minimumRetryDelayMs: 1,
      maximumRetryDelayMs: 1,
      terminalRetentionMs: 10000,
    });
    const lease = await store.acquire(accountId);
    try
    {
      await outbox.configure(destination);
      await store.setState(lease, "CONNECTED", "100@s.whatsapp.net");
      const claims = await Promise.all([outbox.claim(destination), outbox.claim(destination)]);
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find(value => value !== null);
      assert.ok(first);
      await store.transaction(async transaction =>
      {
        await transaction.updateTable("webhook_delivery").set({
          lease_until: new Date(0).toISOString(),
          next_attempt_at: new Date(0).toISOString(),
        }).where("workspace_id", "=", workspaceId).where("account_id", "=", accountId).where(
          "event_id",
          "=",
          first.event.id,
        ).execute();
      });
      const reclaimed = await outbox.claim(destination);
      assert.ok(reclaimed);
      assert.equal(reclaimed.attempt, 2);
      assert.equal(await outbox.complete(first, 204, null), false);
      assert.equal(await outbox.complete(reclaimed, 500, "HTTP_ERROR"), true);
      assert.equal((await outbox.deliveries(accountId, destination.id))[0]?.state, "EXHAUSTED");
      await outbox.cleanup();
      assert.equal((await outbox.deliveries(accountId, destination.id)).length, 1);
      await store.setState(lease, "STOPPED");
      await store.transaction(async transaction =>
      {
        await transaction.updateTable("webhook_delivery").set({ expires_at: new Date(0).toISOString() })
          .where("workspace_id", "=", workspaceId).where("account_id", "=", accountId).where(
            "state",
            "=",
            "PENDING",
          ).execute();
      });
      await outbox.cleanup();
      assert.deepEqual((await outbox.deliveries(accountId, destination.id)).map(row => row.state), [
        "EXHAUSTED",
        "EXPIRED",
      ]);
      await store.transaction(async transaction =>
      {
        await transaction.updateTable("webhook_delivery").set({ terminal_at: new Date(0).toISOString() })
          .where("workspace_id", "=", workspaceId).where("account_id", "=", accountId).execute();
      });
      await outbox.cleanup();
      assert.deepEqual(await outbox.deliveries(accountId, destination.id), []);
      assert.ok((await new SqlGatewayEventLog(store).after(accountId, 0, 100)).length >= 4);
    }
    finally
    {
      await lease.release();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} accepted timeout, server errors and redirects retry identical signed bytes`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-webhook-http-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "http.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const store = storage.workspace(workspaceId);
    const account = await store.createAccount();
    const accountId = account.accountId;
    const bodies: Buffer[] = [];
    const secret = randomBytes(32).toString("hex");
    let redirected = 0;
    const server = createServer((request, response) =>
    {
      if (request.url === "/unconfigured")
      {
        redirected++;
        response.writeHead(204);
        response.end();
        return;
      }
      void (async () =>
      {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const headers = {
          eventId: String(request.headers["x-gateway-event-id"]),
          timestamp: String(request.headers["x-gateway-timestamp"]),
          signature: String(request.headers["x-gateway-signature"]),
        };
        assert.equal(await verifyGatewayWebhook(secret, headers, body), true);
        bodies.push(body);
        if (bodies.length === 1) return;
        if (bodies.length === 2) response.writeHead(500);
        else if (bodies.length === 3) response.writeHead(302, { location: "/unconfigured" });
        else response.writeHead(204);
        response.end();
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const destinationId = randomUUID();
    const outbox = new SqlWebhookOutbox(store, {
      timeoutMs: 250,
      maximumAttempts: 4,
      minimumRetryDelayMs: 1,
      maximumRetryDelayMs: 1,
    });
    const dispatcher = new GatewayWebhookDispatcher(outbox, { enabled: true });
    const lease = await store.acquire(accountId);
    try
    {
      await outbox.configure({
        workspaceId,
        accountId,
        id: destinationId,
        url: `http://127.0.0.1:${address.port}/events`,
        secret,
        enabled: true,
      });
      await store.setState(lease, "CONNECTED", "100@s.whatsapp.net");
      for (let attempt = 1; attempt <= 4; attempt++)
      {
        assert.equal(await dispatcher.runOnce(), true);
        assert.equal(bodies.length, attempt);
        if (attempt < 4)
        {
          const observation = (await outbox.deliveries(accountId, destinationId))[0];
          assert.ok(observation);
          assert.equal(observation.state, "PENDING");
          assert.equal(observation.failure, attempt === 1 ? "TIMEOUT" : "HTTP_ERROR");
          assert.equal(observation.lastStatus, attempt === 1 ? null : attempt === 2 ? 500 : 302);
          await store.transaction(async transaction =>
          {
            await transaction.updateTable("webhook_delivery").set({
              next_attempt_at: new Date(0).toISOString(),
            }).where("workspace_id", "=", workspaceId).where("account_id", "=", accountId).where(
              "destination_id",
              "=",
              destinationId,
            ).execute();
          });
        }
      }
      assert.ok(bodies.every(body => body.equals(bodies[0]!)));
      assert.equal(redirected, 0);
      assert.deepEqual(await outbox.deliveries(accountId, destinationId), []);
    }
    finally
    {
      await dispatcher.close();
      await lease.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("webhook signatures bind identity, timestamp and raw bytes with an explicit replay window", async () =>
{
  const secret = randomBytes(32).toString("hex");
  const body = new TextEncoder().encode("{\"event\":\"fixture\"}");
  const eventId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = await signGatewayWebhook(secret, eventId, timestamp, body);
  assert.equal(await verifyGatewayWebhook(secret, signed, body), true);
  assert.equal(await verifyGatewayWebhook(randomBytes(32).toString("hex"), signed, body), false);
  assert.equal(await verifyGatewayWebhook(secret, { ...signed, eventId: randomUUID() }, body), false);
  assert.equal(
    await verifyGatewayWebhook(secret, { ...signed, timestamp: String(Number(timestamp) + 1) }, body),
    false,
  );
  const stale = await signGatewayWebhook(secret, eventId, String(Number(timestamp) - 601), body);
  assert.equal(await verifyGatewayWebhook(secret, stale, body), false);
  assert.equal(await verifyGatewayWebhook(secret, { ...signed, signature: "v0=bad" }, body), false);
});

test("disabled webhook dispatch opens no request and shutdown preserves an accepted active attempt for retry", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-webhook-stop-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    filename: join(directory, "stop.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  const store = storage.workspace(workspaceId);
  const account = await store.createAccount();
  const accountId = account.accountId;
  let requests = 0;
  const server = createServer((request, response) =>
  {
    void (async () =>
    {
      for await (const _chunk of request)
      {
        /* Consume the accepted request before withholding acknowledgement. */
      }
      requests++;
      server.emit("fixture-accepted");
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const destinationId = randomUUID();
  const outbox = new SqlWebhookOutbox(store);
  const disabled = new GatewayWebhookDispatcher(outbox, { enabled: false });
  const dispatcher = new GatewayWebhookDispatcher(outbox, { enabled: true });
  const lease = await store.acquire(accountId);
  try
  {
    await outbox.configure({
      workspaceId,
      accountId,
      id: destinationId,
      url: `http://127.0.0.1:${address.port}/events`,
      secret: randomBytes(32).toString("hex"),
      enabled: true,
    });
    await store.setState(lease, "CONNECTED", "100@s.whatsapp.net");
    assert.equal(await disabled.runOnce(), false);
    assert.equal(requests, 0);
    const accepted = once(server, "fixture-accepted", { signal: AbortSignal.timeout(3000) });
    const running = dispatcher.runOnce();
    await accepted;
    await dispatcher.close();
    assert.equal(await running, true);
    assert.equal(await dispatcher.runOnce(), false);
    const delivery = (await outbox.deliveries(accountId, destinationId))[0];
    assert.equal(delivery?.state, "PENDING");
    assert.equal(delivery?.failure, "STOPPED");
    assert.equal(delivery?.attempts, 1);
    assert.equal(requests, 1);
  }
  finally
  {
    await disabled.close();
    await dispatcher.close();
    await lease.release();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
