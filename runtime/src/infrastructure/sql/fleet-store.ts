import {
  type Account,
  type DesiredAccount,
  type DesiredAccountRequest,
  DesiredAccountRequestSchema,
  DesiredAccountSchema,
  GatewayIdentifierSchema,
} from "@digows/whatsapp-gateway-contracts";
import { type Selectable, sql } from "kysely";
import { z } from "zod";
import {
  GatewayConflictError,
  GatewayResourceUnavailableError,
  UnpairedAccountRecoveryError,
} from "../../domain/errors.ts";
import type { GatewayFleetStore } from "../../domain/fleet-store.ts";
import type { AccountLease } from "../../domain/gateway-store.ts";
import { SqlCommandInbox } from "./command-inbox.ts";
import { appendGatewayEvent } from "./event-log.ts";
import { type GatewayTransaction, SqlGatewayStore } from "./gateway-store.ts";
import type { DesiredAccountTable } from "./tables.ts";
const PairedIdentitySchema = z.object({ me: z.object({ id: z.string().min(1) }) });
export class SqlFleetStore implements GatewayFleetStore
{
  readonly workspaceId: string;
  readonly commands: SqlCommandInbox;
  constructor(private readonly store: SqlGatewayStore)
  {
    this.workspaceId = store.workspaceId;
    this.commands = new SqlCommandInbox(store);
  }
  async account(accountId: string): Promise<Account>
  {
    return this.store.account(accountId);
  }
  async setDesired(input: DesiredAccountRequest): Promise<DesiredAccount>
  {
    const request = DesiredAccountRequestSchema.parse(input);
    if (request.workspaceId !== this.workspaceId) throw new Error("Desired account workspace mismatch");
    return this.store.transaction(async transaction =>
    {
      const account = await transaction.updateTable("account").set({ generation: sql`generation` }).where(
        "workspace_id",
        "=",
        this.workspaceId,
      )
        .where("id", "=", request.accountId).returning("id").executeTakeFirst();
      if (!account) throw new GatewayResourceUnavailableError("Account unavailable");
      const current = await transaction.selectFrom("desired_account").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      )
        .where("account_id", "=", request.accountId).executeTakeFirst();
      if (
        current && current.revision === request.expectedRevision + 1
        && (current.enabled === 1) === request.enabled
      ) return desiredAccount(current);
      if ((current?.revision ?? 0) !== request.expectedRevision)
      {
        throw new GatewayConflictError("Desired account revision changed");
      }
      const revision = request.expectedRevision + 1;
      const values = {
        revision,
        enabled: request.enabled ? 1 : 0,
        assigned_runtime_id: current?.assigned_runtime_id ?? null,
        attempted_revision: current?.attempted_revision ?? 0,
        blocked_revision: current?.blocked_revision ?? 0,
      };
      const row = current
        ? await transaction.updateTable("desired_account").set(values).where(
          "workspace_id",
          "=",
          this.workspaceId,
        ).where("account_id", "=", request.accountId).returningAll().executeTakeFirstOrThrow()
        : await transaction.insertInto("desired_account").values({
          workspace_id: this.workspaceId,
          account_id: request.accountId,
          ...values,
        }).returningAll().executeTakeFirstOrThrow();
      await appendGatewayEvent(this.store, transaction, request.accountId, {
        type: "com.digows.whatsapp.account.desired.v1",
        data: desiredAccount(row),
      });
      return desiredAccount(row);
    });
  }
  async desired(requestedAccountId: string): Promise<DesiredAccount>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    await this.store.account(accountId);
    return this.store.transaction(async transaction =>
    {
      const row = await transaction.selectFrom("desired_account").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).executeTakeFirst();
      return row
        ? desiredAccount(row)
        : {
          apiVersion: "1",
          workspaceId: this.workspaceId,
          accountId,
          revision: 0,
          enabled: false,
          assignedRuntimeId: null,
          attemptedRevision: 0,
          blockedRevision: 0,
        };
    });
  }
  async assignments(): Promise<readonly DesiredAccount[]>
  {
    return this.store.transaction(async transaction =>
      (await transaction.selectFrom("desired_account").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).orderBy("account_id").execute()).map(desiredAccount)
    );
  }
  async heartbeat(
    requestedRuntimeId: string,
    capacity: number,
    draining: boolean,
    lifetimeMs: number,
  ): Promise<void>
  {
    const runtimeId = GatewayIdentifierSchema.parse(requestedRuntimeId);
    z.number().int().positive().max(10000).parse(capacity);
    z.number().int().positive().max(300000).parse(lifetimeMs);
    await this.store.transaction(async transaction =>
    {
      const expiresAt = new Date((await this.store.databaseTime(transaction)).getTime() + lifetimeMs)
        .toISOString();
      await transaction.insertInto("runtime").values({
        workspace_id: this.workspaceId,
        id: runtimeId,
        capacity,
        draining: draining ? 1 : 0,
        expires_at: expiresAt,
      })
        .onConflict(conflict =>
          conflict.columns(["workspace_id", "id"]).doUpdateSet({
            capacity,
            draining: draining ? 1 : 0,
            expires_at: expiresAt,
          })
        ).execute();
    });
  }
  async leave(runtimeId: string): Promise<void>
  {
    await this.store.transaction(async transaction =>
    {
      await transaction.deleteFrom("runtime").where("workspace_id", "=", this.workspaceId).where(
        "id",
        "=",
        GatewayIdentifierSchema.parse(runtimeId),
      ).execute();
    });
  }
  async coordinate(): Promise<boolean>
  {
    return this.store.transaction(async transaction =>
    {
      if (!await this.store.tryCoordinate(transaction)) return false;
      const now = (await this.store.databaseTime(transaction)).toISOString();
      const runtimes = await transaction.selectFrom("runtime").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("expires_at", ">", now).where("draining", "=", 0).orderBy("id").execute();
      const desired = await transaction.selectFrom("desired_account").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).orderBy("account_id").execute();
      const accounts = await transaction.selectFrom("account").select(["id", "state"]).where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).execute();
      const states = new Map(accounts.map(value => [value.id, value.state]));
      const membership = new Map(runtimes.map(runtime => [runtime.id, runtime]));
      const loads = new Map(runtimes.map(runtime => [runtime.id, 0]));
      const placements = new Map<string, string | null>();
      const blocked = new Set<string>();
      for (const account of desired)
      {
        const state = states.get(account.account_id);
        const failed = account.attempted_revision === account.revision
          && (state === "FAILED" || state === "LOGGED_OUT");
        if (account.enabled === 0 || account.blocked_revision === account.revision || failed)
        {
          placements.set(account.account_id, null);
          if (failed) blocked.add(account.account_id);
          continue;
        }
        const owner = account.assigned_runtime_id === null
          ? undefined
          : membership.get(account.assigned_runtime_id);
        const load = owner ? loads.get(owner.id) ?? 0 : 0;
        if (owner && load < owner.capacity)
        {
          placements.set(account.account_id, owner.id);
          loads.set(owner.id, load + 1);
        }
      }
      for (const account of desired)
      {
        if (placements.has(account.account_id)) continue;
        const candidate = runtimes.filter(runtime => (loads.get(runtime.id) ?? 0) < runtime.capacity)
          .sort((left, right) =>
            (loads.get(left.id) ?? 0) - (loads.get(right.id) ?? 0) || left.id.localeCompare(right.id)
          )[0];
        placements.set(account.account_id, candidate?.id ?? null);
        if (candidate) loads.set(candidate.id, (loads.get(candidate.id) ?? 0) + 1);
      }
      for (const account of desired)
      {
        const owner = placements.get(account.account_id) ?? null;
        const blockedRevision = blocked.has(account.account_id) ? account.revision : account.blocked_revision;
        if (owner === account.assigned_runtime_id && blockedRevision === account.blocked_revision) continue;
        await transaction.updateTable("account").set({ generation: sql`generation` }).where(
          "workspace_id",
          "=",
          this.workspaceId,
        ).where("id", "=", account.account_id).execute();
        const updated = await transaction.updateTable("desired_account").set({
          assigned_runtime_id: owner,
          blocked_revision: blockedRevision,
        }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", account.account_id).where(
          "revision",
          "=",
          account.revision,
        ).returningAll().executeTakeFirst();
        if (updated)
        {
          await appendGatewayEvent(this.store, transaction, account.account_id, {
            type: "com.digows.whatsapp.account.desired.v1",
            data: desiredAccount(updated),
          });
        }
      }
      await transaction.deleteFrom("runtime").where("workspace_id", "=", this.workspaceId).where(
        "expires_at",
        "<=",
        now,
      ).execute();
      return true;
    });
  }
  async claimAssignment(lease: AccountLease, runtimeId: string, revision: number): Promise<void>
  {
    await this.store.transaction(async transaction =>
    {
      await this.store.assertOwnership(transaction, lease);
      const desired = await this.currentAssignment(transaction, lease, runtimeId, revision);
      if (!desired) throw new Error("Account assignment changed");
      if (desired.attempted_revision === revision)
      {
        const credentials = await transaction.selectFrom("authentication").select("serialized_value").where(
          "workspace_id",
          "=",
          this.workspaceId,
        ).where("account_id", "=", lease.accountId).where("category", "=", "credentials").where(
          "key_id",
          "=",
          "default",
        ).executeTakeFirst();
        if (!credentials || !isPaired(credentials.serialized_value))
        {
          throw new UnpairedAccountRecoveryError();
        }
      }
      const updated = await transaction.updateTable("desired_account").set({ attempted_revision: revision })
        .where(
          "workspace_id",
          "=",
          this.workspaceId,
        ).where("account_id", "=", lease.accountId).returningAll().executeTakeFirstOrThrow();
      if (desired.attempted_revision !== updated.attempted_revision)
      {
        await appendGatewayEvent(this.store, transaction, lease.accountId, {
          type: "com.digows.whatsapp.account.desired.v1",
          data: desiredAccount(updated),
        });
      }
    });
  }
  async block(accountId: string, runtimeId: string, revision: number): Promise<void>
  {
    await this.store.transaction(async transaction =>
    {
      await transaction.updateTable("account").set({ generation: sql`generation` }).where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("id", "=", GatewayIdentifierSchema.parse(accountId)).execute();
      const updated = await transaction.updateTable("desired_account").set({
        blocked_revision: revision,
        assigned_runtime_id: null,
      }).where("workspace_id", "=", this.workspaceId).where(
        "account_id",
        "=",
        GatewayIdentifierSchema.parse(accountId),
      ).where("assigned_runtime_id", "=", GatewayIdentifierSchema.parse(runtimeId)).where(
        "revision",
        "=",
        revision,
      ).where("attempted_revision", "=", revision).returningAll().executeTakeFirst();
      if (updated)
      {
        await appendGatewayEvent(this.store, transaction, accountId, {
          type: "com.digows.whatsapp.account.desired.v1",
          data: desiredAccount(updated),
        });
      }
    });
  }
  private async currentAssignment(
    transaction: GatewayTransaction,
    lease: AccountLease,
    runtimeId: string,
    revision: number,
  )
  {
    return transaction.selectFrom("desired_account").selectAll().where("workspace_id", "=", this.workspaceId)
      .where("account_id", "=", lease.accountId).where(
        "assigned_runtime_id",
        "=",
        GatewayIdentifierSchema.parse(runtimeId),
      ).where("revision", "=", revision).where("enabled", "=", 1).where("blocked_revision", "<", revision)
      .executeTakeFirst();
  }
  async canWork(lease: AccountLease, runtimeId: string, revision: number): Promise<boolean>
  {
    if (!lease.alive) return false;
    return this.store.transaction(async transaction =>
    {
      await this.store.assertOwnership(transaction, lease);
      if (!await this.currentAssignment(transaction, lease, runtimeId, revision)) return false;
      const account = await transaction.selectFrom("account").select("state").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("id", "=", lease.accountId).executeTakeFirst();
      return account?.state === "CONNECTED";
    });
  }
}
function desiredAccount(row: Selectable<DesiredAccountTable>): DesiredAccount
{
  return DesiredAccountSchema.parse({
    apiVersion: "1",
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    revision: row.revision,
    enabled: row.enabled === 1,
    assignedRuntimeId: row.assigned_runtime_id,
    attemptedRevision: row.attempted_revision,
    blockedRevision: row.blocked_revision,
  });
}
function isPaired(serialized: string): boolean
{
  try
  {
    return PairedIdentitySchema.safeParse(JSON.parse(serialized)).success;
  }
  catch
  {
    return false;
  }
}
