import type { InboundMessage, OutboundMessage } from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  Gateway,
  type GatewayConfigurationInput,
  GatewayConfigurationSchema,
} from "../src/application/gateway.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";

interface TypingFixture
{
  readonly gateway: Gateway;
  readonly connection: ControlledConnection;
  readonly accountId: string;
}

const temporaryRoot = process.env["TMPDIR"];
if (!temporaryRoot) throw new Error("Explicit owned temporary root required");

async function fixture(
  context: TestContext,
  configuration: GatewayConfigurationInput = {},
): Promise<TypingFixture>
{
  const directory = await mkdtemp(join(temporaryRoot!, "gateway-typing-"));
  const storageConfiguration: StorageConfiguration = {
    engine: "sqlite",
    mode: "local",
    workspaceId: randomUUID(),
    filename: join(directory, "gateway.sqlite"),
  };
  await migrateGatewayStorage(storageConfiguration);
  const storage = await openGatewayStorage(storageConfiguration);
  const store = storage.workspace(storageConfiguration.workspaceId);
  const accountId = randomUUID();
  const connection = new ControlledConnection();
  const gateway = new Gateway(store, () => connection, {
    minimumDelayMs: 0,
    maximumDelayMs: 0,
    typingDelayMs: 0,
    ...configuration,
  });
  context.after(async () =>
  {
    await gateway.close();
    context.mock.timers.reset();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.createAccount(accountId);
  await gateway.start(accountId);
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  return { gateway, connection, accountId };
}

function incoming(): InboundMessage
{
  return {
    channel: "WHATSAPP",
    contentKind: "TEXT",
    receivingAddress: "100@s.whatsapp.net",
    senderAddress: "200@s.whatsapp.net",
    chatAddress: "200@s.whatsapp.net",
    mentionsReceiver: false,
    channelMessageId: randomUUID(),
    occurredAt: new Date().toISOString(),
    text: "hello",
  };
}

async function advance(context: TestContext, milliseconds: number): Promise<void>
{
  context.mock.timers.tick(milliseconds);
  // Drain asynchronous SQL/presence continuations, including the existing zero-delay send timers.
  for (let index = 0; index < 4; index++)
  {
    await setImmediate();
    context.mock.timers.tick(0);
  }
}

test("initial typing configuration defaults to 2000 ms and accepts zero as immediate typing", () =>
{
  assert.equal(GatewayConfigurationSchema.parse({}).initialTypingDelayMs, 2000);
  assert.equal(GatewayConfigurationSchema.parse({ initialTypingDelayMs: 0 }).initialTypingDelayMs, 0);
  for (const initialTypingDelayMs of [-1, 0.5, 2147483648, "2000"])
  {
    assert.equal(GatewayConfigurationSchema.safeParse({ initialTypingDelayMs }).success, false);
  }
});

test("incoming text returns without composing or blocking and starts typing after the default delay", async context =>
{
  const { connection } = await fixture(context);
  const startedAt = Date.now();
  await connection.events.received(incoming(), "native");
  assert.equal(Date.now(), startedAt);
  assert.deepEqual(connection.typing, []);
  await advance(context, 1999);
  assert.deepEqual(connection.typing, []);
  await advance(context, 1);
  assert.deepEqual(connection.typing, [true]);
});

for (const initialTypingDelayMs of [750, 0])
{
  test(`incoming text respects configured initial typing delay ${initialTypingDelayMs}`, async context =>
  {
    const { connection } = await fixture(context, { initialTypingDelayMs });
    await connection.events.received(incoming(), "native");
    if (initialTypingDelayMs > 0)
    {
      await advance(context, initialTypingDelayMs - 1);
      assert.deepEqual(connection.typing, []);
      await advance(context, 1);
    }
    else await advance(context, 0);
    assert.deepEqual(connection.typing, [true]);
  });
}

test("an early reply uses only pre-send typing and never waits for the pending initial delay", {
  timeout: 10000,
}, async context =>
{
  const { gateway, connection, accountId } = await fixture(context, { typingDelayMs: 75 });
  await connection.events.received(incoming(), "native");
  await advance(context, 500);
  const reply: OutboundMessage = {
    channel: "WHATSAPP",
    contentKind: "TEXT",
    senderAddress: "100@s.whatsapp.net",
    recipientAddress: "200@s.whatsapp.net",
    idempotencyKey: "early-reply",
    text: "ready",
  };
  const pending = gateway.send(accountId, reply);
  while (!connection.typing.includes(true))
  {
    context.signal.throwIfAborted();
    await advance(context, 0);
  }
  assert.equal(connection.typing.filter(Boolean).length, 1);
  assert.equal(connection.sent.length, 0);
  await advance(context, 74);
  assert.equal(connection.sent.length, 0);
  await advance(context, 1);
  assert.equal((await pending).state, "ACCEPTED");
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.typing.at(-1), false);
  const signals = [...connection.typing];
  await advance(context, 30000);
  assert.deepEqual(connection.typing, signals);
});

for (const cancellation of ["stop", "presence", "manual reply", "disconnect", "ownership loss"] as const)
{
  test(`${cancellation} cancels pending initial typing without a late composing signal`, async context =>
  {
    const { gateway, connection, accountId } = await fixture(context);
    const message = incoming();
    await connection.events.received(message, "native");
    await advance(context, 500);
    switch (cancellation)
    {
      case "stop":
        await gateway.stop(accountId);
        break;
      case "presence":
        await gateway.presence(accountId, message.chatAddress, false);
        break;
      case "manual reply":
        await connection.events.received(
          { ...incoming(), senderAddress: message.receivingAddress },
          "manual",
        );
        break;
      case "disconnect":
        await connection.events.state("CONNECTING");
        await connection.events.state("CONNECTED", message.receivingAddress);
        break;
      case "ownership loss":
        (await gateway.ownership(accountId)).lose();
        break;
    }
    await advance(context, 60000);
    assert.equal(connection.typing.includes(true), false);
  });
}

test("initial typing expires inside the delay without extending the message window", async context =>
{
  const { connection } = await fixture(context);
  const message = { ...incoming(), occurredAt: new Date(Date.now() - 29500).toISOString() };
  await connection.events.received(message, "native");
  await advance(context, 500);
  assert.equal(connection.typing.includes(true), false);
  await advance(context, 30000);
  assert.equal(connection.typing.includes(true), false);
});

test("later incoming text does not restart the initial delay or extend the existing heartbeat", async context =>
{
  const { connection } = await fixture(context);
  await connection.events.received(
    { ...incoming(), occurredAt: new Date(Date.now() - 10000).toISOString() },
    "first",
  );
  await advance(context, 1000);
  await connection.events.received(incoming(), "second");
  await advance(context, 999);
  assert.deepEqual(connection.typing, []);
  await advance(context, 1);
  assert.deepEqual(connection.typing, [true]);
  await advance(context, 17999);
  assert.equal(connection.typing.at(-1), true);
  await advance(context, 1);
  assert.equal(connection.typing.at(-1), false);
  const count = connection.typing.length;
  await advance(context, 30000);
  assert.equal(connection.typing.length, count);
});

test("expired text and group text start no initial typing", async context =>
{
  const { connection } = await fixture(context);
  await connection.events.received(
    { ...incoming(), occurredAt: new Date(Date.now() - 30001).toISOString() },
    "expired",
  );
  await connection.events.received({ ...incoming(), chatAddress: "200@g.us" }, "group");
  await advance(context, 30000);
  assert.deepEqual(connection.typing, []);
});
