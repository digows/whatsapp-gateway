import {
  type Account,
  AccountScopeSchema,
  type DeliveryObservation,
  GatewayIdentifierSchema,
  type InboundMessage,
  type MediaReference,
  MediaReferenceSchema,
  type OperationResult,
  OperationStateSchema,
  type OutboundMessage,
  type SessionState,
} from "@digows/whatsapp-gateway-contracts";
import { type Selectable, sql, type Transaction } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AcceptedOutboundPart } from "../../domain/accepted-outbound-part.ts";
import { GatewayResourceUnavailableError } from "../../domain/errors.ts";
import {
  type AccountLease,
  type AuthenticationMutation,
  type GatewayStore,
} from "../../domain/gateway-store.ts";
import { AccountPacing, type PacingPolicy } from "../../domain/pacing.ts";
import { SendOperation } from "../../domain/send-operation.ts";
import { appendGatewayEvent } from "./event-log.ts";
import { retainAcceptedOutbound, retainSnapshot } from "./history.ts";
import type { GatewayStorage } from "./storage.ts";
import { type AccountTable, type GatewayTables, jsonValue, type OperationTable } from "./tables.ts";
export type GatewayTransaction = Transaction<GatewayTables>;
interface DatabaseClock
{
  now: Date | string;
}
interface ElectionResult
{
  elected: boolean;
}
export class SqlGatewayStore implements GatewayStore
{
  readonly workspaceId: string;
  constructor(protected readonly storage: GatewayStorage, workspaceId: string)
  {
    this.workspaceId = GatewayIdentifierSchema.parse(workspaceId);
  }
  async transaction<Result>(work: (transaction: GatewayTransaction) => Promise<Result>): Promise<Result>
  {
    return this.storage.database.transaction().execute(async transaction =>
    {
      if (this.storage.engine === "postgresql")
      {
        await sql`SELECT set_config('gateway.workspace_id',${this.workspaceId},true)`.execute(transaction);
      }
      return work(transaction);
    });
  }
  async databaseTime(transaction: GatewayTransaction): Promise<Date>
  {
    const clock = this.storage.engine === "postgresql"
      ? await sql<DatabaseClock>`SELECT clock_timestamp() AS now`.execute(transaction)
      : await sql<DatabaseClock>`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now`.execute(transaction);
    const value = clock.rows[0]?.now;
    if (!value) throw new Error("Database clock unavailable");
    return new Date(value);
  }
  async tryCoordinate(transaction: GatewayTransaction): Promise<boolean>
  {
    if (this.storage.engine === "sqlite") return true;
    const result = await sql<ElectionResult>`SELECT pg_try_advisory_xact_lock(hashtextextended(${
      "gateway:coordinator:" + this.workspaceId
    },0)) AS elected`.execute(transaction);
    return result.rows[0]?.elected === true;
  }
  async createAccount(requestedAccountId = randomUUID()): Promise<Account>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    AccountScopeSchema.parse({ workspaceId: this.workspaceId, accountId });
    await this.transaction(async transaction =>
    {
      const created = await transaction.insertInto("account").values({
        workspace_id: this.workspaceId,
        id: accountId,
        native_jid: null,
        qr: null,
      }).onConflict(conflict => conflict.doNothing()).returningAll().executeTakeFirst();
      if (created)
      {
        await appendGatewayEvent(this, transaction, accountId, {
          type: "com.digows.whatsapp.account.updated.v1",
          data: this.scopedAccount(created),
        });
      }
      const now = new Date().toISOString();
      await transaction.insertInto("pacing").values({
        workspace_id: this.workspaceId,
        account_id: accountId,
        next_send_at: now,
        started_at: now,
        last_active_at: now,
        recent_times: "[]",
        daily_date: now.slice(0, 10),
        daily_count: 0,
      }).onConflict(conflict => conflict.doNothing()).execute();
    });
    return this.account(accountId);
  }
  private scopedAccount(row: Selectable<AccountTable>): Account
  {
    return {
      workspaceId: this.workspaceId,
      accountId: row.id,
      state: row.state,
      generation: row.generation,
      nativeJid: row.native_jid,
      qr: row.qr,
    };
  }
  async account(requestedAccountId: string): Promise<Account>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
    {
      const row = await transaction.selectFrom("account").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("id", "=", accountId).executeTakeFirst();
      if (!row) throw new GatewayResourceUnavailableError("Account unavailable");
      return this.scopedAccount(row);
    });
  }
  async accounts(): Promise<readonly Account[]>
  {
    return this.transaction(async transaction =>
      (await transaction.selectFrom("account").selectAll().where("workspace_id", "=", this.workspaceId)
        .orderBy("id").execute()).map(row => this.scopedAccount(row))
    );
  }
  async acquire(requestedAccountId: string): Promise<AccountLease>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    await this.account(accountId);
    return this.storage.acquire(this, accountId);
  }
  async advanceGeneration(requestedAccountId: string): Promise<number>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
    {
      const row = await transaction.updateTable("account").set({ generation: sql`generation+1` }).where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("id", "=", accountId).returningAll().executeTakeFirst();
      if (!row) throw new GatewayResourceUnavailableError("Account unavailable");
      await appendGatewayEvent(this, transaction, accountId, {
        type: "com.digows.whatsapp.account.updated.v1",
        data: this.scopedAccount(row),
      });
      const interrupted = await transaction.updateTable("operation").set({ state: "UNKNOWN" }).where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("state", "=", "IN_FLIGHT").returningAll().execute();
      for (const operation of interrupted)
      {
        await appendGatewayEvent(this, transaction, accountId, {
          type: "com.digows.whatsapp.operation.updated.v1",
          data: operationResult(operation),
        });
      }
      return row.generation;
    });
  }
  async assertOwnership(transaction: GatewayTransaction, lease: AccountLease): Promise<void>
  {
    if (lease.workspaceId !== this.workspaceId || !this.storage.owns(lease))
    {
      throw new Error("Account ownership lost");
    }
    const query = transaction.selectFrom("account").select("id").where("workspace_id", "=", this.workspaceId)
      .where("id", "=", lease.accountId).where("generation", "=", lease.generation);
    const row = await (this.storage.engine === "postgresql" ? query.forUpdate() : query).executeTakeFirst();
    if (!row) throw new Error("Account ownership changed");
  }
  async setState(lease: AccountLease, state: SessionState, nativeJid?: string, qr?: string): Promise<void>
  {
    await this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      const previous = await transaction.selectFrom("account").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("id", "=", lease.accountId).executeTakeFirstOrThrow();
      const updated = await transaction.updateTable("account").set({
        state,
        native_jid: nativeJid ?? sql`native_jid`,
        qr: qr ?? null,
      }).where("workspace_id", "=", this.workspaceId).where("id", "=", lease.accountId).returningAll()
        .executeTakeFirstOrThrow();
      if (
        previous.state !== updated.state || previous.native_jid !== updated.native_jid
        || previous.qr !== updated.qr
      )
      {
        await appendGatewayEvent(this, transaction, lease.accountId, {
          type: "com.digows.whatsapp.account.updated.v1",
          data: this.scopedAccount(updated),
        });
      }
    });
  }
  async reserve(lease: AccountLease, message: OutboundMessage, count: number): Promise<SendOperation>
  {
    const digest = createHash("sha256").update(canonical(message)).digest("hex");
    return this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      const ids = Array.from({ length: count }, () => randomUUID().replaceAll("-", "").toUpperCase());
      const inserted = await transaction.insertInto("operation").values({
        workspace_id: this.workspaceId,
        account_id: lease.accountId,
        key: message.idempotencyKey,
        digest,
        native_ids: JSON.stringify(ids),
      }).onConflict(conflict => conflict.doNothing()).returning("key").executeTakeFirst();
      const row = await transaction.selectFrom("operation").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", lease.accountId).where("key", "=", message.idempotencyKey)
        .executeTakeFirst();
      if (!row) throw new GatewayResourceUnavailableError("Operation unavailable");
      if (row.digest !== digest) throw new Error("Operation key has a different payload");
      const interrupted = row.state === "IN_FLIGHT";
      if (interrupted)
      {
        await transaction.updateTable("operation").set({ state: "UNKNOWN" }).where(
          "workspace_id",
          "=",
          this.workspaceId,
        ).where("account_id", "=", lease.accountId).where("key", "=", message.idempotencyKey).execute();
        row.state = "UNKNOWN";
      }
      if (inserted || interrupted)
      {
        await appendGatewayEvent(this, transaction, lease.accountId, {
          type: "com.digows.whatsapp.operation.updated.v1",
          data: operationResult(row),
        });
      }
      return SendOperation.restore(operationResult(row));
    });
  }
  async save(
    lease: AccountLease,
    operation: SendOperation,
    acceptedPart?: AcceptedOutboundPart,
  ): Promise<void>
  {
    if (operation.workspaceId !== this.workspaceId || operation.accountId !== lease.accountId)
    {
      throw new Error("Send operation scope mismatch");
    }
    await this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      const previous = await transaction.selectFrom("operation").select(["state", "accepted_parts"]).where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", lease.accountId).where("key", "=", operation.key).executeTakeFirst();
      const updated = await transaction.updateTable("operation").set({
        state: operation.state,
        accepted_parts: operation.acceptedParts,
      }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", lease.accountId).where(
        "key",
        "=",
        operation.key,
      ).where(expression =>
        expression.or([
          expression("state", "not in", ["ACCEPTED", "UNKNOWN", "FAILED"]),
          expression.and([
            expression("state", "=", operation.state),
            expression("accepted_parts", "=", operation.acceptedParts),
          ]),
        ])
      ).executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new Error("Operation terminal state cannot be overwritten");
      if (previous?.state !== operation.state || previous?.accepted_parts !== operation.acceptedParts)
      {
        if (acceptedPart) await retainAcceptedOutbound(this, transaction, operation, acceptedPart);
        await appendGatewayEvent(this, transaction, lease.accountId, {
          type: "com.digows.whatsapp.operation.updated.v1",
          data: operation.snapshot(),
        });
      }
    });
  }
  async operation(requestedAccountId: string, key: string): Promise<OperationResult>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
    {
      const row = await transaction.selectFrom("operation").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("key", "=", key).executeTakeFirst();
      if (!row) throw new GatewayResourceUnavailableError("Operation unavailable");
      return operationResult(row);
    });
  }
  async readAuthentication(
    requestedAccountId: string,
    category: string,
    keyId: string,
  ): Promise<string | null>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
      (await transaction.selectFrom("authentication").select("serialized_value").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("category", "=", category).where("key_id", "=", keyId)
        .executeTakeFirst())?.serialized_value ?? null
    );
  }
  async writeAuthentication(lease: AccountLease, mutations: readonly AuthenticationMutation[]): Promise<void>
  {
    await this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      for (const mutation of mutations)
      {
        if (mutation.serializedValue === null)
        {
          await transaction.deleteFrom("authentication").where("workspace_id", "=", this.workspaceId).where(
            "account_id",
            "=",
            lease.accountId,
          ).where("category", "=", mutation.category).where("key_id", "=", mutation.keyId).execute();
        }
        else
        {
          await transaction.insertInto("authentication").values({
            workspace_id: this.workspaceId,
            account_id: lease.accountId,
            category: mutation.category,
            key_id: mutation.keyId,
            serialized_value: mutation.serializedValue,
          }).onConflict(conflict =>
            conflict.columns(["workspace_id", "account_id", "category", "key_id"]).doUpdateSet({
              serialized_value: mutation.serializedValue!,
            })
          ).execute();
        }
      }
    });
  }
  async clearAuthentication(lease: AccountLease): Promise<void>
  {
    await this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      await transaction.deleteFrom("authentication").where("workspace_id", "=", this.workspaceId).where(
        "account_id",
        "=",
        lease.accountId,
      ).execute();
    });
  }
  async recordReceipt(lease: AccountLease, observation: DeliveryObservation): Promise<void>
  {
    await this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      const inserted = await transaction.insertInto("delivery").values({
        workspace_id: this.workspaceId,
        account_id: lease.accountId,
        message_id: observation.channelMessageId,
        status: observation.status,
        chat_address: observation.chatAddress,
        observed_at: new Date().toISOString(),
      }).onConflict(conflict => conflict.doNothing()).returning("message_id").executeTakeFirst();
      if (inserted)
      {
        await appendGatewayEvent(this, transaction, lease.accountId, {
          type: "com.digows.whatsapp.message.delivery.v1",
          data: { workspaceId: this.workspaceId, accountId: lease.accountId, ...observation },
        });
      }
    });
  }
  async receipts(requestedAccountId: string, messageId: string): Promise<readonly DeliveryObservation[]>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
      (await transaction.selectFrom("delivery").selectAll().where("workspace_id", "=", this.workspaceId)
        .where("account_id", "=", accountId).where("message_id", "=", messageId).orderBy("observed_at")
        .execute()).map(row => ({
          channelMessageId: row.message_id,
          status: row.status,
          chatAddress: row.chat_address,
        }))
    );
  }
  async retain(lease: AccountLease, message: InboundMessage, native: string): Promise<void>
  {
    await this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      const id = createHash("sha256").update(canonical(message)).digest("hex");
      const inserted = await transaction.insertInto("event").values({
        workspace_id: this.workspaceId,
        account_id: lease.accountId,
        id,
        message: JSON.stringify(message),
        native,
        error_name: null,
        created_at: new Date().toISOString(),
      }).onConflict(conflict => conflict.doNothing()).returning("id").executeTakeFirst();
      if (inserted)
      {
        await retainSnapshot(this, transaction, {
          workspaceId: this.workspaceId,
          accountId: lease.accountId,
          direction: "INBOUND",
          message,
          observedAt: (await this.databaseTime(transaction)).toISOString(),
          timestampSource: "PROVIDER",
          edited: false,
          deleted: false,
        }, native);
        await appendGatewayEvent(this, transaction, lease.accountId, {
          type: "com.digows.whatsapp.message.received.v1",
          data: { workspaceId: this.workspaceId, accountId: lease.accountId, message },
        });
      }
    });
  }
  async retainFailure(lease: AccountLease, native: string, errorName: string): Promise<void>
  {
    await this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      const id = "normalization-failed:" + createHash("sha256").update(native).digest("hex");
      const inserted = await transaction.insertInto("event").values({
        workspace_id: this.workspaceId,
        account_id: lease.accountId,
        id,
        kind: "NORMALIZATION_FAILED",
        message: null,
        native,
        error_name: errorName,
        created_at: new Date().toISOString(),
      }).onConflict(conflict => conflict.doNothing()).returning("id").executeTakeFirst();
      if (inserted)
      {
        await appendGatewayEvent(this, transaction, lease.accountId, {
          type: "com.digows.whatsapp.message.rejected.v1",
          data: { workspaceId: this.workspaceId, accountId: lease.accountId, errorName },
        });
      }
    });
  }
  async native(requestedAccountId: string, messageId: string, nativeChatId?: string): Promise<string>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
    {
      let query = transaction.selectFrom("message_snapshot").select("native")
        .where("workspace_id", "=", this.workspaceId).where("account_id", "=", accountId)
        .where("message_id", "=", messageId).where("native", "is not", null);
      if (nativeChatId !== undefined)
      {
        const predicate = this.storage.engine === "postgresql"
          ? sql<
            boolean
          >`(case when native is json then native::jsonb #>> '{key,remoteJid}' end)=${nativeChatId}`
          : sql<
            boolean
          >`(case when json_valid(native) then json_extract(native,'$.key.remoteJid') end)=${nativeChatId}`;
        query = query.where(predicate);
      }
      const rows = await query.limit(2).execute();
      if (rows.length > 1) throw new Error("Native media source identity is ambiguous");
      const native = rows[0]?.native;
      if (!native) throw new Error("Native media source unavailable");
      return native;
    });
  }
  async hasSent(requestedAccountId: string, messageId: string): Promise<boolean>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
    {
      const predicate = this.storage.engine === "postgresql"
        ? sql<boolean>`native_ids @> ${JSON.stringify([messageId])}::jsonb`
        : sql<boolean>`exists(select 1 from json_each(native_ids) where value=${messageId})`;
      return (await transaction.selectFrom("operation").select("key").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where(predicate).executeTakeFirst()) !== undefined;
    });
  }
  async materialized(requestedAccountId: string, sourceId: string): Promise<MediaReference | null>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
    {
      const row = await transaction.selectFrom("media").select("reference").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("source_id", "=", sourceId).executeTakeFirst();
      return row ? MediaReferenceSchema.parse(jsonValue(row.reference)) : null;
    });
  }
  async materialize(
    requestedAccountId: string,
    sourceId: string,
    work: () => Promise<MediaReference>,
  ): Promise<MediaReference>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.transaction(async transaction =>
    {
      if (this.storage.engine === "postgresql")
      {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.workspaceId}:${accountId}:${sourceId}`},0))`
          .execute(transaction);
      }
      const row = await transaction.selectFrom("media").select("reference").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("source_id", "=", sourceId).executeTakeFirst();
      if (row) return MediaReferenceSchema.parse(jsonValue(row.reference));
      const reference = MediaReferenceSchema.parse(await work());
      await transaction.insertInto("media").values({
        workspace_id: this.workspaceId,
        account_id: accountId,
        source_id: sourceId,
        reference: JSON.stringify(reference),
      }).execute();
      return reference;
    });
  }
  async pace(lease: AccountLease, policy: PacingPolicy): Promise<number>
  {
    return this.transaction(async transaction =>
    {
      await this.assertOwnership(transaction, lease);
      const row = await transaction.selectFrom("pacing").selectAll().select(
        sql<string>`cast(daily_date as text)`.as("daily_date"),
      ).where("workspace_id", "=", this.workspaceId).where("account_id", "=", lease.accountId)
        .executeTakeFirst();
      if (!row) throw new Error("Pacing state unavailable");
      const now = Date.now();
      const pacing = new AccountPacing({
        nextSendAt: new Date(row.next_send_at).getTime(),
        startedAt: new Date(row.started_at).getTime(),
        lastActiveAt: new Date(row.last_active_at).getTime(),
        dailyDate: row.daily_date,
        dailyCount: row.daily_count,
        recentTimes: z.array(z.number().finite()).parse(jsonValue(row.recent_times)),
      }, policy).reserve(now);
      await transaction.updateTable("pacing").set({
        next_send_at: new Date(pacing.nextSendAt).toISOString(),
        started_at: new Date(pacing.startedAt).toISOString(),
        last_active_at: new Date(pacing.lastActiveAt).toISOString(),
        recent_times: JSON.stringify(pacing.recentTimes),
        daily_date: pacing.dailyDate,
        daily_count: pacing.dailyCount,
      }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", lease.accountId).execute();
      return Math.max(0, (pacing.recentTimes.at(-1) ?? now) - now);
    });
  }
}
function operationResult(row: Selectable<OperationTable>): OperationResult
{
  return {
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    key: row.key,
    digest: row.digest,
    nativeIds: z.array(z.string()).parse(jsonValue(row.native_ids)),
    acceptedParts: row.accepted_parts,
    state: OperationStateSchema.parse(row.state),
  };
}
export function canonical(value: unknown): string
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
