import {
  type Account,
  AccountScopeSchema,
  type DeliveryObservation,
  type InboundMessage,
  type MediaReference,
  MediaReferenceSchema,
  type OperationResult,
  OperationStateSchema,
  type OutboundMessage,
  type SessionState,
  SessionStateSchema,
} from "@digows/whatsapp-gateway-contracts";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import pino from "pino";
import { z } from "zod";
import { AccountOwnedError } from "../../domain/errors.ts";
import { AccountPacing, type PacingPolicy } from "../../domain/pacing.ts";
import { SendOperation } from "../../domain/send-operation.ts";

interface AccountRow
{
  id: string;
  state: SessionState;
  generation: number;
  native_jid: string | null;
  qr: string | null;
}
interface OperationRow
{
  key: string;
  digest: string;
  native_ids: string[];
  accepted_parts: number;
  state: OperationResult["state"];
}
interface NativeRow
{
  native: string;
}
interface MediaRow
{
  reference: unknown;
}
interface BooleanRow
{
  acquired: boolean;
}
interface AuthenticationRow
{
  serialized_value: string;
}
interface PacingRow
{
  next_send_at: Date;
  started_at: Date;
  last_active_at: Date;
  daily_date: string;
  daily_count: number;
  recent_times: unknown;
}
export interface AuthenticationMutation
{
  readonly category: string;
  readonly keyId: string;
  readonly serializedValue: string | null;
}
function result(row: OperationRow): OperationResult
{
  return {
    key: row.key,
    digest: row.digest,
    nativeIds: z.array(z.string()).parse(row.native_ids),
    acceptedParts: row.accepted_parts,
    state: OperationStateSchema.parse(row.state),
  };
}
export class AccountLease
{
  alive = true;
  private releasing: Promise<void> | undefined;
  onLost: (() => void) | undefined;
  constructor(readonly accountId: string, readonly generation: number, readonly connection: pg.Client)
  {
    const lost = (): void =>
    {
      if (!this.alive) return;
      this.alive = false;
      this.onLost?.();
    };
    connection.on("error", lost);
    connection.on("end", lost);
  }
  async release(): Promise<void>
  {
    this.alive = false;
    this.releasing ??= this.connection.end();
    await this.releasing;
  }
}
export class PostgresGatewayStore
{
  private readonly pool: pg.Pool;
  constructor(private readonly url: string, readonly workspaceId: string)
  {
    z.uuid().parse(workspaceId);
    this.pool = new pg.Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 10000,
    });
    this.pool.on("error", () =>
    {
      pino().error({ event: "gateway_database_idle_connection_failed" });
    });
  }
  async transaction<Result>(work: (client: pg.PoolClient) => Promise<Result>): Promise<Result>
  {
    const client = await this.pool.connect();
    try
    {
      await client.query("BEGIN");
      await client.query("SELECT set_config('gateway.workspace_id',$1,true)", [this.workspaceId]);
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    }
    catch (error)
    {
      await client.query("ROLLBACK");
      throw error;
    }
    finally
    {
      client.release();
    }
  }
  async createAccount(accountId = randomUUID()): Promise<Account>
  {
    AccountScopeSchema.parse({ workspaceId: this.workspaceId, accountId });
    await this.transaction(async client =>
    {
      await client.query(
        "INSERT INTO gateway.account(workspace_id,id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [this.workspaceId, accountId],
      );
      await client.query(
        "INSERT INTO gateway.pacing(workspace_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [this.workspaceId, accountId],
      );
    });
    return this.account(accountId);
  }
  async account(accountId: string): Promise<Account>
  {
    return this.transaction(async client =>
    {
      const row =
        (await client.query<AccountRow>("SELECT * FROM gateway.account WHERE workspace_id=$1 AND id=$2", [
          this.workspaceId,
          accountId,
        ])).rows[0];
      if (!row) throw new Error("Account unavailable");
      return {
        workspaceId: this.workspaceId,
        accountId: row.id,
        state: SessionStateSchema.parse(row.state),
        generation: row.generation,
        nativeJid: row.native_jid,
        qr: row.qr,
      };
    });
  }
  async accounts(): Promise<readonly Account[]>
  {
    const ids = await this.transaction(async client =>
      (await client.query<AccountRow>("SELECT * FROM gateway.account WHERE workspace_id=$1 ORDER BY id", [
        this.workspaceId,
      ])).rows.map(row => row.id)
    );
    return Promise.all(ids.map(id => this.account(id)));
  }
  async recordReceipt(lease: AccountLease, observation: DeliveryObservation): Promise<void>
  {
    await this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      await client.query(
        "INSERT INTO gateway.delivery(workspace_id,account_id,message_id,status,chat_address) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          this.workspaceId,
          lease.accountId,
          observation.channelMessageId,
          observation.status,
          observation.chatAddress,
        ],
      );
    });
  }
  async receipts(accountId: string, messageId: string): Promise<readonly DeliveryObservation[]>
  {
    return this.transaction(async client =>
      (await client.query(
        "SELECT message_id,status,chat_address FROM gateway.delivery WHERE workspace_id=$1 AND account_id=$2 AND message_id=$3 ORDER BY observed_at",
        [this.workspaceId, accountId, messageId],
      )).rows.map(row => ({
        channelMessageId: String(row.message_id),
        status: String(row.status),
        chatAddress: row.chat_address === null ? null : String(row.chat_address),
      }))
    );
  }
  async acquire(accountId: string): Promise<AccountLease>
  {
    await this.account(accountId);
    const connection = new pg.Client({
      connectionString: this.url,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 10000,
    });
    let lost = false;
    connection.on("error", () =>
    {
      lost = true;
    });
    connection.on("end", () =>
    {
      lost = true;
    });
    try
    {
      await connection.connect();
      const acquired =
        (await connection.query<BooleanRow>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) acquired", [
          `${this.workspaceId}:${accountId}`,
        ])).rows[0]?.acquired;
      if (!acquired) throw new AccountOwnedError();
      const generation = await this.transaction(async client =>
      {
        const row = (await client.query<AccountRow>(
          "UPDATE gateway.account SET generation=generation+1 WHERE workspace_id=$1 AND id=$2 RETURNING *",
          [this.workspaceId, accountId],
        )).rows[0];
        if (!row) throw new Error("Account unavailable");
        await client.query(
          "UPDATE gateway.operation SET state='UNKNOWN' WHERE workspace_id=$1 AND account_id=$2 AND state='IN_FLIGHT'",
          [this.workspaceId, accountId],
        );
        return row.generation;
      });
      if (lost) throw new Error("Account ownership lost during acquisition");
      return new AccountLease(accountId, generation, connection);
    }
    catch (error)
    {
      await connection.end();
      throw error;
    }
  }
  async assertOwnership(client: pg.PoolClient, lease: AccountLease): Promise<void>
  {
    if (!lease.alive) throw new Error("Account ownership lost");
    const rows = await client.query(
      "SELECT id FROM gateway.account WHERE workspace_id=$1 AND id=$2 AND generation=$3 FOR UPDATE",
      [this.workspaceId, lease.accountId, lease.generation],
    );
    if (rows.rowCount !== 1) throw new Error("Account ownership changed");
  }
  async setState(lease: AccountLease, state: SessionState, nativeJid?: string, qr?: string): Promise<void>
  {
    await this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      await client.query(
        "UPDATE gateway.account SET state=$3,native_jid=coalesce($4,native_jid),qr=$5 WHERE workspace_id=$1 AND id=$2",
        [this.workspaceId, lease.accountId, state, nativeJid ?? null, qr ?? null],
      );
    });
  }
  async reserve(lease: AccountLease, message: OutboundMessage, count: number): Promise<SendOperation>
  {
    const digest = createHash("sha256").update(canonical(message)).digest("hex");
    return this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      const ids = Array.from({ length: count }, () => randomUUID().replaceAll("-", "").toUpperCase());
      await client.query(
        "INSERT INTO gateway.operation(workspace_id,account_id,key,digest,native_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [this.workspaceId, lease.accountId, message.idempotencyKey, digest, JSON.stringify(ids)],
      );
      const row = (await client.query<OperationRow>(
        "SELECT * FROM gateway.operation WHERE workspace_id=$1 AND account_id=$2 AND key=$3 FOR UPDATE",
        [this.workspaceId, lease.accountId, message.idempotencyKey],
      )).rows[0];
      if (!row) throw new Error("Operation unavailable");
      if (row.digest !== digest) throw new Error("Operation key has a different payload");
      if (row.state === "IN_FLIGHT")
      {
        await client.query(
          "UPDATE gateway.operation SET state='UNKNOWN' WHERE workspace_id=$1 AND account_id=$2 AND key=$3",
          [this.workspaceId, lease.accountId, message.idempotencyKey],
        );
        row.state = "UNKNOWN";
      }
      return SendOperation.restore(result(row));
    });
  }
  async save(lease: AccountLease, operation: SendOperation): Promise<void>
  {
    await this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      const updated = await client.query(
        "UPDATE gateway.operation SET state=$4,accepted_parts=$5 WHERE workspace_id=$1 AND account_id=$2 AND key=$3 AND (state NOT IN ('ACCEPTED','UNKNOWN','FAILED') OR (state=$4 AND accepted_parts=$5))",
        [this.workspaceId, lease.accountId, operation.key, operation.state, operation.acceptedParts],
      );
      if (updated.rowCount !== 1) throw new Error("Operation terminal state cannot be overwritten");
    });
  }
  async operation(accountId: string, key: string): Promise<OperationResult>
  {
    return this.transaction(async client =>
    {
      const row = (await client.query<OperationRow>(
        "SELECT * FROM gateway.operation WHERE workspace_id=$1 AND account_id=$2 AND key=$3",
        [this.workspaceId, accountId, key],
      )).rows[0];
      if (!row) throw new Error("Operation unavailable");
      return result(row);
    });
  }
  async readAuthentication(accountId: string, category: string, keyId: string): Promise<string | null>
  {
    return this.transaction(async client =>
      (await client.query<AuthenticationRow>(
        "SELECT serialized_value FROM gateway.authentication WHERE workspace_id=$1 AND account_id=$2 AND category=$3 AND key_id=$4",
        [this.workspaceId, accountId, category, keyId],
      )).rows[0]?.serialized_value ?? null
    );
  }
  async writeAuthentication(lease: AccountLease, mutations: readonly AuthenticationMutation[]): Promise<void>
  {
    await this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      for (const mutation of mutations)
      {
        if (mutation.serializedValue === null)
        {
          await client.query(
            "DELETE FROM gateway.authentication WHERE workspace_id=$1 AND account_id=$2 AND category=$3 AND key_id=$4",
            [this.workspaceId, lease.accountId, mutation.category, mutation.keyId],
          );
        }
        else
        {
          await client.query(
            "INSERT INTO gateway.authentication VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,account_id,category,key_id) DO UPDATE SET serialized_value=excluded.serialized_value",
            [this.workspaceId, lease.accountId, mutation.category, mutation.keyId, mutation.serializedValue],
          );
        }
      }
    });
  }
  async clearAuthentication(lease: AccountLease): Promise<void>
  {
    await this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      await client.query("DELETE FROM gateway.authentication WHERE workspace_id=$1 AND account_id=$2", [
        this.workspaceId,
        lease.accountId,
      ]);
    });
  }
  async retain(lease: AccountLease, message: InboundMessage, native: string): Promise<void>
  {
    const id = createHash("sha256").update(canonical(message)).digest("hex");
    await this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      await client.query(
        "INSERT INTO gateway.event(workspace_id,account_id,id,message,native) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [this.workspaceId, lease.accountId, id, JSON.stringify(message), native],
      );
    });
  }
  async retainFailure(lease: AccountLease, native: string, errorName: string): Promise<void>
  {
    const id = "normalization-failed:" + createHash("sha256").update(native).digest("hex");
    await this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      await client.query(
        "INSERT INTO gateway.event(workspace_id,account_id,id,message,native,kind,error_name) VALUES($1,$2,$3,NULL,$4,'NORMALIZATION_FAILED',$5) ON CONFLICT DO NOTHING",
        [this.workspaceId, lease.accountId, id, native, errorName],
      );
    });
  }
  async native(accountId: string, messageId: string): Promise<string>
  {
    return this.transaction(async client =>
    {
      const row = (await client.query<NativeRow>(
        "SELECT native FROM gateway.event WHERE workspace_id=$1 AND account_id=$2 AND message->>'channelMessageId'=$3 ORDER BY created_at DESC LIMIT 1",
        [this.workspaceId, accountId, messageId],
      )).rows[0];
      if (!row) throw new Error("Native media source unavailable");
      return row.native;
    });
  }
  async hasSent(accountId: string, id: string): Promise<boolean>
  {
    return this.transaction(async client =>
      (await client.query(
        "SELECT key FROM gateway.operation WHERE workspace_id=$1 AND account_id=$2 AND native_ids @> $3::jsonb",
        [this.workspaceId, accountId, JSON.stringify([id])],
      )).rowCount !== 0
    );
  }
  async materialized(accountId: string, sourceId: string): Promise<MediaReference | null>
  {
    return this.transaction(async client =>
    {
      const row = (await client.query<MediaRow>(
        "SELECT reference FROM gateway.media WHERE workspace_id=$1 AND account_id=$2 AND source_id=$3",
        [this.workspaceId, accountId, sourceId],
      )).rows[0];
      return row ? MediaReferenceSchema.parse(row.reference) : null;
    });
  }
  async materialize(
    accountId: string,
    sourceId: string,
    work: () => Promise<MediaReference>,
  ): Promise<MediaReference>
  {
    return this.transaction(async client =>
    {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${this.workspaceId}:${accountId}:${sourceId}`,
      ]);
      const row = (await client.query<MediaRow>(
        "SELECT reference FROM gateway.media WHERE workspace_id=$1 AND account_id=$2 AND source_id=$3",
        [this.workspaceId, accountId, sourceId],
      )).rows[0];
      if (row) return MediaReferenceSchema.parse(row.reference);
      const reference = await work();
      await client.query("INSERT INTO gateway.media VALUES($1,$2,$3,$4)", [
        this.workspaceId,
        accountId,
        sourceId,
        JSON.stringify(reference),
      ]);
      return reference;
    });
  }
  async pace(lease: AccountLease, policy: PacingPolicy): Promise<number>
  {
    return this.transaction(async client =>
    {
      await this.assertOwnership(client, lease);
      const row = (await client.query<PacingRow>(
        "SELECT *,daily_date::text FROM gateway.pacing WHERE workspace_id=$1 AND account_id=$2 FOR UPDATE",
        [this.workspaceId, lease.accountId],
      )).rows[0];
      if (!row) throw new Error("Pacing state unavailable");
      const now = Date.now();
      const pacing = new AccountPacing({
        nextSendAt: row.next_send_at.getTime(),
        startedAt: row.started_at.getTime(),
        lastActiveAt: row.last_active_at.getTime(),
        dailyDate: row.daily_date,
        dailyCount: row.daily_count,
        recentTimes: z.array(z.number().finite()).parse(row.recent_times),
      }, policy).reserve(now);
      await client.query(
        "UPDATE gateway.pacing SET next_send_at=$3,started_at=$4,last_active_at=$5,daily_date=$6,daily_count=$7,recent_times=$8 WHERE workspace_id=$1 AND account_id=$2",
        [
          this.workspaceId,
          lease.accountId,
          new Date(pacing.nextSendAt),
          new Date(pacing.startedAt),
          new Date(pacing.lastActiveAt),
          pacing.dailyDate,
          pacing.dailyCount,
          JSON.stringify(pacing.recentTimes),
        ],
      );
      return Math.max(0, (pacing.recentTimes.at(-1) ?? now) - now);
    });
  }
  async close(): Promise<void>
  {
    await this.pool.end();
  }
}
function canonical(value: unknown): string
{
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
  {
    return `{${
      Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      ).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
