import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { Gateway } from "../src/application/gateway.ts";
import { BaileysConnection } from "../src/infrastructure/baileys/baileys-connection.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";
import { NativeSocketFixture } from "./support/native-socket.ts";

const executeNode = promisify(execFile);
function runNode(arguments_: readonly string[], options: NodeExecutionOptions)
{
  return executeNode(process.execPath, arguments_, options);
}
interface SQLiteSchemaVersion
{
  readonly version: number;
}
interface NodeExecutionOptions
{
  readonly cwd: string;
  readonly timeout: number;
}
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!temporaryRoot || !postgresUrl) throw new Error("Explicit owned temporary root and database required");

test("storage configuration rejects SQLite cluster mode and unsupported engines before connecting", async () =>
{
  await assert.rejects(
    openGatewayStorage({
      engine: "sqlite",
      filename: ":memory:",
      workspaceId: randomUUID(),
      mode: "cluster",
    }),
    /SQLite.*local/,
  );
  await assert.rejects(openGatewayStorage({ engine: "mysql", url: "unused", mode: "local" }), /engine/);
});

test("SQLite requires a versioned schema and an exclusive local runtime; reopen releases the file", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-storage-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId: randomUUID(),
    filename: join(directory, "gateway.sqlite"),
    mode: "local",
  };
  try
  {
    await assert.rejects(openGatewayStorage(configuration), /migration|schema/i);
    await migrateGatewayStorage(configuration);
    const first = await openGatewayStorage(configuration);
    try
    {
      await assert.rejects(openGatewayStorage(configuration), /locked|exclusive/i);
    }
    finally
    {
      await first.close();
    }
    const reopened = await openGatewayStorage(configuration);
    await reopened.close();
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} real driver isolates workspace/account state and preserves UNKNOWN across restart`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, `gateway-${engine}-`));
    const workspaceId = randomUUID();
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId, filename: join(directory, "gateway.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    let storage = await openMigrated(configuration);
    const otherWorkspaceId = randomUUID();
    const otherStorage = configuration.engine === "sqlite"
      ? await openMigrated({
        ...configuration,
        workspaceId: otherWorkspaceId,
        filename: join(directory, "other.sqlite"),
      })
      : undefined;
    const accountId = randomUUID();
    const otherAccountId = randomUUID();
    const sockets: ControlledConnection[] = [];
    let gateway: Gateway | undefined;
    try
    {
      const store = storage.workspace(workspaceId);
      const other = (otherStorage ?? storage).workspace(otherWorkspaceId);
      await store.createAccount(accountId);
      await store.createAccount(otherAccountId);
      await other.createAccount(accountId);
      gateway = new Gateway(store, () =>
      {
        const socket = new ControlledConnection();
        sockets.push(socket);
        return socket;
      }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
      await gateway.start(accountId);
      await gateway.start(accountId.toUpperCase());
      assert.equal(sockets.length, 1);
      await assert.rejects(store.acquire(accountId.toUpperCase()), /owned/);
      assert.equal(
        (await storage.workspace(workspaceId.toUpperCase()).account(accountId.toUpperCase())).workspaceId,
        workspaceId,
      );
      await assert.rejects(store.acquire(accountId), /owned/);
      const lease = await gateway.ownership(accountId);
      await assert.rejects(other.setState(lease, "FAILED"), /ownership/);
      const message = {
        channel: "WHATSAPP" as const,
        contentKind: "TEXT" as const,
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: "200@s.whatsapp.net",
        idempotencyKey: "persisted",
        text: "unchanged",
      };
      const operation = await store.reserve(lease, message, 1);
      operation.dispatch(0);
      await store.save(lease, operation);
      await assert.rejects(store.operation(otherAccountId, "persisted"), /unavailable/);
      const differentAccount = await store.acquire(otherAccountId);
      try
      {
        await store.reserve(differentAccount, { ...message, text: "different account" }, 1);
        await assert.rejects(store.save(differentAccount, operation), /scope/);
      }
      finally
      {
        await differentAccount.release();
      }

      await assert.rejects(other.operation(accountId, "persisted"), /unavailable/);

      await store.writeAuthentication(lease, [{
        category: "fixture",
        keyId: "secret",
        serializedValue: "private",
      }]);
      assert.equal(await other.readAuthentication(accountId, "fixture", "secret"), null);
      await gateway.close();
      gateway = undefined;
      await storage.close();
      storage = await openGatewayStorage(configuration);
      const restoredStore = storage.workspace(workspaceId);
      gateway = new Gateway(restoredStore, () =>
      {
        const socket = new ControlledConnection();
        sockets.push(socket);
        return socket;
      }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
      await gateway.start(accountId);
      const successor = await gateway.ownership(accountId);
      try
      {
        assert.equal((await restoredStore.operation(accountId, "persisted")).state, "UNKNOWN");
        assert.equal((await gateway.send(accountId, message)).state, "UNKNOWN");
        assert.equal(sockets.at(-1)?.sent.length, 0);
        await assert.rejects(
          restoredStore.reserve(successor, { ...message, text: "changed" }, 1),
          /different payload/,
        );
        await assert.rejects(restoredStore.setState(lease, "CONNECTED"), /ownership/);
        assert.ok(successor.generation > lease.generation);
      }
      finally
      {
        await gateway.stop(accountId);
      }
      assert.equal(sockets[0]?.sent.length, 0);
      assert.equal(
        (await restoredStore.operation(accountId.toUpperCase(), "persisted")).accountId,
        accountId,
      );
    }
    finally
    {
      await gateway?.close();
      await storage.close();
      await otherStorage?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
async function openMigrated(configuration: StorageConfiguration)
{
  await migrateGatewayStorage(configuration);
  return openGatewayStorage(configuration);
}

test("SQLite schema incompatibility is rejected even when the file opens", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-invalid-schema-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId: randomUUID(),
    filename: join(directory, "gateway.sqlite"),
    mode: "local",
  };
  try
  {
    await migrateGatewayStorage(configuration);
    const database = new Database(configuration.filename);
    const original = database.prepare("SELECT version FROM schema_version").get() as SQLiteSchemaVersion;
    database.prepare("UPDATE schema_version SET version=999").run();
    database.close();
    await assert.rejects(openGatewayStorage(configuration), /schema.*incompatible/);
    const changed = new Database(configuration.filename);
    changed.prepare("UPDATE schema_version SET version=?").run(original.version);
    changed.exec("ALTER TABLE account DROP COLUMN qr");
    changed.close();
    await assert.rejects(openGatewayStorage(configuration), /schema.*incompatible/);
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite OS file ownership survives competing processes and releases after a killed owner", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-process-"));
  const workspaceId = randomUUID();
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId,
    filename: join(directory, "gateway.sqlite"),
    mode: "local",
  };
  const accountId = randomUUID();
  const moduleUrl = new URL("../src/infrastructure/sql/storage.ts", import.meta.url).href;
  try
  {
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    try
    {
      await storage.workspace(workspaceId).createAccount(accountId);
      const competing = `import {openGatewayStorage} from ${
        JSON.stringify(moduleUrl)
      }; const storage=await openGatewayStorage(${JSON.stringify(configuration)}); await storage.close();`;
      await assert.rejects(
        runNode(["--import", "tsx", "--input-type=module", "-e", competing], {
          cwd: process.cwd(),
          timeout: 10000,
        }),
        /locked/,
      );
    }
    finally
    {
      await storage.close();
    }
    const message = {
      channel: "WHATSAPP",
      contentKind: "TEXT",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "killed",
      text: "pending effect",
    };
    const killed = `import {openGatewayStorage} from ${
      JSON.stringify(moduleUrl)
    }; const storage=await openGatewayStorage(${
      JSON.stringify(configuration)
    }); const store=storage.workspace(${JSON.stringify(workspaceId)}); const lease=await store.acquire(${
      JSON.stringify(accountId)
    }); const operation=await store.reserve(lease,${
      JSON.stringify(message)
    },1); operation.dispatch(0); await store.save(lease,operation); process.kill(process.pid,'SIGKILL');`;
    await assert.rejects(
      runNode(["--import", "tsx", "--input-type=module", "-e", killed], {
        cwd: process.cwd(),
        timeout: 10000,
      }),
      error => error instanceof Error && "signal" in error && error.signal === "SIGKILL",
    );
    const recovered = await openGatewayStorage(configuration);
    try
    {
      const store = recovered.workspace(workspaceId);
      const lease = await store.acquire(accountId);
      assert.equal((await store.operation(accountId, "killed")).state, "UNKNOWN");
      await lease.release();
    }
    finally
    {
      await recovered.close();
    }
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PostgreSQL startup refuses privileged roles, missing RLS and permissive replacement policies", async () =>
{
  const adminUrl = process.env["GATEWAY_TEST_ADMIN_DATABASE_URL"];
  if (!adminUrl) throw new Error("Explicit owned fixture admin URL required for compatibility tests");
  const name = "gateway_verify_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const isolatedAdminUrl = new URL(adminUrl);
  isolatedAdminUrl.pathname = "/" + name;
  const isolatedRuntimeUrl = new URL(postgresUrl);
  isolatedRuntimeUrl.pathname = "/" + name;
  let isolated: pg.Client | undefined;
  try
  {
    await admin.query(`CREATE DATABASE ${name}`);
    await migrateGatewayStorage({ engine: "postgresql", url: isolatedAdminUrl.toString(), mode: "cluster" });
    await assert.rejects(
      openGatewayStorage({ engine: "postgresql", url: isolatedAdminUrl.toString(), mode: "cluster" }),
      /superuser|BYPASSRLS/,
    );
    isolated = new pg.Client({ connectionString: isolatedAdminUrl.toString() });
    await isolated.connect();
    // Role name comes from the explicitly supplied fixture URL, quoted as an identifier.
    const role = "\"" + decodeURIComponent(isolatedRuntimeUrl.username).replaceAll("\"", "\"\"") + "\"";
    await isolated.query(
      `GRANT USAGE ON SCHEMA gateway TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA gateway TO ${role}`,
    );
    const configuration: StorageConfiguration = {
      engine: "postgresql",
      url: isolatedRuntimeUrl.toString(),
      mode: "cluster",
    };
    const valid = await openGatewayStorage(configuration);
    await valid.close();
    await isolated.query("ALTER TABLE gateway.account DISABLE ROW LEVEL SECURITY");
    await assert.rejects(openGatewayStorage(configuration), /forced workspace RLS/);
    await isolated.query(
      "ALTER TABLE gateway.account ENABLE ROW LEVEL SECURITY; ALTER POLICY workspace_boundary ON gateway.account USING (true) WITH CHECK (true)",
    );
    await assert.rejects(openGatewayStorage(configuration), /RLS policies/);
  }
  finally
  {
    await isolated?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test("SQLite authentication files reject public permissions and symbolic-link aliases", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-private-file-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId: randomUUID(),
    filename: join(directory, "gateway.sqlite"),
    mode: "local",
  };
  try
  {
    await migrateGatewayStorage(configuration);
    await chmod(configuration.filename, 0o644);
    await assert.rejects(openGatewayStorage(configuration), /private regular file/);
    await chmod(configuration.filename, 0o600);
    const alias = join(directory, "alias.sqlite");
    await symlink(configuration.filename, alias);
    await assert.rejects(openGatewayStorage({ ...configuration, filename: alias }), /ELOOP|symbolic link/);
    const storage = await openGatewayStorage(configuration);
    await storage.close();
  }
  finally
  {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite stores real Baileys authentication through 515/restart and replays an accepted send", async () =>
{
  const directory = await mkdtemp(join(temporaryRoot, "gateway-sqlite-native-"));
  const configuration: StorageConfiguration = {
    engine: "sqlite",
    workspaceId: randomUUID(),
    filename: join(directory, "gateway.sqlite"),
    mode: "local",
  };
  await migrateGatewayStorage(configuration);
  const storage = await openGatewayStorage(configuration);
  const store = storage.workspace(
    configuration.engine === "sqlite" ? configuration.workspaceId : randomUUID(),
  );
  const sockets: NativeSocketFixture[] = [];
  const connections: BaileysConnection[] = [];
  const gateway = new Gateway(store, (_account, lease) =>
  {
    const connection = new BaileysConnection(store, lease, null, configuration =>
    {
      const socket = new NativeSocketFixture(configuration);
      sockets.push(socket);
      return socket.socket;
    });
    connections.push(connection);
    return connection;
  }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
  try
  {
    const account = await store.createAccount();
    await gateway.start(account.accountId);
    const first = sockets[0];
    assert.ok(first);
    first.pair();
    first.update("close", 515);
    await connections[0]?.drainEvents();
    assert.equal(sockets.length, 2);
    sockets[1]?.update("open");
    await connections[0]?.drainEvents();
    const message = {
      channel: "WHATSAPP" as const,
      contentKind: "TEXT" as const,
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "sqlite-native",
      text: "one effect",
    };
    const accepted = await gateway.send(account.accountId, message);
    assert.equal(accepted.state, "ACCEPTED");
    assert.deepEqual(await gateway.send(account.accountId, message), accepted);
    await gateway.stop(account.accountId);
    await gateway.restore();
    const restored = sockets.at(-1);
    assert.ok(restored);
    assert.equal(restored.authentication.creds.me?.id, "100@s.whatsapp.net");
    assert.ok(restored.authentication.creds.noiseKey.private instanceof Uint8Array);
    restored.update("open");
    await connections.at(-1)?.drainEvents();
    assert.deepEqual(await gateway.send(account.accountId, message), accepted);
    assert.equal(restored.sent.length, 0);
    assert.equal(sockets[1]?.sent.length, 1);
  }
  finally
  {
    await gateway.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
