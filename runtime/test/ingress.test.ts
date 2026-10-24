import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayCommandIngress, GatewayCommandWorker } from "../src/application/command-ingress.ts";
import { Gateway } from "../src/application/gateway.ts";
import { GatewayPrincipal } from "../src/domain/authorization.ts";
import { SqlCommandInbox } from "../src/infrastructure/sql/command-inbox.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";

const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!temporaryRoot || !postgresUrl) throw new Error("Explicit isolated storage fixtures required");
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} durable ingress authorizes account scope, orders claims and fences recovered commands`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-ingress-"));
    const workspaceId = randomUUID();
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId, filename: join(directory, "inbox.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    let storage = await openGatewayStorage(configuration);
    const accountId = randomUUID();
    const secondAccountId = randomUUID();
    const principal = new GatewayPrincipal("agent", [{ workspaceId, accountIds: [accountId] }]);
    const sockets: ControlledConnection[] = [];
    let gateway: Gateway | undefined;
    const request = {
      apiVersion: "1" as const,
      workspaceId,
      accountId,
      requestId: randomUUID(),
      type: "send" as const,
      message: {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: "200@s.whatsapp.net",
        idempotencyKey: "one-native-effect",
        text: "durable test",
      },
    };
    try
    {
      const store = storage.workspace(workspaceId);
      await store.createAccount(accountId);
      await store.createAccount(secondAccountId);
      const inbox = new SqlCommandInbox(store);
      const ingress = new GatewayCommandIngress(inbox);
      await assert.rejects(
        ingress.submit(principal, { ...request, accountId: secondAccountId }),
        /authorized/,
      );
      await assert.rejects(ingress.submit(principal, { ...request, apiVersion: "2" }), /apiVersion/);
      await assert.rejects(
        ingress.submit(principal, { ...request, workspaceId: randomUUID() }),
        /authorized/,
      );
      const accepted = await ingress.submit(principal, request);
      assert.equal(accepted.state, "PENDING");
      assert.deepEqual(await ingress.submit(principal, request), accepted);
      await assert.rejects(
        ingress.submit(principal, {
          ...request,
          message: { ...request.message, text: "conflicting payload" },
        }),
        /different payload/,
      );
      const queued = await ingress.submit(principal, { ...request, requestId: randomUUID() });
      assert.equal(queued.sequence, accepted.sequence + 1);
      gateway = new Gateway(store, () =>
      {
        const socket = new ControlledConnection();
        sockets.push(socket);
        return socket;
      }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
      await gateway.start(accountId);
      const firstLease = await gateway.ownership(accountId);
      const claims = await Promise.all([inbox.claim(firstLease), inbox.claim(firstLease)]);
      const claim = claims.find(value => value !== null);
      assert.ok(claim);
      assert.equal(claims.filter(value => value !== null).length, 1);
      assert.equal(claim.command.requestId, request.requestId);
      // Simulate native acceptance followed by loss before the ingress completion transaction.
      const result = await gateway.send(accountId, request.message);
      assert.equal(result.state, "ACCEPTED");
      await gateway.close();
      gateway = undefined;
      await storage.close();
      storage = await openGatewayStorage(configuration);
      const recoveredStore = storage.workspace(workspaceId);
      const recoveredInbox = new SqlCommandInbox(recoveredStore);
      gateway = new Gateway(recoveredStore, () =>
      {
        const socket = new ControlledConnection();
        sockets.push(socket);
        return socket;
      }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
      await gateway.start(accountId);
      const lease = await gateway.ownership(accountId);
      await assert.rejects(
        recoveredInbox.complete(firstLease, claim, {
          apiVersion: "1",
          workspaceId,
          accountId,
          requestId: request.requestId,
          type: "send",
          result,
        }),
        /ownership/,
      );
      const worker = new GatewayCommandWorker(recoveredInbox, gateway);
      assert.equal(await worker.runOne(lease), true);
      assert.equal(await worker.runOne(lease), true);
      assert.equal(await worker.runOne(lease), false);
      const recoveredIngress = new GatewayCommandIngress(recoveredInbox);
      const completed = await recoveredIngress.result(principal, {
        workspaceId,
        accountId,
        requestId: request.requestId,
      });
      assert.equal(completed.state, "COMPLETED");
      assert.deepEqual(completed.response, {
        apiVersion: "1",
        workspaceId,
        accountId,
        requestId: request.requestId,
        type: "send",
        result,
      });
      assert.equal(sockets[0]?.sent.length, 1);
      assert.equal(sockets[1]?.sent.length, 0);
      await assert.rejects(
        recoveredIngress.result(principal, {
          workspaceId,
          accountId: secondAccountId,
          requestId: request.requestId,
        }),
        /authorized/,
      );
      const foreignWorkspaceId = randomUUID();
      const foreignConfiguration = configuration.engine === "sqlite"
        ? { ...configuration, workspaceId: foreignWorkspaceId, filename: join(directory, "foreign.sqlite") }
        : configuration;
      if (foreignConfiguration.engine === "sqlite") await migrateGatewayStorage(foreignConfiguration);
      const foreignStorage = await openGatewayStorage(foreignConfiguration);
      try
      {
        const other = new GatewayCommandIngress(
          new SqlCommandInbox(foreignStorage.workspace(foreignWorkspaceId)),
        );
        await assert.rejects(
          other.result(principal, { workspaceId, accountId, requestId: request.requestId }),
          /workspace/,
        );
      }
      finally
      {
        await foreignStorage.close();
      }
      // A completion cannot be rewritten, even by the current generation.
      await assert.rejects(recoveredInbox.fail(lease, claim, "EXECUTION_FAILED"), /claim|completion/);
    }
    finally
    {
      await gateway?.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} ingress recovers UNKNOWN without another native effect and failures do not block the queue`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-inbox-unknown-"));
    const workspaceId = randomUUID();
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId, filename: join(directory, "inbox.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const store = storage.workspace(workspaceId);
    const account = await store.createAccount();
    const accountId = account.accountId;
    const sockets: ControlledConnection[] = [];
    const gateway = new Gateway(store, () =>
    {
      const socket = new ControlledConnection();
      sockets.push(socket);
      return socket;
    }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
    const inbox = new SqlCommandInbox(store);
    const principal = new GatewayPrincipal("fixture", [{ workspaceId, accountIds: "*" }]);
    const ingress = new GatewayCommandIngress(inbox);
    const worker = new GatewayCommandWorker(inbox, gateway);
    const identity = { apiVersion: "1" as const, workspaceId, accountId };
    const command = {
      ...identity,
      requestId: randomUUID(),
      type: "send" as const,
      message: {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: "200@s.whatsapp.net",
        idempotencyKey: "unknown-inbox-effect",
        text: "no resend",
      },
    };
    try
    {
      await ingress.submit(principal, command);
      await gateway.start(accountId);
      const previous = await gateway.ownership(accountId);
      const claimed = await inbox.claim(previous);
      assert.ok(claimed);
      const operation = await store.reserve(previous, command.message, 1);
      operation.dispatch(0);
      await store.save(previous, operation);
      await gateway.restart(accountId);
      const lease = await gateway.ownership(accountId);
      assert.equal(await worker.runOne(lease), true);
      const result = await inbox.result(accountId, command.requestId);
      assert.equal(result.response?.type, "send");
      if (result.response?.type !== "send") throw new Error("Send response required");
      assert.equal(result.response.result.state, "UNKNOWN");
      assert.equal(sockets.reduce((total, socket) => total + socket.sent.length, 0), 0);
      const failed = {
        ...identity,
        requestId: randomUUID(),
        type: "contact.lookup",
        address: "+442079460000",
      };
      const presence = {
        ...identity,
        requestId: randomUUID(),
        type: "presence",
        chatAddress: "200@s.whatsapp.net",
        composing: false,
      };
      await ingress.submit(principal, failed);
      await ingress.submit(principal, presence);
      assert.equal(await worker.runOne(lease), true);
      assert.equal((await inbox.result(accountId, failed.requestId)).failure, "EXECUTION_FAILED");
      assert.equal(await worker.runOne(lease), true);
      assert.equal((await inbox.result(accountId, presence.requestId)).state, "COMPLETED");
      assert.equal(await worker.runOne(lease), false);
      await assert.rejects(
        inbox.complete(lease, claimed, {
          ...identity,
          requestId: command.requestId,
          type: "send",
          result: { ...result.response.result, accountId: randomUUID() },
        }),
        /scope mismatch/,
      );
      await assert.rejects(inbox.claim(previous), /ownership/);
    }
    finally
    {
      await gateway.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("PostgreSQL independent producers route concurrent durable requests to the exclusive remote owner", async () =>
{
  const configuration: StorageConfiguration = { engine: "postgresql", url: postgresUrl, mode: "cluster" };
  const producer = await openGatewayStorage(configuration);
  const owner = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  const accountId = randomUUID();
  const producerStore = producer.workspace(workspaceId);
  const ownerStore = owner.workspace(workspaceId);
  const socket = new ControlledConnection();
  const gateway = new Gateway(ownerStore, () => socket, {
    minimumDelayMs: 0,
    maximumDelayMs: 0,
    typingDelayMs: 0,
  });
  try
  {
    await producerStore.createAccount(accountId);
    const principal = new GatewayPrincipal("producer", [{ workspaceId, accountIds: [accountId] }]);
    const ingress = new GatewayCommandIngress(new SqlCommandInbox(producerStore));
    const competingIngress = new GatewayCommandIngress(new SqlCommandInbox(ownerStore));
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
        idempotencyKey: "shared-producers",
        text: "one effect",
      },
    };
    const receipts = await Promise.all(
      Array.from(
        { length: 12 },
        (_, index) => (index % 2 === 0 ? ingress : competingIngress).submit(principal, command),
      ),
    );
    assert.ok(receipts.every(receipt => receipt.sequence === 1));
    await gateway.start(accountId);
    await assert.rejects(producerStore.acquire(accountId), /owned/);
    const worker = new GatewayCommandWorker(new SqlCommandInbox(ownerStore), gateway);
    const lease = await gateway.ownership(accountId);
    assert.equal(await worker.runOne(lease), true);
    assert.equal(await worker.runOne(lease), false);
    assert.equal(
      (await ingress.result(principal, { workspaceId, accountId, requestId: command.requestId })).state,
      "COMPLETED",
    );
    assert.equal(socket.sent.length, 1);
  }
  finally
  {
    await gateway.close();
    await producer.close();
    await owner.close();
  }
});
