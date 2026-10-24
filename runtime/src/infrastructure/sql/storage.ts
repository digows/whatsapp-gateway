import Database from "better-sqlite3";
import { Kysely, PostgresDialect, sql, SqliteDialect } from "kysely";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import pg from "pg";
import pino, { type Logger } from "pino";
import { z } from "zod";
import { AccountOwnedError } from "../../domain/errors.ts";
import { AccountLease } from "../../domain/gateway-store.ts";
import { SqlGatewayStore } from "./gateway-store.ts";
import type { GatewayTables } from "./tables.ts";

const SqliteConfigurationSchema = z.strictObject({
  engine: z.literal("sqlite"),
  filename: z.string().min(1),
  mode: z.enum(["local", "cluster"]),
}).refine(value => value.mode === "local", "SQLite supports local mode only");
const PostgresConfigurationSchema = z.strictObject({
  engine: z.literal("postgresql"),
  url: z.string().min(1),
  mode: z.enum(["local", "cluster"]),
});
export const StorageConfigurationSchema = z.discriminatedUnion("engine", [
  SqliteConfigurationSchema,
  PostgresConfigurationSchema,
]);
export type StorageConfiguration = z.infer<typeof StorageConfigurationSchema>;
export type StorageEngine = StorageConfiguration["engine"];
interface LockResult
{
  acquired: boolean;
}
interface ServerVersion
{
  server_version_num: string;
}
interface PostgresRole
{
  rolsuper: boolean;
  rolbypassrls: boolean;
}
interface RlsTable
{
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}
interface WorkspacePolicy
{
  tablename: string;
  qual: string;
  with_check: string;
}
interface SqliteVersion
{
  version: string;
}
interface SqliteForeignKeys
{
  foreign_keys: number;
}
const tenantTables = [
  "account",
  "authentication",
  "operation",
  "event",
  "media",
  "pacing",
  "delivery",
  "command",
  "runtime",
  "desired_account",
  "public_event",
  "webhook_destination",
  "webhook_delivery",
  "stream_receipt",
  "stream_cursor",
  "message_snapshot",
];
const schemaVersion = 8;

