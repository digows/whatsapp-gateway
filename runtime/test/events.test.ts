import { GatewayCloudEventSchema } from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Gateway } from "../src/application/gateway.ts";
import { SqlGatewayEventLog } from "../src/infrastructure/sql/event-log.ts";
import { type GatewayTransaction, SqlGatewayStore } from "../src/infrastructure/sql/gateway-store.ts";
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
  test(`${engine} public CloudEvents commit with owning state, retain stable identity and isolate replay`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-events-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "events.sqlite"), mode: "local" }
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
    try
    {
      await store.createAccount(accountId);
      await gateway.start(accountId);
      const lease = await gateway.ownership(accountId);
      const message = {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        receivingAddress: "100@s.whatsapp.net",
        chatAddress: "200@s.whatsapp.net",
        senderAddress: "200@s.whatsapp.net",
        mentionsReceiver: false,
        channelMessageId: "incoming-fixture",
        occurredAt: new Date().toISOString(),
        text: "incoming retained once",
      };
      await store.retain(lease, message, "private-protocol-secret");
      await store.retain(lease, message, "private-protocol-secret");
      const receipt = {
        channelMessageId: "outgoing-fixture",
        chatAddress: "200@s.whatsapp.net",
        status: "DELIVERED",
      };
      await store.recordReceipt(lease, receipt);
      await store.recordReceipt(lease, receipt);
      const outgoing = {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: "200@s.whatsapp.net",
        idempotencyKey: "public-events-send",
        text: "one native send",
      };
      await gateway.send(accountId, outgoing);
      await gateway.send(accountId, outgoing);
      const log = new SqlGatewayEventLog(store);
      const events = await log.after(accountId, 0, 100);
      assert.ok(events.length >= 6);
      assert.ok(events.every(event => GatewayCloudEventSchema.safeParse(event).success));
      assert.equal(
        events.filter(event => event.type === "com.digows.whatsapp.message.received.v1").length,
        1,
      );
      assert.equal(
        events.filter(event => event.type === "com.digows.whatsapp.message.delivery.v1").length,
        1,
      );
      assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
      assert.ok(events.every(event => event.workspaceid === workspaceId && event.accountid === accountId));
      assert.doesNotMatch(JSON.stringify(events), /private-protocol-secret/);
      assert.equal(socket.sent.length, 1);
      const first = events[0];
      assert.ok(first);
      assert.deepEqual(await log.after(accountId, first.sequence, 100), events.slice(1));
      const other = new SqlGatewayEventLog(storage.workspace(randomUUID()));
      assert.deepEqual(await other.after(accountId, 0, 100), []);
      assert.deepEqual(await log.after(randomUUID(), 0, 100), []);
      await gateway.close();
      const beforeClose = await log.after(accountId, 0, 100);
      await storage.close();
      storage = await openGatewayStorage(configuration);
      assert.deepEqual(
        await new SqlGatewayEventLog(storage.workspace(workspaceId)).after(accountId, 0, 100),
        beforeClose,
      );
    }
    finally
    {
      await gateway.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

class FailingEventClockStore extends SqlGatewayStore
{
  failPublicEvent = false;
  override async databaseTime(transaction: GatewayTransaction): Promise<Date>
  {
    if (this.failPublicEvent) throw new Error("Injected publication transaction failure");
    return super.databaseTime(transaction);
  }
}
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} publication failure rolls back native retention, state and send checkpoints`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-event-rollback-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "rollback.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const store = new FailingEventClockStore(storage, workspaceId);
    const account = await store.createAccount();
    const accountId = account.accountId;
    const lease = await store.acquire(accountId);
    try
    {
      const log = new SqlGatewayEventLog(store);
      const before = await log.after(accountId, 0, 100);
      store.failPublicEvent = true;
      await assert.rejects(
        store.setState(lease, "CONNECTED", "100@s.whatsapp.net"),
        /publication transaction failure/,
      );
      assert.equal((await store.account(accountId)).state, "STOPPED");
      const message = {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        receivingAddress: "100@s.whatsapp.net",
        chatAddress: "200@s.whatsapp.net",
        senderAddress: "200@s.whatsapp.net",
        mentionsReceiver: false,
        channelMessageId: "rolled-back",
        occurredAt: new Date().toISOString(),
        text: "must not partially persist",
      };
      await assert.rejects(
        store.retain(lease, message, "private rolled back"),
        /publication transaction failure/,
      );
      await assert.rejects(store.native(accountId, "rolled-back"), /unavailable/);
      await assert.rejects(
        store.recordReceipt(lease, { channelMessageId: "rolled-back", chatAddress: null, status: "READ" }),
        /publication transaction failure/,
      );
      assert.deepEqual(await store.receipts(accountId, "rolled-back"), []);
      const send = {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: "200@s.whatsapp.net",
        idempotencyKey: "rollback-operation",
        text: "not dispatched",
      };
      await assert.rejects(store.reserve(lease, send, 1), /publication transaction failure/);
      await assert.rejects(store.operation(accountId, send.idempotencyKey), /unavailable/);
      assert.deepEqual(await log.after(accountId, 0, 100), before);
      store.failPublicEvent = false;
      const operation = await store.reserve(lease, send, 1);
      operation.dispatch(0);
      store.failPublicEvent = true;
      await assert.rejects(store.save(lease, operation), /publication transaction failure/);
      assert.equal((await store.operation(accountId, send.idempotencyKey)).state, "PENDING");
      store.failPublicEvent = false;
      await Promise.all(Array.from({ length: 12 }, (_, index) =>
        store.retain(lease, { ...message, channelMessageId: `concurrent-${index}` }, "private")));
      const after = await log.after(accountId, 0, 100);
      assert.deepEqual(
        after.map(event =>
          event.sequence
        ),
        after.map((_, index) => index + 1),
      );
      assert.equal(new Set(after.map(event => event.id)).size, after.length);
      assert.equal(
        after.filter(event => event.type === "com.digows.whatsapp.message.received.v1").length,
        12,
      );
    }
    finally
    {
      store.failPublicEvent = false;
      await lease.release();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
