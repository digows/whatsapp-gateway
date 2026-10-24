import { GatewayCommandResultSchema } from "@digows/whatsapp-gateway-contracts";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  gatewayWorkspaceStorageConfiguration,
  migrateGatewayRuntimeStorage,
  verifyGatewayRuntimeStorage,
} from "../src/application/configuration/storage-configuration.ts";
import { GatewayRuntime } from "../src/application/runtime.ts";
import { SqlGatewayStore } from "../src/infrastructure/sql/gateway-store.ts";
import { migrateGatewayStorage, openGatewayStorage } from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";
interface RowCount
{
  readonly total: number;
}
interface SchemaVersion
{
  readonly version: number;
}
interface StoredAccount
{
  readonly id: string;
}
const executeProcess = promisify(execFile);
const compiledCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const temporaryRoot = process.env["TMPDIR"];
if (!temporaryRoot) throw new Error("Explicit owned temporary root required");

test("SQLite files persist one canonical workspace binding and independently own multiple accounts", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-files-"));
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const accountId = randomUUID();
  const secondAccountId = randomUUID();
  const configuration = {
    engine: "sqlite",
    mode: "local",
    filename: join(directory, "first.sqlite"),
    workspaceId,
  };
  const otherConfiguration = {
    ...configuration,
    filename: join(directory, "second.sqlite"),
    workspaceId: otherWorkspaceId,
  };
  try
  {
    await migrateGatewayStorage(configuration);
    await migrateGatewayStorage(otherConfiguration);
    const first = await openGatewayStorage(configuration);
    const second = await openGatewayStorage(otherConfiguration);
    try
    {
      const firstStore = first.workspace(workspaceId.toUpperCase());
      const secondStore = second.workspace(otherWorkspaceId);
      await firstStore.createAccount(accountId);
      await firstStore.createAccount(secondAccountId);
      await secondStore.createAccount(accountId);
      assert.equal((await firstStore.account(secondAccountId)).workspaceId, workspaceId);
      assert.equal((await secondStore.account(accountId)).workspaceId, otherWorkspaceId);
      assert.throws(() => first.workspace(otherWorkspaceId), /workspace/i);
      assert.throws(() => new SqlGatewayStore(first, otherWorkspaceId), /workspace/i);
      await assert.rejects(secondStore.account(secondAccountId), /unavailable/i);
      const firstLease = await firstStore.acquire(accountId);
      const secondLease = await secondStore.acquire(accountId);
      await firstLease.release();
      await first.close();
      assert.equal(secondLease.alive, true);
      const reopened = await openGatewayStorage(configuration);
      await reopened.close();
      await assert.rejects(openGatewayStorage(otherConfiguration), /locked|exclusive/i);
      await secondLease.release();
      assert.equal((await stat(configuration.filename)).mode & 0o077, 0);
      assert.equal((await stat(otherConfiguration.filename)).mode & 0o077, 0);
    }
    finally
    {
      await first.close();
      await second.close();
    }
    await assert.rejects(
      openGatewayStorage({ ...configuration, workspaceId: otherWorkspaceId }),
      /workspace/i,
    );
    await assert.rejects(
      migrateGatewayStorage({ ...configuration, workspaceId: otherWorkspaceId }),
      /workspace/i,
    );
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

async function legacyFile(filename: string, workspaceIds: readonly string[]): Promise<void>
{
  const database = new Database(filename);
  await chmod(filename, 0o600);
  try
  {
    for (
      const name of [
        "001_gateway_core.sql",
        "002_command_ingress.sql",
        "003_runtime_placement.sql",
        "004_public_events.sql",
        "005_webhook_outbox.sql",
        "006_redis_streams.sql",
        "007_message_history.sql",
      ]
    )
    {
      database.exec(await readFile(new URL(`../migrations/sqlite/${name}`, import.meta.url), "utf8"));
    }
    for (const workspaceId of workspaceIds)
    {
      const accountId = randomUUID();
      database.prepare("INSERT INTO account (workspace_id,id) VALUES (?,?)").run(workspaceId, accountId);
      database.prepare(
        "INSERT INTO authentication(workspace_id,account_id,category,key_id,serialized_value) VALUES (?,?,'fixture','secret','legacy-authentication')",
      ).run(workspaceId, accountId);
    }
  }
  finally
  {
    database.close();
  }
}

test("SQLite migration refuses a legacy mixed-workspace file without splitting or changing its data", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-legacy-mixed-"));
  const filename = join(directory, "legacy.sqlite");
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  try
  {
    await legacyFile(filename, [workspaceId, otherWorkspaceId]);
    await assert.rejects(
      migrateGatewayStorage({ engine: "sqlite", mode: "local", filename, workspaceId }),
      /SQLite file contains data for a different workspace/i,
    );
    const database = new Database(filename, { readonly: true });
    try
    {
      assert.equal(database.prepare<[], RowCount>("SELECT count(*) AS total FROM account").get()?.total, 2);
      assert.equal(
        database.prepare<[], SchemaVersion>("SELECT version FROM schema_version").get()?.version,
        8,
      );
      assert.equal(
        database.prepare("SELECT name FROM sqlite_master WHERE name='workspace_binding'").get(),
        undefined,
      );
    }
    finally
    {
      database.close();
    }
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicitly selected legacy single-workspace file upgrades in place and preserves its accounts", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-legacy-single-"));
  const filename = join(directory, "legacy.sqlite");
  const workspaceId = randomUUID();
  const configuration = { engine: "sqlite", mode: "local", filename, workspaceId };
  try
  {
    await legacyFile(filename, [workspaceId]);
    const previous = new Database(filename, { readonly: true });
    const account = previous.prepare<[], StoredAccount>("SELECT id FROM account").get();
    previous.close();
    assert.ok(account && typeof account.id === "string");
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    try
    {
      assert.equal((await storage.workspace(workspaceId).account(account.id)).workspaceId, workspaceId);
      assert.equal(
        await storage.workspace(workspaceId).readAuthentication(account.id, "fixture", "secret"),
        "legacy-authentication",
      );
    }
    finally
    {
      await storage.close();
    }
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone SQLite layout routes two workspaces and their accounts to separate canonical private files", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-runtime-"));
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const sharedAccountId = randomUUID();
  const secondAccountId = randomUUID();
  const token = randomUUID();
  const restrictedToken = randomUUID();
  const configuration = {
    storage: { engine: "sqlite", mode: "local", directory },
    workspaces: [
      {
        workspaceId: workspaceId.toUpperCase(),
        accounts: [{ accountId: sharedAccountId, enabled: false }, {
          accountId: secondAccountId,
          enabled: false,
        }],
      },
      { workspaceId: otherWorkspaceId, accounts: [{ accountId: sharedAccountId, enabled: false }] },
    ],
    principals: [
      {
        id: "operator",
        httpToken: token,
        grants: [
          { workspaceId, accountIds: [sharedAccountId, secondAccountId] },
          { workspaceId: otherWorkspaceId, accountIds: [sharedAccountId, secondAccountId] },
        ],
      },
      {
        id: "restricted",
        httpToken: restrictedToken,
        grants: [{ workspaceId, accountIds: [sharedAccountId] }],
      },
    ],
    http: { enabled: true, port: 0 },
  };
  const operatorFilename = join(directory, "operator.json");
  await writeFile(operatorFilename, JSON.stringify(configuration), { mode: 0o600 });
  await executeProcess(process.execPath, [compiledCli, "migrate", "--config", operatorFilename]);
  let runtime = new GatewayRuntime(configuration);
  const requestId = randomUUID();
  try
  {
    await runtime.start();
    const filenames = (await readdir(directory)).filter(name => name.endsWith(".sqlite")).sort();
    assert.deepEqual(filenames, [`${workspaceId}.sqlite`, `${otherWorkspaceId}.sqlite`].sort());
    for (const selectedWorkspace of [workspaceId, otherWorkspaceId])
    {
      assert.equal((await stat(join(directory, `${selectedWorkspace}.sqlite`))).mode & 0o077, 0);
      const response = await fetch(`${runtime.origin}/v1/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          apiVersion: "1",
          workspaceId: selectedWorkspace,
          accountId: sharedAccountId,
          requestId,
          type: "presence",
          chatAddress: "200@s.whatsapp.net",
          composing: true,
        }),
      });
      assert.equal(response.status, 202);
      const receipt = GatewayCommandResultSchema.parse(await response.json());
      assert.equal(receipt.workspaceId, selectedWorkspace);
      assert.equal(receipt.state, "PENDING");
    }
    assert.equal(
      (await fetch(`${runtime.origin}/v1/accounts/${otherWorkspaceId}/${sharedAccountId}`, {
        headers: { authorization: `Bearer ${restrictedToken}` },
      })).status,
      403,
    );
    assert.equal(
      (await fetch(`${runtime.origin}/v1/accounts/${otherWorkspaceId}/${secondAccountId}`, {
        headers: { authorization: `Bearer ${token}` },
      })).status,
      404,
    );
    await assert.rejects(
      verifyGatewayRuntimeStorage(configuration.storage, [workspaceId]),
      /locked|exclusive/i,
    );
    await runtime.close();
    await executeProcess(process.execPath, [compiledCli, "verify-storage", "--config", operatorFilename]);
    for (const [selectedWorkspace, expectedAccounts] of [[workspaceId, 2], [otherWorkspaceId, 1]] as const)
    {
      const database = new Database(join(directory, `${selectedWorkspace}.sqlite`), { readonly: true });
      try
      {
        assert.equal(
          database.prepare<[], RowCount>("SELECT count(*) AS total FROM account").get()?.total,
          expectedAccounts,
        );
        assert.equal(
          database.prepare<[string], RowCount>("SELECT count(*) AS total FROM account WHERE workspace_id<>?")
            .get(selectedWorkspace)?.total,
          0,
        );
      }
      finally
      {
        database.close();
      }
    }
    runtime = new GatewayRuntime(configuration);
    await runtime.start();
    for (const selectedWorkspace of [workspaceId, otherWorkspaceId])
    {
      const response = await fetch(
        `${runtime.origin}/v1/accounts/${selectedWorkspace}/${sharedAccountId}/commands/${requestId}`,
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      assert.equal(response.status, 200);
      assert.equal(GatewayCommandResultSchema.parse(await response.json()).state, "PENDING");
    }
  }
  finally
  {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed startup on a later SQLite workspace releases earlier file ownership without migrating the bad file", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-startup-failure-"));
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const storageConfiguration = { engine: "sqlite", mode: "local", directory };
  await migrateGatewayRuntimeStorage(storageConfiguration, [workspaceId]);
  const invalid = join(directory, `${otherWorkspaceId}.sqlite`);
  await writeFile(invalid, "", { mode: 0o600 });
  const runtime = new GatewayRuntime({
    storage: storageConfiguration,
    workspaces: [{ workspaceId }, { workspaceId: otherWorkspaceId }],
    http: { enabled: false },
  });
  try
  {
    await assert.rejects(runtime.start(), /schema|migration/i);
    assert.equal(runtime.ready, false);
    await verifyGatewayRuntimeStorage(storageConfiguration, [workspaceId]);
    const database = new Database(invalid, { readonly: true });
    try
    {
      assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='account'").get(), undefined);
    }
    finally
    {
      database.close();
    }
  }
  finally
  {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local runtimes own distinct workspace files concurrently and drain every account before releasing storage", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-independent-owners-"));
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const accountId = randomUUID();
  const secondAccountId = randomUUID();
  const storageConfiguration = { engine: "sqlite", mode: "local", directory };
  await migrateGatewayRuntimeStorage(storageConfiguration, [workspaceId, otherWorkspaceId]);
  const firstConfiguration = {
    storage: storageConfiguration,
    workspaces: [{
      workspaceId,
      accounts: [{ accountId, enabled: true }, { accountId: secondAccountId, enabled: true }],
    }],
    http: { enabled: false },
  };
  const secondConfiguration = {
    storage: storageConfiguration,
    workspaces: [{ workspaceId: otherWorkspaceId, accounts: [{ accountId, enabled: true }] }],
    http: { enabled: false },
  };
  const stopped: string[] = [];
  const started: string[] = [];
  const first = new GatewayRuntime(firstConfiguration, account =>
  {
    const connection = new ControlledConnection();
    const identity = `${account.workspaceId}:${account.accountId}`;
    started.push(identity);
    connection.stop = async () =>
    {
      stopped.push(identity);
    };
    return connection;
  });
  const second = new GatewayRuntime(secondConfiguration, account =>
  {
    const connection = new ControlledConnection();
    const identity = `${account.workspaceId}:${account.accountId}`;
    started.push(identity);
    connection.stop = async () =>
    {
      stopped.push(identity);
    };
    return connection;
  });
  const competing = new GatewayRuntime(firstConfiguration, () => new ControlledConnection());
  try
  {
    await first.start();
    await second.start();
    assert.equal(started.length, 3);
    await assert.rejects(competing.start(), /locked|exclusive/i);
    assert.equal(first.ready, true);
    assert.equal(second.ready, true);
    await first.close();
    assert.deepEqual(
      stopped.sort(),
      [`${workspaceId}:${accountId}`, `${workspaceId}:${secondAccountId}`].sort(),
    );
    assert.equal(second.ready, true);
    await verifyGatewayRuntimeStorage(storageConfiguration, [workspaceId]);
    await assert.rejects(
      verifyGatewayRuntimeStorage(storageConfiguration, [otherWorkspaceId]),
      /locked|exclusive/i,
    );
    await second.close();
    assert.equal(stopped.length, 3);
    await verifyGatewayRuntimeStorage(storageConfiguration, [workspaceId, otherWorkspaceId]);
  }
  finally
  {
    await competing.close();
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an empty migrated SQLite file cannot be rebound to another workspace", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-empty-binding-"));
  const workspaceId = randomUUID();
  const configuration = {
    engine: "sqlite",
    mode: "local",
    workspaceId,
    filename: join(directory, "empty.sqlite"),
  };
  try
  {
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    await storage.close();
    const conflicting = { ...configuration, workspaceId: randomUUID() };
    await assert.rejects(openGatewayStorage(conflicting), /belongs to a different workspace/i);
    await assert.rejects(migrateGatewayStorage(conflicting), /belongs to a different workspace/i);
    const reopened = await openGatewayStorage(configuration);
    await reopened.close();
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a bound SQLite storage refuses to acquire another workspace's scoped store", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "workspace-foreign-claim-"));
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const configuration = { engine: "sqlite", mode: "local", directory };
  await migrateGatewayRuntimeStorage(configuration, [workspaceId, otherWorkspaceId]);
  const first = await openGatewayStorage(gatewayWorkspaceStorageConfiguration(configuration, workspaceId));
  const second = await openGatewayStorage(
    gatewayWorkspaceStorageConfiguration(configuration, otherWorkspaceId),
  );
  try
  {
    const foreignStore = second.workspace(otherWorkspaceId);
    const account = await foreignStore.createAccount();
    await assert.rejects(first.acquire(foreignStore, account.accountId), /workspace/i);
    assert.equal((await foreignStore.account(account.accountId)).generation, 0);
  }
  finally
  {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