export class GatewayStorage
{
  readonly database: Kysely<GatewayTables>;
  readonly engine: StorageEngine;
  private readonly leases = new Map<string, AccountLease | null>();
  private closing: Promise<void> | undefined;
  private readonly acquisitions = new Set<Promise<AccountLease>>();
  constructor(readonly configuration: StorageConfiguration, private readonly logger: Logger = pino())
  {
    this.engine = configuration.engine;
    if (configuration.engine === "postgresql")
    {
      const pool = new pg.Pool({
        connectionString: configuration.url,
        max: 8,
        connectionTimeoutMillis: 5000,
        query_timeout: 10000,
        statement_timeout: 10000,
      });
      pool.on("error", () =>
      {
        this.logger.error({ event: "gateway_database_idle_connection_failed" });
      });
      this.database = new Kysely<GatewayTables>({ dialect: new PostgresDialect({ pool }) }).withSchema(
        "gateway",
      );
    }
    else
    {
      if (configuration.filename === ":memory:")
      {
        throw new Error("Durable SQLite storage requires a local file");
      }
      ensurePrivateFile(configuration.filename);
      const sqlite = new Database(configuration.filename, { timeout: 1000 });
      try
      {
        sqlite.pragma("foreign_keys = ON");
        sqlite.pragma("locking_mode = EXCLUSIVE");
        sqlite.pragma("journal_mode = WAL");
        // Retain the OS-backed exclusive file lock for this runtime's connection lifetime.
        sqlite.exec("BEGIN EXCLUSIVE; COMMIT;");
        this.database = new Kysely<GatewayTables>({ dialect: new SqliteDialect({ database: sqlite }) });
      }
      catch (error)
      {
        sqlite.close();
        throw error;
      }
    }
  }
  workspace(workspaceId: string): SqlGatewayStore
  {
    if (this.closing) throw new Error("Storage is closed");
    return new SqlGatewayStore(this, workspaceId);
  }
  async verify(): Promise<void>
  {
    if (this.engine === "postgresql")
    {
      const version = (await sql<ServerVersion>`SHOW server_version_num`.execute(this.database)).rows[0];
      if (
        !version || Number(version.server_version_num) < 180000
        || Number(version.server_version_num) >= 190000
      ) throw new Error("Qualified PostgreSQL storage requires PostgreSQL 18");
      const role =
        (await sql<PostgresRole>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`
          .execute(this.database)).rows[0];
      if (!role || role.rolsuper || role.rolbypassrls)
      {
        throw new Error("Runtime storage role must enforce RLS without superuser/BYPASSRLS");
      }
      const rows = (await sql<
        RlsTable
      >`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gateway' AND c.relkind='r'`
        .execute(this.database)).rows;
      if (
        !tenantTables.every(name =>
          rows.some(row => row.relname === name && row.relrowsecurity && row.relforcerowsecurity)
        )
      )
      {
        throw new Error(
          "Gateway schema requires forced workspace RLS on every tenant table; apply migrations",
        );
      }
      const policies = (await sql<
        WorkspacePolicy
      >`SELECT tablename,qual,with_check FROM pg_policies WHERE schemaname='gateway'`.execute(
        this.database,
      )).rows;
      const expected =
        "(workspace_id = (NULLIF(current_setting('gateway.workspace_id'::text, true), ''::text))::uuid)";
      if (
        !tenantTables.every(name =>
        {
          const actual = policies.filter(policy => policy.tablename === name);
          return actual.length === 1 && actual[0]?.qual === expected && actual[0]?.with_check === expected;
        })
      ) throw new Error("Gateway workspace RLS policies do not match the qualified schema");
    }
    else
    {
      const version =
        (await sql<SqliteVersion>`SELECT sqlite_version() version`.execute(this.database)).rows[0];
      if (!version || compareVersion(version.version, "3.35.0") < 0)
      {
        throw new Error("SQLite RETURNING capability requires version 3.35 or newer");
      }
      const foreignKeys = (await sql<SqliteForeignKeys>`PRAGMA foreign_keys`.execute(this.database)).rows[0];
      if (foreignKeys?.foreign_keys !== 1) throw new Error("SQLite foreign key enforcement is required");
      await sql`SELECT json_valid('[]')`.execute(this.database);
      if ((await sql`PRAGMA foreign_key_check`.execute(this.database)).rows.length)
      {
        throw new Error("SQLite foreign key integrity check failed");
      }
    }
    try
    {
      const versions = await this.database.selectFrom("schema_version").selectAll().execute();
      if (versions.length !== 1 || versions[0]?.version !== schemaVersion)
      {
        throw new Error("Unsupported gateway schema version; apply migrations explicitly");
      }
      // Verify actual required columns, not only a user-editable version marker.
      await this.database.selectFrom("account").select([
        "workspace_id",
        "id",
        "state",
        "generation",
        "native_jid",
        "qr",
      ]).limit(0).execute();
      await this.database.selectFrom("authentication").select([
        "workspace_id",
        "account_id",
        "category",
        "key_id",
        "serialized_value",
      ]).limit(0).execute();
      await this.database.selectFrom("operation").select([
        "workspace_id",
        "account_id",
        "key",
        "digest",
        "native_ids",
        "accepted_parts",
        "state",
      ]).limit(0).execute();
      await this.database.selectFrom("event").select([
        "workspace_id",
        "account_id",
        "id",
        "message",
        "native",
        "kind",
        "error_name",
        "created_at",
      ]).limit(0).execute();
      await this.database.selectFrom("media").select(["workspace_id", "account_id", "source_id", "reference"])
        .limit(0).execute();
      await this.database.selectFrom("pacing").select([
        "workspace_id",
        "account_id",
        "next_send_at",
        "started_at",
        "last_active_at",
        "recent_times",
        "daily_date",
        "daily_count",
      ]).limit(0).execute();
      await this.database.selectFrom("delivery").select([
        "workspace_id",
        "account_id",
        "message_id",
        "status",
        "chat_address",
        "observed_at",
      ]).limit(0).execute();
      await this.database.selectFrom("command").select([
        "workspace_id",
        "account_id",
        "request_id",
        "sequence",
        "digest",
        "command",
        "state",
        "response",
        "failure",
        "claim_token",
        "generation",
        "created_at",
      ]).limit(0).execute();
      await this.database.selectFrom("runtime").select([
        "workspace_id",
        "id",
        "capacity",
        "draining",
        "expires_at",
      ]).limit(0).execute();
      await this.database.selectFrom("desired_account").select([
        "workspace_id",
        "account_id",
        "revision",
        "enabled",
        "assigned_runtime_id",
        "attempted_revision",
        "blocked_revision",
      ]).limit(0).execute();
      await this.database.selectFrom("public_event").select([
        "workspace_id",
        "account_id",
        "id",
        "sequence",
        "envelope",
        "created_at",
      ]).limit(0).execute();
      await this.database.selectFrom("webhook_destination").select([
        "workspace_id",
        "account_id",
        "id",
        "url",
        "secret",
        "enabled",
        "delivery_lifetime_ms",
      ]).limit(0).execute();
      await this.database.selectFrom("webhook_delivery").select([
        "workspace_id",
        "account_id",
        "destination_id",
        "event_id",
        "event_sequence",
        "body",
        "state",
        "attempts",
        "next_attempt_at",
        "expires_at",
        "terminal_at",
        "claim_token",
        "lease_until",
        "last_status",
        "failure",
      ]).limit(0).execute();
      await this.database.selectFrom("stream_receipt").select([
        "workspace_id",
        "account_id",
        "source_stream",
        "source_message_id",
        "digest",
        "receipt",
      ]).limit(0).execute();
      await this.database.selectFrom("stream_cursor").select([
        "workspace_id",
        "account_id",
        "stream_name",
        "kind",
        "position",
        "claim_token",
        "claimed_sequence",
        "lease_until",
      ]).limit(0).execute();
      await this.database.selectFrom("message_snapshot").select([
        "workspace_id",
        "account_id",
        "chat_address",
        "message_id",
        "sender_address",
        "position",
        "direction",
        "message",
        "native",
        "occurred_at",
        "observed_at",
        "timestamp_source",
        "edited",
        "deleted",
      ]).limit(0).execute();
    }
    catch (error)
    {
      throw new Error("Gateway schema is incompatible; apply the selected backend's migrations", {
        cause: error,
      });
    }
  }
  owns(lease: AccountLease): boolean
  {
    return lease.alive && this.leases.get(`${lease.workspaceId}:${lease.accountId}`) === lease;
  }
  async acquire(store: SqlGatewayStore, accountId: string): Promise<AccountLease>
  {
    if (this.closing) throw new Error("Storage is closed");
    const acquisition = this.acquireResource(store, accountId);
    this.acquisitions.add(acquisition);
    try
    {
      return await acquisition;
    }
    finally
    {
      this.acquisitions.delete(acquisition);
    }
  }
  private async acquireResource(store: SqlGatewayStore, accountId: string): Promise<AccountLease>
  {
    if (this.closing) throw new Error("Storage is closed");
    const identity = `${store.workspaceId}:${accountId}`;
    if (this.leases.has(identity)) throw new AccountOwnedError();
    this.leases.set(identity, null);
    let connection: pg.Client | undefined;
    let lease: AccountLease | undefined;
    let lost = false;
    try
    {
      if (this.configuration.engine === "postgresql")
      {
        connection = new pg.Client({
          connectionString: this.configuration.url,
          connectionTimeoutMillis: 5000,
          query_timeout: 10000,
          statement_timeout: 10000,
        });
        const invalidate = (): void =>
        {
          lost = true;
          lease?.lose();
        };
        connection.on("error", invalidate);
        connection.on("end", invalidate);
        await connection.connect();
        if (
          !(await connection.query<LockResult>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) acquired",
            [identity],
          )).rows[0]?.acquired
        ) throw new AccountOwnedError();
      }
      const generation = await store.advanceGeneration(accountId);
      if (lost || this.closing) throw new Error("Account ownership lost during acquisition");
      const resource = connection;
      lease = new AccountLease(store.workspaceId, accountId, generation, async () =>
      {
        try
        {
          await resource?.end();
        }
        finally
        {
          if (this.leases.get(identity) === lease) this.leases.delete(identity);
        }
      });
      this.leases.set(identity, lease);
      return lease;
    }
    catch (error)
    {
      try
      {
        await connection?.end();
      }
      finally
      {
        this.leases.delete(identity);
      }
      throw error;
    }
  }
  async close(): Promise<void>
  {
    this.closing ??= (async () =>
    {
      await Promise.allSettled([...this.acquisitions]);
      const results = await Promise.allSettled([...this.leases.values()].map(async lease =>
      {
        lease?.lose();
        await lease?.release();
      }));
      await this.database.destroy();
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures, "Storage ownership cleanup failed");
    })();
    await this.closing;
  }
}
export async function openGatewayStorage(input: unknown, logger: Logger = pino()): Promise<GatewayStorage>
{
  const storage = new GatewayStorage(StorageConfigurationSchema.parse(input), logger);
  try
  {
    await storage.verify();
    return storage;
  }
  catch (error)
  {
    await storage.close();
    throw error;
  }
}
export async function migrateGatewayStorage(input: unknown): Promise<void>
{
  const configuration = StorageConfigurationSchema.parse(input);
  if (configuration.engine === "sqlite")
  {
    if (configuration.filename === ":memory:")
    {
      throw new Error("Durable SQLite storage requires a local file");
    }
    ensurePrivateFile(configuration.filename);
    const database = new Database(configuration.filename, { timeout: 1000 });
    try
    {
      database.pragma("foreign_keys = ON");
      database.pragma("locking_mode = EXCLUSIVE");
      const exists = database.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
      ).get();
      if (!exists)
      {
        database.exec(
          await readFile(new URL("../../../migrations/sqlite/001_gateway_core.sql", import.meta.url), "utf8"),
        );
      }
      const current: unknown = database.prepare("SELECT version FROM schema_version").get();
      if (z.object({ version: z.literal(2) }).safeParse(current).success)
      {
        database.exec(
          await readFile(
            new URL("../../../migrations/sqlite/002_command_ingress.sql", import.meta.url),
            "utf8",
          ),
        );
      }
      const placementVersion: unknown = database.prepare("SELECT version FROM schema_version").get();
      if (z.object({ version: z.literal(3) }).safeParse(placementVersion).success)
      {
        database.exec(
          await readFile(
            new URL("../../../migrations/sqlite/003_runtime_placement.sql", import.meta.url),
            "utf8",
          ),
        );
      }
      const eventsVersion: unknown = database.prepare("SELECT version FROM schema_version").get();
      if (z.object({ version: z.literal(4) }).safeParse(eventsVersion).success)
      {
        database.exec(
          await readFile(
            new URL("../../../migrations/sqlite/004_public_events.sql", import.meta.url),
            "utf8",
          ),
        );
      }
      const webhookVersion: unknown = database.prepare("SELECT version FROM schema_version").get();
      if (z.object({ version: z.literal(5) }).safeParse(webhookVersion).success)
      {
        database.exec(
          await readFile(
            new URL("../../../migrations/sqlite/005_webhook_outbox.sql", import.meta.url),
            "utf8",
          ),
        );
      }
      const streamsVersion: unknown = database.prepare("SELECT version FROM schema_version").get();
      if (z.object({ version: z.literal(6) }).safeParse(streamsVersion).success)
      {
        database.exec(
          await readFile(
            new URL("../../../migrations/sqlite/006_redis_streams.sql", import.meta.url),
            "utf8",
          ),
        );
      }
      const historyVersion: unknown = database.prepare("SELECT version FROM schema_version").get();
      if (z.object({ version: z.literal(7) }).safeParse(historyVersion).success)
      {
        database.exec(
          await readFile(
            new URL("../../../migrations/sqlite/007_message_history.sql", import.meta.url),
            "utf8",
          ),
        );
      }
      const row: unknown = database.prepare("SELECT version FROM schema_version").get();
      if (z.object({ version: z.literal(schemaVersion) }).safeParse(row).success === false)
      {
        throw new Error("Unsupported SQLite schema version");
      }
    }
    finally
    {
      database.close();
    }
    return;
  }
  const connection = new pg.Client({ connectionString: configuration.url });
  try
  {
    await connection.connect();
    await connection.query("SELECT pg_advisory_lock(hashtextextended('gateway:migrations',0))");
    const existing = await connection.query("SELECT to_regclass('gateway.account') existing");
    if (!existing.rows[0]?.existing)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/001_gateway_core.sql", import.meta.url), "utf8"),
      );
    }
    const marker = await connection.query("SELECT to_regclass('gateway.schema_version') existing");
    if (!marker.rows[0]?.existing)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/002_storage_version.sql", import.meta.url), "utf8"),
      );
    }
    const current = await connection.query("SELECT version FROM gateway.schema_version");
    if (current.rows.length === 1 && current.rows[0]?.version === 2)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/003_command_ingress.sql", import.meta.url), "utf8"),
      );
    }
    const placementVersion = await connection.query("SELECT version FROM gateway.schema_version");
    if (placementVersion.rows.length === 1 && placementVersion.rows[0]?.version === 3)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/004_runtime_placement.sql", import.meta.url), "utf8"),
      );
    }
    const eventsVersion = await connection.query("SELECT version FROM gateway.schema_version");
    if (eventsVersion.rows.length === 1 && eventsVersion.rows[0]?.version === 4)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/005_public_events.sql", import.meta.url), "utf8"),
      );
    }
    const webhookVersion = await connection.query("SELECT version FROM gateway.schema_version");
    if (webhookVersion.rows.length === 1 && webhookVersion.rows[0]?.version === 5)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/006_webhook_outbox.sql", import.meta.url), "utf8"),
      );
    }
    const streamsVersion = await connection.query("SELECT version FROM gateway.schema_version");
    if (streamsVersion.rows.length === 1 && streamsVersion.rows[0]?.version === 6)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/007_redis_streams.sql", import.meta.url), "utf8"),
      );
    }
    const historyVersion = await connection.query("SELECT version FROM gateway.schema_version");
    if (historyVersion.rows.length === 1 && historyVersion.rows[0]?.version === 7)
    {
      await connection.query(
        await readFile(new URL("../../../migrations/008_message_history.sql", import.meta.url), "utf8"),
      );
    }
    const version = await connection.query("SELECT version FROM gateway.schema_version");
    if (version.rows.length !== 1 || version.rows[0]?.version !== schemaVersion)
    {
      throw new Error("Unsupported PostgreSQL schema version");
    }
  }
  finally
  {
    await connection.end();
  }
}
function compareVersion(left: string, right: string): number
{
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index++)
  {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function ensurePrivateFile(filename: string): void
{
  const descriptor = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try
  {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    {
      throw new Error("SQLite authentication storage requires a private regular file (0600)");
    }
  }
  finally
  {
    closeSync(descriptor);
  }
}
