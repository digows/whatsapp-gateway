import { sql } from "kysely";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Gateway } from "../src/application/gateway.ts";
import type { AccountLease } from "../src/domain/gateway-store.ts";
import { SendOperation } from "../src/domain/send-operation.ts";
import { PostgresGatewayStore } from "../src/infrastructure/postgres/gateway-store.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";

const url = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!url) throw new Error("An owned disposable GATEWAY_TEST_DATABASE_URL is required");
const workspace = randomUUID();
const store = new PostgresGatewayStore(url, workspace);
const other = new PostgresGatewayStore(url, randomUUID());
const sockets: ControlledConnection[] = [];
const calibration = {
  minimumDelayMs: 0,
  maximumDelayMs: 0,
  dailyMaximum: 1500,
  sendTimeoutMs: 50,
  typingDelayMs: 0,
};
const gateway = new Gateway(store, () =>
{
  const socket = new ControlledConnection();
  sockets.push(socket);
  return socket;
}, calibration);
const replica = new Gateway(store, () => new ControlledConnection(), calibration);
const accountId = randomUUID();
before(async () =>
{
  await store.createAccount(accountId);
});
after(async () =>
{
  await gateway.close();
  await replica.close();
  await store.close();
  await other.close();
});

test("one account owner survives duplicated calls and a second replica cannot steal it", async () =>
{
  await Promise.all([gateway.start(accountId), gateway.start(accountId)]);
  assert.equal(sockets.length, 1);
  await assert.rejects(replica.start(accountId), /owned/);
});

test("application stable key deduplicates concurrent sends and rejects changed payload", async () =>
{
  const input = {
    channel: "WHATSAPP" as const,
    senderAddress: "100@s.whatsapp.net",
    recipientAddress: "200@s.whatsapp.net",
    contentKind: "TEXT" as const,
    text: "hello",
    idempotencyKey: "same",
  };
  const results = await Promise.all([gateway.send(accountId, input), gateway.send(accountId, input)]);
  assert.equal(results[0]?.state, "ACCEPTED");
  assert.deepEqual(results[0], results[1]);
  assert.equal(sockets[0]?.sent.length, 1);
  await assert.rejects(gateway.send(accountId, { ...input, text: "changed" }), /different payload/);
  await assert.rejects(other.operation(accountId, "same"), /unavailable/);
});

test("a timed-out dispatch becomes UNKNOWN and replay cannot issue a fresh send", async () =>
{
  const socket = sockets[0];
  if (!socket) throw new Error("Missing fixture");
  socket.failSend = true;
  const input = {
    channel: "WHATSAPP" as const,
    senderAddress: "100@s.whatsapp.net",
    recipientAddress: "200@s.whatsapp.net",
    contentKind: "TEXT" as const,
    text: "uncertain",
    idempotencyKey: "unknown",
  };
  assert.equal((await gateway.send(accountId, input)).state, "UNKNOWN");
  const count = socket.sent.length;
  assert.equal((await gateway.send(accountId, input)).state, "UNKNOWN");
  assert.equal(socket.sent.length, count);
  socket.failSend = false;
});

test("ownership generation rejects stale writes after shutdown and successor acquisition", async () =>
{
  const old = await gateway.ownership(accountId);
  await gateway.stop(accountId);
  await replica.start(accountId);
  await assert.rejects(store.setState(old, "CONNECTED"), /ownership/);
  assert.equal((await store.account(accountId)).generation, old.generation + 1);
});

test("factory failure releases the account claim instead of orphaning its PostgreSQL connection", async () =>
{
  const id = randomUUID();
  await store.createAccount(id);
  const broken = new Gateway(store, () =>
  {
    throw new Error("Factory failure");
  });
  await assert.rejects(broken.start(id), /Factory failure/);
  await broken.close();
  await replica.start(id);
  await replica.stop(id);
});

test("a replacement owner recovers an interrupted dispatch only as UNKNOWN", async () =>
{
  const id = randomUUID();
  await store.createAccount(id);
  const worker = new Gateway(store, () => new ControlledConnection(), calibration);
  await worker.start(id);
  const message = {
    channel: "WHATSAPP" as const,
    senderAddress: "100@s.whatsapp.net",
    recipientAddress: "200@s.whatsapp.net",
    contentKind: "TEXT" as const,
    text: "original",
    idempotencyKey: "interrupted",
  };
  const lease = await worker.ownership(id);
  const operation = await store.reserve(lease, message, 1);
  operation.dispatch(0);
  await store.save(lease, operation);
  await worker.stop(id);
  await replica.start(id);
  assert.equal((await replica.send(id, message)).state, "UNKNOWN");
  await replica.stop(id);
  await worker.close();
});

test("PostgreSQL RLS rejects tenant writes and unqualified reads cannot see another workspace", async () =>
{
  const id = randomUUID();
  await other.createAccount(id);
  const rows = await store.transaction(async client =>
    (await sql<Record<string, string>>`SELECT workspace_id FROM gateway.account`.execute(client)).rows
  );
  assert.ok(rows.every(row => row.workspace_id === workspace));
  await assert.rejects(
    store.transaction(async client =>
    {
      await sql`INSERT INTO gateway.account(workspace_id,id) VALUES(${other.workspaceId},${randomUUID()})`
        .execute(client);
    }),
    /row-level security/,
  );
});

class FailingCheckpointStore extends PostgresGatewayStore
{
  override async save(lease: AccountLease, operation: SendOperation): Promise<void>
  {
    if (operation.state === "ACCEPTED") throw new Error("Injected unavailable completion checkpoint");
    await super.save(lease, operation);
  }
}
test("native submission without a durable completion checkpoint remains UNKNOWN and cannot resend", async () =>
{
  const isolated = new FailingCheckpointStore(url!, randomUUID());
  const socket = new ControlledConnection();
  const worker = new Gateway(isolated, () => socket, calibration);
  const id = randomUUID();
  try
  {
    await isolated.createAccount(id);
    await worker.start(id);
    const message = {
      channel: "WHATSAPP" as const,
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "checkpoint",
      contentKind: "TEXT" as const,
      text: "one",
    };
    assert.equal((await worker.send(id, message)).state, "UNKNOWN");
    assert.equal((await worker.send(id, message)).state, "UNKNOWN");
    assert.equal(socket.sent.length, 1);
  }
  finally
  {
    await worker.close();
    await isolated.close();
  }
});
