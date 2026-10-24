import type { BinaryNode, USyncQuery } from "baileys";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Gateway } from "../src/application/gateway.ts";
import { BaileysConnection } from "../src/infrastructure/baileys/baileys-connection.ts";
import { migrateGatewayStorage, openGatewayStorage } from "../src/infrastructure/sql/storage.ts";
import { NativeSocketFixture } from "./support/native-socket.ts";

function nativeResult(type?: string, error?: string, nativeAddress = "442079460018@lid"): BinaryNode
{
  return {
    tag: "iq",
    attrs: { type: "result" },
    content: [{
      tag: "usync",
      attrs: {},
      content: [{
        tag: "list",
        attrs: {},
        content: [{
          tag: "user",
          attrs: { jid: nativeAddress },
          content: type === undefined
            ? []
            : [{
              tag: "contact",
              attrs: { type },
              ...(error
                ? { content: [{ tag: "error", attrs: { code: error, text: "Fixture query error" } }] }
                : {}),
            }],
        }],
      }],
    }],
  };
}

type CompleteSuspendedLookup = () => void;
interface SuspendedLookup
{
  readonly started: Promise<void>;
  readonly complete: CompleteSuspendedLookup;
}
function suspendLookup(socket: NativeSocketFixture): SuspendedLookup
{
  let started: CompleteSuspendedLookup | undefined;
  let complete: CompleteSuspendedLookup | undefined;
  const ready = new Promise<void>(resolve =>
  {
    started = resolve;
  });
  socket.registration = query =>
    new Promise(resolve =>
    {
      complete = () => resolve(query.parseUSyncQueryResult(nativeResult("in")));
      started?.();
    });
  return {
    started: ready,
    complete: () =>
    {
      if (!complete) throw new Error("Lookup has not started");
      complete();
    },
  };
}

test("account-scoped contact lookup preserves native identity and explicit negatives without country rewriting", async () =>
{
  const temporaryRoot = process.env["TMPDIR"];
  if (!temporaryRoot) throw new Error("Explicit owned TMPDIR required");
  const directory = await mkdtemp(join(temporaryRoot, "gateway-registration-"));
  const configuration = {
    engine: "sqlite",
    workspaceId: randomUUID(),
    filename: join(directory, "gateway.sqlite"),
    mode: "local",
  } as const;
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const store = storage.workspace(configuration.workspaceId);
  const account = await store.createAccount();
  let socket: NativeSocketFixture | undefined;
  let connection: BaileysConnection | undefined;
  const gateway = new Gateway(store, (_account, lease) =>
  {
    connection = new BaileysConnection(
      store,
      lease,
      null,
      configuration =>
      {
        socket = new NativeSocketFixture(configuration);
        return socket.socket;
      },
      30000,
      50,
    );
    return connection;
  }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
  try
  {
    await gateway.start(account.accountId);
    assert.ok(socket);
    assert.ok(connection);
    socket.pair();
    socket.update("open");
    await connection.drainEvents();
    const queries: USyncQuery[] = [];
    socket.registration = async query =>
    {
      queries.push(query);
      return query.parseUSyncQueryResult(nativeResult("in"));
    };
    const positive = await gateway.lookupContactAddress(account.accountId, "+442079460018");
    assert.equal(positive.status, "REGISTERED");
    assert.equal(positive.workspaceId, store.workspaceId);
    assert.equal(positive.accountId, account.accountId);
    assert.equal(positive.address, "+442079460018");
    assert.ok("resolvedAddress" in positive);
    assert.equal(positive.resolvedAddress, "442079460018@lid");
    assert.equal(queries[0]?.users[0]?.phone, "+442079460018");
    let addressLookups = 0;
    socket.registration = async query =>
    {
      if (++addressLookups > 1)
      {
        throw new Error("A prepared native address must not be queried again before dispatch");
      }
      return query.parseUSyncQueryResult(nativeResult("in"));
    };
    const sent = await gateway.send(account.accountId, {
      channel: "WHATSAPP",
      contentKind: "TEXT",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "+442079460018",
      idempotencyKey: "resolved-once",
      text: "one prepared identity",
    });
    assert.equal(sent.state, "ACCEPTED");
    assert.equal(sent.workspaceId, store.workspaceId);
    assert.equal(sent.accountId, account.accountId);
    assert.equal(addressLookups, 1);
    assert.equal(socket.sent[0]?.recipient, "442079460018@lid");
    socket.registration = async query =>
      query.parseUSyncQueryResult(nativeResult("out", undefined, "12125550100@s.whatsapp.net"));
    assert.equal(
      (await gateway.lookupContactAddress(account.accountId, "+12125550100")).status,
      "UNREGISTERED",
    );
    for (
      const response of [
        undefined,
        nativeResult(),
        nativeResult("unknown"),
        nativeResult("out"),
        nativeResult("out", "401"),
      ]
    )
    {
      socket.registration = async query => query.parseUSyncQueryResult(response);
      assert.equal(
        (await gateway.lookupContactAddress(account.accountId, "+81312345678")).status,
        "INDETERMINATE",
      );
    }
    let calls = 0;
    socket.registration = async () =>
    {
      calls++;
      throw new Error("Lookup unavailable");
    };
    assert.equal(
      (await gateway.lookupContactAddress(account.accountId, "+33123456789")).status,
      "INDETERMINATE",
    );
    for (const address of ["123@lid", "123@g.us", "invalid", "+000123"])
    {
      const result = await gateway.lookupContactAddress(account.accountId, address);
      assert.equal(result.status, "INDETERMINATE");
      assert.ok("reason" in result);
      assert.equal(result.reason, "UNSUPPORTED_ADDRESS");
    }
    assert.equal(calls, 1);
    const firstGeneration = socket;
    const delayed = suspendLookup(firstGeneration);
    const stale = gateway.lookupContactAddress(account.accountId, "+4915112345678");
    await delayed.started;
    firstGeneration.update("close", 515);
    await connection.drainEvents();
    delayed.complete();
    const fenced = await stale;
    assert.equal(fenced.status, "INDETERMINATE");
    assert.ok("reason" in fenced);
    assert.equal(fenced.reason, "OWNERSHIP_CHANGED");
    socket.update("open");
    await connection.drainEvents();
    socket.registration = async () => new Promise(() => undefined);
    const timedOut = await gateway.lookupContactAddress(account.accountId, "+4915112345678");
    assert.equal(timedOut.status, "INDETERMINATE");
    assert.ok("reason" in timedOut);
    assert.equal(timedOut.reason, "TIMEOUT");
    const waiting = suspendLookup(socket);
    const pending = gateway.lookupContactAddress(account.accountId, "+4915112345678");
    await waiting.started;
    await gateway.stop(account.accountId);
    const stopped = await pending;
    assert.equal(stopped.status, "INDETERMINATE");
    assert.ok("reason" in stopped);
    assert.equal(stopped.reason, "OWNERSHIP_CHANGED");
    waiting.complete();
    assert.equal(firstGeneration.sent.length, 1);
    assert.equal(socket.sent.length, 0);
  }
  finally
  {
    await gateway.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
