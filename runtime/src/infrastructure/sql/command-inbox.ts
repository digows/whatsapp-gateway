import {
  type GatewayCommand,
  type GatewayCommandFailure,
  GatewayCommandFailureSchema,
  type GatewayCommandResponse,
  GatewayCommandResponseSchema,
  type GatewayCommandResult,
  GatewayCommandResultSchema,
  GatewayCommandSchema,
  GatewayIdentifierSchema,
} from "@digows/whatsapp-gateway-contracts";
import { type Selectable, sql } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import type { ClaimedGatewayCommand, GatewayCommandInbox } from "../../domain/command-inbox.ts";
import type { AccountLease } from "../../domain/gateway-store.ts";
import { canonical, SqlGatewayStore } from "./gateway-store.ts";
import { type CommandTable, jsonValue } from "./tables.ts";

export class SqlCommandInbox implements GatewayCommandInbox
{
  readonly workspaceId: string;
  constructor(private readonly store: SqlGatewayStore)
  {
    this.workspaceId = store.workspaceId;
  }
  async submit(input: GatewayCommand): Promise<GatewayCommandResult>
  {
    const command = GatewayCommandSchema.parse(input);
    if (command.workspaceId !== this.workspaceId) throw new Error("Command workspace mismatch");
    const digest = createHash("sha256").update(canonical(command)).digest("hex");
    return this.store.transaction(async transaction =>
    {
      // Serialize intake with claims and other producers on both qualified engines.
      const account = await transaction.updateTable("account").set({ generation: sql`generation` })
        .where("workspace_id", "=", this.workspaceId).where("id", "=", command.accountId).returning("id")
        .executeTakeFirst();
      if (!account) throw new Error("Account unavailable");
      const existing = await transaction.selectFrom("command").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      )
        .where("account_id", "=", command.accountId).where("request_id", "=", command.requestId)
        .executeTakeFirst();
      if (existing)
      {
        if (existing.digest !== digest) throw new Error("Command request has a different payload");
        return commandResult(existing);
      }
      const last = await transaction.selectFrom("command").select("sequence").where(
        "workspace_id",
        "=",
        this.workspaceId,
      )
        .where("account_id", "=", command.accountId).orderBy("sequence", "desc").limit(1).executeTakeFirst();
      const row = await transaction.insertInto("command").values({
        workspace_id: this.workspaceId,
        account_id: command.accountId,
        request_id: command.requestId,
        sequence: (last?.sequence ?? 0) + 1,
        command: JSON.stringify(command),
        digest,
        state: "PENDING",
        response: null,
        failure: null,
        claim_token: null,
        generation: null,
        created_at: new Date().toISOString(),
      }).returningAll().executeTakeFirstOrThrow();
      return commandResult(row);
    });
  }
  async result(requestedAccountId: string, requestedRequestId: string): Promise<GatewayCommandResult>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    const requestId = GatewayIdentifierSchema.parse(requestedRequestId);
    return this.store.transaction(async transaction =>
    {
      const row = await transaction.selectFrom("command").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      )
        .where("account_id", "=", accountId).where("request_id", "=", requestId).executeTakeFirst();
      if (!row) throw new Error("Command unavailable");
      return commandResult(row);
    });
  }
  async claim(lease: AccountLease): Promise<ClaimedGatewayCommand | null>
  {
    return this.store.transaction(async transaction =>
    {
      await this.store.assertOwnership(transaction, lease);
      const row = await transaction.selectFrom("command").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      )
        .where("account_id", "=", lease.accountId).where("state", "in", ["PENDING", "EXECUTING"])
        .orderBy("sequence").limit(1).executeTakeFirst();
      // Never reclaim based on wall-clock time while the exclusive account owner still lives.
      if (!row || (row.state === "EXECUTING" && row.generation === lease.generation)) return null;
      const token = randomUUID();
      await transaction.updateTable("command").set({
        state: "EXECUTING",
        claim_token: token,
        generation: lease.generation,
      })
        .where("workspace_id", "=", this.workspaceId).where("account_id", "=", lease.accountId)
        .where("request_id", "=", row.request_id).execute();
      return {
        command: GatewayCommandSchema.parse(jsonValue(row.command)),
        token,
        generation: lease.generation,
      };
    });
  }
  async complete(
    lease: AccountLease,
    claim: ClaimedGatewayCommand,
    input: GatewayCommandResponse,
  ): Promise<void>
  {
    const response = GatewayCommandResponseSchema.parse(input);
    const command = claim.command;
    if (
      response.workspaceId !== command.workspaceId || response.accountId !== command.accountId
      || response.requestId !== command.requestId || response.type !== command.type
      || (response.type === "send" && command.type === "send"
        && response.result.key !== command.message.idempotencyKey)
      || (response.type === "contact.lookup" && command.type === "contact.lookup"
        && response.result.address !== command.address)
    )
    {
      throw new Error("Command completion identity mismatch");
    }
    await this.finish(lease, claim, response, null);
  }
  async fail(lease: AccountLease, claim: ClaimedGatewayCommand, failure: GatewayCommandFailure): Promise<void>
  {
    await this.finish(lease, claim, null, GatewayCommandFailureSchema.parse(failure));
  }
  private async finish(
    lease: AccountLease,
    claim: ClaimedGatewayCommand,
    response: GatewayCommandResponse | null,
    failure: GatewayCommandFailure | null,
  ): Promise<void>
  {
    await this.store.transaction(async transaction =>
    {
      await this.store.assertOwnership(transaction, lease);
      if (
        claim.command.workspaceId !== this.workspaceId || claim.command.accountId !== lease.accountId
        || claim.generation !== lease.generation
      ) throw new Error("Command claim ownership changed");
      const updated = await transaction.updateTable("command").set({
        state: response ? "COMPLETED" : "FAILED",
        response: response ? JSON.stringify(response) : null,
        failure,
        claim_token: null,
        generation: null,
      }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", lease.accountId)
        .where("request_id", "=", claim.command.requestId).where("state", "=", "EXECUTING")
        .where("claim_token", "=", claim.token).where("generation", "=", lease.generation).executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new Error("Command claim or completion is no longer current");
    });
  }
}
function commandResult(row: Selectable<CommandTable>): GatewayCommandResult
{
  return GatewayCommandResultSchema.parse({
    apiVersion: "1",
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    requestId: row.request_id,
    sequence: row.sequence,
    state: row.state,
    response: jsonValue(row.response),
    failure: row.failure,
  });
}
