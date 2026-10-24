import type { GatewayCommandResponse } from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { GatewayCommandIngress } from "../src/application/command-ingress.ts";
import { GatewayFleetParticipant } from "../src/application/fleet-participant.ts";
import { Gateway } from "../src/application/gateway.ts";
import { GatewayPrincipal } from "../src/domain/authorization.ts";
import type { ClaimedGatewayCommand } from "../src/domain/command-inbox.ts";
import type { PreparedWhatsAppSend } from "../src/domain/connection.ts";
import type { AccountLease } from "../src/domain/gateway-store.ts";
import { BaileysConnection } from "../src/infrastructure/baileys/baileys-connection.ts";
import { SqlCommandInbox } from "../src/infrastructure/sql/command-inbox.ts";
import { SqlFleetStore } from "../src/infrastructure/sql/fleet-store.ts";
import type { SqlGatewayStore } from "../src/infrastructure/sql/gateway-store.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";
import { NativeSocketFixture } from "./support/native-socket.ts";
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!temporaryRoot || !postgresUrl) throw new Error("Explicit isolated fixtures required");
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} embedded participant honors desired revisions, drains commands and stops repeated unpaired attempts`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-fleet-"));
    const workspaceId = randomUUID();
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId, filename: join(directory, "fleet.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const store = storage.workspace(workspaceId);
    const account = await store.createAccount();
    const accountId = account.accountId;
    const principal = new GatewayPrincipal("operator", [{ workspaceId, accountIds: [accountId] }]);
    const fleetStore = new SqlFleetStore(store);
    const sockets: ControlledConnection[] = [];
    const gateway = new Gateway(store, () =>
    {
      const socket = new ControlledConnection();
      sockets.push(socket);
      return socket;
    }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
    const participant = new GatewayFleetParticipant(fleetStore, gateway, { capacity: 1 });
    try
    {
      const desired = { apiVersion: "1", workspaceId, accountId, expectedRevision: 0, enabled: true };
      await assert.rejects(
        participant.setDesired(
          new GatewayPrincipal("denied", [{ workspaceId, accountIds: [randomUUID()] }]),
          desired,
        ),
        /authorized/,
      );
      const first = await participant.setDesired(principal, desired);
      assert.equal(first.revision, 1);
      assert.deepEqual(await participant.setDesired(principal, desired), first);
      await Promise.all([participant.tick(), participant.tick()]);
      assert.equal(sockets.length, 1);
      const previous = await gateway.ownership(accountId);
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
          idempotencyKey: "fleet-effect",
          text: "automatically dispatched",
        },
      };
      const ingress = new GatewayCommandIngress(new SqlCommandInbox(store));
      await ingress.submit(principal, command);
      await participant.tick();
      await participant.drainCommands();
      assert.equal(
        (await ingress.result(principal, { workspaceId, accountId, requestId: command.requestId })).state,
        "COMPLETED",
      );
      assert.equal(sockets[0]?.sent.length, 1);
      await participant.setDesired(principal, { ...desired, expectedRevision: 1, enabled: false });
      await participant.tick();
      assert.equal(previous.alive, false);
      await assert.rejects(gateway.ownership(accountId), /owned/);
      await assert.rejects(participant.setDesired(principal, desired), /revision/);
      await participant.setDesired(principal, { ...desired, expectedRevision: 2, enabled: true });
      await participant.tick();
      assert.equal(sockets.length, 2);
      const second = await gateway.ownership(accountId);
      await store.setState(second, "FAILED");
      await participant.tick();
      await participant.tick();
      assert.equal(sockets.length, 2);
      assert.equal((await fleetStore.desired(accountId)).blockedRevision, 3);
      await participant.setDesired(principal, { ...desired, expectedRevision: 3, enabled: true });
      await participant.tick();
      assert.equal(sockets.length, 3);
    }
    finally
    {
      await participant.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("PostgreSQL peers retain sticky capacity, hand off paired ownership and cannot steal a live advisory lease", async () =>
{
  const configuration: StorageConfiguration = { engine: "postgresql", url: postgresUrl, mode: "cluster" };
  await migrateGatewayStorage(configuration);
  const firstStorage = await openGatewayStorage(configuration);
  const secondStorage = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  const firstStore = firstStorage.workspace(workspaceId);
  const secondStore = secondStorage.workspace(workspaceId);
  const firstFleet = new SqlFleetStore(firstStore);
  const secondFleet = new SqlFleetStore(secondStore);
  const firstSockets: ControlledConnection[] = [];
  const secondSockets: ControlledConnection[] = [];
  const firstGateway = new Gateway(firstStore, () =>
  {
    const socket = new ControlledConnection();
    firstSockets.push(socket);
    return socket;
  });
  const secondGateway = new Gateway(secondStore, () =>
  {
    const socket = new ControlledConnection();
    secondSockets.push(socket);
    return socket;
  });
  const first = new GatewayFleetParticipant(firstFleet, firstGateway, { capacity: 1 });
  const second = new GatewayFleetParticipant(secondFleet, secondGateway, { capacity: 2 });
  const principal = new GatewayPrincipal("operator", [{ workspaceId, accountIds: "*" }]);
  try
  {
    const a = await firstStore.createAccount();
    const b = await firstStore.createAccount();
    const c = await firstStore.createAccount();
    const d = await firstStore.createAccount();
    await first.setDesired(principal, {
      apiVersion: "1",
      workspaceId,
      accountId: a.accountId,
      expectedRevision: 0,
      enabled: true,
    });
    await first.tick();
    const oldLease = await firstGateway.ownership(a.accountId);
    for (const account of [b, c, d])
    {
      await first.setDesired(principal, {
        apiVersion: "1",
        workspaceId,
        accountId: account.accountId,
        expectedRevision: 0,
        enabled: true,
      });
    }
    await second.tick();
    await first.tick();
    await second.tick();
    assert.equal(firstSockets.length, 1);
    assert.equal(secondSockets.length, 2);
    assert.equal((await firstFleet.desired(a.accountId)).assignedRuntimeId, first.runtimeId);
    assert.equal(
      (await firstFleet.assignments()).filter(value => value.assignedRuntimeId !== null).length,
      3,
    );
    for (const account of [b, d])
    {
      await first.setDesired(principal, {
        apiVersion: "1",
        workspaceId,
        accountId: account.accountId,
        expectedRevision: 1,
        enabled: false,
      });
    }
    await second.tick();
    // Expire membership only. It is insufficient to steal the still-live exclusive account lease.
    await firstStore.transaction(async transaction =>
    {
      await transaction.updateTable("runtime").set({ expires_at: new Date(0).toISOString() }).where(
        "workspace_id",
        "=",
        workspaceId,
      ).where("id", "=", first.runtimeId).execute();
    });
    await secondFleet.heartbeat(second.runtimeId, 2, false, 15000);
    await secondFleet.coordinate();
    assert.equal((await firstFleet.desired(a.accountId)).assignedRuntimeId, second.runtimeId);
    await assert.rejects(secondGateway.start(a.accountId), /owned/);
    assert.equal(firstSockets.length, 1);
    await firstStore.writeAuthentication(oldLease, [{
      category: "credentials",
      keyId: "default",
      serializedValue: JSON.stringify({ me: { id: "100@s.whatsapp.net" } }),
    }]);
    await first.close();
    await second.tick();
    const newLease = await secondGateway.ownership(a.accountId);
    assert.ok(newLease.generation > oldLease.generation);
    await assert.rejects(firstStore.setState(oldLease, "CONNECTED"), /ownership/);
  }
  finally
  {
    await first.close();
    await second.close();
    await firstStorage.close();
    await secondStorage.close();
  }
});

test("SQLite participant never reopens an interrupted unpaired socket without an explicit new revision", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-fleet-pairing-"));
  const workspaceId = randomUUID();
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId,
    filename: join(directory, "pairing.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const store = storage.workspace(workspaceId);
  const account = await store.createAccount();
  const principal = new GatewayPrincipal("operator", [{ workspaceId, accountIds: "*" }]);
  const sockets: NativeSocketFixture[] = [];
  const connections: BaileysConnection[] = [];
  const createGateway = (): Gateway =>
    new Gateway(store, (_account, lease) =>
    {
      const connection = new BaileysConnection(store, lease, null, configuration =>
      {
        const socket = new NativeSocketFixture(configuration);
        sockets.push(socket);
        return socket.socket;
      });
      connections.push(connection);
      return connection;
    });
  const first = new GatewayFleetParticipant(new SqlFleetStore(store), createGateway(), { capacity: 1 });
  const second = new GatewayFleetParticipant(new SqlFleetStore(store), createGateway(), { capacity: 1 });
  try
  {
    await first.setDesired(principal, {
      apiVersion: "1",
      workspaceId,
      accountId: account.accountId,
      expectedRevision: 0,
      enabled: true,
    });
    await first.tick();
    assert.equal(sockets.length, 1);
    await first.close();
    await second.tick();
    await second.tick();
    assert.equal(sockets.length, 1);
    assert.equal((await new SqlFleetStore(store).desired(account.accountId)).blockedRevision, 1);
    await second.setDesired(principal, {
      apiVersion: "1",
      workspaceId,
      accountId: account.accountId,
      expectedRevision: 1,
      enabled: true,
    });
    await second.tick();
    assert.equal(sockets.length, 2);
    sockets[1]?.pair();
    sockets[1]?.update("open");
    await connections[1]?.drainEvents();
    assert.equal((await store.account(account.accountId)).state, "CONNECTED");
  }
  finally
  {
    await first.close();
    await second.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PostgreSQL coordinator election is transaction-exclusive and workspace-scoped", async () =>
{
  const configuration: StorageConfiguration = { engine: "postgresql", url: postgresUrl, mode: "cluster" };
  const first = await openGatewayStorage(configuration);
  const second = await openGatewayStorage(configuration);
  const workspaceId = randomUUID();
  try
  {
    await first.workspace(workspaceId).transaction(async transaction =>
    {
      assert.equal(await first.workspace(workspaceId).tryCoordinate(transaction), true);
      await second.workspace(workspaceId).transaction(async competing =>
      {
        assert.equal(await second.workspace(workspaceId).tryCoordinate(competing), false);
      });
      const other = second.workspace(randomUUID());
      await other.transaction(async independent =>
        assert.equal(await other.tryCoordinate(independent), true)
      );
    });
    await second.workspace(workspaceId).transaction(async successor =>
      assert.equal(await second.workspace(workspaceId).tryCoordinate(successor), true)
    );
  }
  finally
  {
    await first.close();
    await second.close();
  }
});

class FailingCompletionInbox extends SqlCommandInbox
{
  failCompletion = true;
  override async complete(
    lease: AccountLease,
    claim: ClaimedGatewayCommand,
    response: GatewayCommandResponse,
  ): Promise<void>
  {
    if (this.failCompletion)
    {
      this.failCompletion = false;
      throw new Error("Injected ingress completion failure");
    }
    await super.complete(lease, claim, response);
  }
}
class CompletionFailureFleetStore extends SqlFleetStore
{
  override readonly commands: FailingCompletionInbox;
  constructor(store: SqlGatewayStore)
  {
    super(store);
    this.commands = new FailingCompletionInbox(store);
  }
}
test("SQLite automatic owner recovery finishes a failed command checkpoint without another native send", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-fleet-recovery-"));
  const workspaceId = randomUUID();
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId,
    filename: join(directory, "recovery.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const store = storage.workspace(workspaceId);
  const account = await store.createAccount();
  const accountId = account.accountId;
  const fleetStore = new CompletionFailureFleetStore(store);
  const sockets: ControlledConnection[] = [];
  const gateway = new Gateway(store, () =>
  {
    const socket = new ControlledConnection();
    sockets.push(socket);
    return socket;
  }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
  const participant = new GatewayFleetParticipant(fleetStore, gateway);
  const principal = new GatewayPrincipal("fixture", [{ workspaceId, accountIds: "*" }]);
  try
  {
    await participant.setDesired(principal, {
      apiVersion: "1",
      workspaceId,
      accountId,
      expectedRevision: 0,
      enabled: true,
    });
    await participant.tick();
    await participant.drainCommands();
    const previous = await gateway.ownership(accountId);
    await store.writeAuthentication(previous, [{
      category: "credentials",
      keyId: "default",
      serializedValue: JSON.stringify({ me: { id: "100@s.whatsapp.net" } }),
    }]);
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
        idempotencyKey: "completion-recovery",
        text: "one actual effect",
      },
    };
    const ingress = new GatewayCommandIngress(fleetStore.commands);
    await ingress.submit(principal, command);
    await participant.tick();
    await participant.drainCommands();
    assert.equal((await fleetStore.commands.result(accountId, command.requestId)).state, "EXECUTING");
    assert.equal((await store.operation(accountId, "completion-recovery")).state, "ACCEPTED");
    await participant.tick();
    await participant.drainCommands();
    assert.equal((await fleetStore.commands.result(accountId, command.requestId)).state, "COMPLETED");
    assert.ok((await gateway.ownership(accountId)).generation > previous.generation);
    assert.equal(sockets.reduce((count, socket) => count + socket.sent.length, 0), 1);
  }
  finally
  {
    await participant.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class DeferredConnection extends ControlledConnection
{
  constructor(
    private readonly released: Promise<void>,
    private readonly entered: () => void,
    private readonly stopped: () => void,
  )
  {
    super();
  }
  override async send(prepared: PreparedWhatsAppSend): Promise<void>
  {
    await super.send(prepared);
    this.entered();
    await this.released;
  }
  override async stop(): Promise<void>
  {
    this.stopped();
  }
}
test("SQLite runtime timers renew membership during a slow send and shutdown drains the actual owner", {
  timeout: 10000,
}, async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-fleet-timers-"));
  const workspaceId = randomUUID();
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId,
    filename: join(directory, "timers.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const store = storage.workspace(workspaceId);
  const account = await store.createAccount();
  const accountId = account.accountId;
  let release!: () => void;
  let entered!: () => void;
  let stopped!: () => void;
  const released = new Promise<void>(resolve =>
  {
    release = resolve;
  });
  const started = new Promise<void>(resolve =>
  {
    entered = resolve;
  });
  const stopping = new Promise<void>(resolve =>
  {
    stopped = resolve;
  });
  const socket = new DeferredConnection(released, entered, stopped);
  const gateway = new Gateway(store, () => socket, {
    minimumDelayMs: 0,
    maximumDelayMs: 0,
    typingDelayMs: 0,
    sendTimeoutMs: 2000,
  });
  const fleetStore = new SqlFleetStore(store);
  const logs: string[] = [];
  const logger = pino({ level: "trace" }, {
    write: (line: string) =>
    {
      logs.push(line);
    },
  });
  const participant = new GatewayFleetParticipant(fleetStore, gateway, {
    capacity: 1,
    reconcileIntervalMs: 20,
    membershipLifetimeMs: 300,
  }, logger);
  const principal = new GatewayPrincipal("fixture", [{ workspaceId, accountIds: "*" }]);
  try
  {
    await participant.setDesired(principal, {
      apiVersion: "1",
      workspaceId,
      accountId,
      expectedRevision: 0,
      enabled: true,
    });
    await participant.start();
    const lease = await gateway.ownership(accountId);
    await store.writeAuthentication(lease, [{
      category: "credentials",
      keyId: "default",
      serializedValue: JSON.stringify({ me: { id: "100@s.whatsapp.net" } }),
    }]);
    const ingress = new GatewayCommandIngress(fleetStore.commands);
    await ingress.submit(principal, {
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
        idempotencyKey: "timed-worker",
        text: "slow controlled native effect",
      },
    });
    await started;
    await delay(450);
    await store.transaction(async transaction =>
    {
      const runtime = await transaction.selectFrom("runtime").selectAll().where(
        "workspace_id",
        "=",
        workspaceId,
      ).where("id", "=", participant.runtimeId).executeTakeFirstOrThrow();
      assert.ok(new Date(runtime.expires_at).getTime() > (await store.databaseTime(transaction)).getTime());
      assert.equal(runtime.draining, 0);
    });
    const closing = participant.close();
    await stopping;
    await store.transaction(async transaction =>
    {
      const runtime = await transaction.selectFrom("runtime").select("draining").where(
        "workspace_id",
        "=",
        workspaceId,
      ).where("id", "=", participant.runtimeId).executeTakeFirstOrThrow();
      assert.equal(runtime.draining, 1);
    });
    release();
    await closing;
    assert.equal(lease.alive, false);
    assert.equal(socket.sent.length, 1);
    assert.ok(
      logs.every(line => Number(JSON.parse(line).level) < 40),
      "Intentional shutdown must not report a failed worker",
    );
    assert.equal((await fleetStore.desired(accountId)).enabled, true);
    await store.transaction(async transaction =>
      assert.equal(
        (await transaction.selectFrom("runtime").selectAll().where("workspace_id", "=", workspaceId)
          .execute()).length,
        0,
      )
    );
  }
  finally
  {
    release();
    await participant.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a guarded fleet start cannot adopt an unverified manual session or create a socket after lease loss", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-fleet-guard-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId: randomUUID(),
    filename: join(directory, "guard.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const store = storage.workspace(
    configuration.engine === "sqlite" ? configuration.workspaceId : randomUUID(),
  );
  const first = await store.createAccount();
  const second = await store.createAccount();
  let sockets = 0;
  const gateway = new Gateway(store, () =>
  {
    sockets++;
    return new ControlledConnection();
  });
  try
  {
    await gateway.start(first.accountId);
    await assert.rejects(
      gateway.start(first.accountId, async () =>
      {
        throw new Error("This guard must not be bypassed");
      }),
      /owned/,
    );
    assert.equal((await gateway.ownership(first.accountId)).alive, true);
    await assert.rejects(
      gateway.start(second.accountId, async lease =>
      {
        lease.lose();
      }),
      /ownership lost/,
    );
    assert.equal(sockets, 1);
    const successor = await store.acquire(second.accountId);
    await successor.release();
  }
  finally
  {
    await gateway.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

type ConnectionStartParameters = Parameters<ControlledConnection["start"]>;
class AccountStartBarrierConnection extends ControlledConnection
{
  constructor(private readonly released: Promise<void>, private readonly entered: () => void)
  {
    super();
  }
  override async start(...parameters: ConnectionStartParameters): Promise<void>
  {
    this.entered();
    await this.released;
    await super.start(...parameters);
  }
}
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} participant close prevents starting another account after a blocked startup resumes`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-start-drain-"));
    const workspaceId = randomUUID();
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId, mode: "local", filename: join(directory, "start.sqlite") }
      : { engine, mode: "cluster", url: postgresUrl };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const store = storage.workspace(workspaceId);
    const fleetStore = new SqlFleetStore(store);
    let release!: () => void;
    let entered!: () => void;
    const released = new Promise<void>(resolve =>
    {
      release = resolve;
    });
    const started = new Promise<void>(resolve =>
    {
      entered = resolve;
    });
    let connections = 0;
    const gateway = new Gateway(store, () =>
    {
      connections++;
      return connections === 1
        ? new AccountStartBarrierConnection(released, entered)
        : new ControlledConnection();
    });
    const participant = new GatewayFleetParticipant(fleetStore, gateway, { capacity: 2 });
    try
    {
      for (let index = 0; index < 2; index++)
      {
        const account = await store.createAccount();
        await fleetStore.setDesired({
          apiVersion: "1",
          workspaceId,
          accountId: account.accountId,
          expectedRevision: 0,
          enabled: true,
        });
      }
      const starting = participant.start();
      await started;
      const closing = participant.close();
      release();
      await starting;
      await closing;
      assert.equal(
        connections,
        1,
        "An in-progress reconciliation must observe shutdown before the next account start",
      );
    }
    finally
    {
      release();
      await participant.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

class AssignmentBarrierStore extends SqlFleetStore
{
  constructor(
    store: SqlGatewayStore,
    private readonly released: Promise<void>,
    private readonly entered: () => void,
  )
  {
    super(store);
  }
  override async claimAssignment(...parameters: Parameters<SqlFleetStore["claimAssignment"]>): Promise<void>
  {
    this.entered();
    await this.released;
    await super.claimAssignment(...parameters);
  }
}
test("shutdown during a real SQL assignment claim does not construct a new socket afterward", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-assignment-drain-"));
  const workspaceId = randomUUID();
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId,
    mode: "local",
    filename: join(directory, "claim.sqlite"),
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const store = storage.workspace(workspaceId);
  const account = await store.createAccount();
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>(resolve =>
  {
    release = resolve;
  });
  const enteredClaim = new Promise<void>(resolve =>
  {
    entered = resolve;
  });
  const fleetStore = new AssignmentBarrierStore(store, released, entered);
  await fleetStore.setDesired({
    apiVersion: "1",
    workspaceId,
    accountId: account.accountId,
    expectedRevision: 0,
    enabled: true,
  });
  let connections = 0;
  const gateway = new Gateway(store, () =>
  {
    connections++;
    return new ControlledConnection();
  });
  const participant = new GatewayFleetParticipant(fleetStore, gateway);
  try
  {
    const starting = participant.start();
    await enteredClaim;
    const closing = participant.close();
    release();
    await starting;
    await closing;
    assert.equal(connections, 0);
    assert.equal((await store.account(account.accountId)).generation, 1);
  }
  finally
  {
    release();
    await participant.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
