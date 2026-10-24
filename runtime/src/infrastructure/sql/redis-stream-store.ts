import {
  GatewayCloudEventSchema,
  type GatewayCommandResult,
  GatewayCommandSchema,
  GatewayIdentifierSchema,
  type GatewayStreamNames,
  type GatewayStreamReceipt,
  GatewayStreamReceiptSchema,
} from "@digows/whatsapp-gateway-contracts";
import { sql } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { GatewayCommandIngress } from "../../application/command-ingress.ts";
import { GatewayAuthorizationError, type GatewayPrincipal } from "../../domain/authorization.ts";
import { GatewayConflictError } from "../../domain/errors.ts";
import type {
  ClaimedStreamPublication,
  GatewayStreamKind,
  RedisStreamStore,
  StreamPublicationWork,
} from "../../domain/redis-stream-store.ts";
import { SqlCommandInbox } from "./command-inbox.ts";
import { appendGatewayEvent } from "./event-log.ts";
import { type GatewayTransaction, SqlGatewayStore } from "./gateway-store.ts";
import { jsonValue } from "./tables.ts";
export class SqlRedisStreamStore implements RedisStreamStore
{
  readonly workspaceId: string;
  private readonly commands: GatewayCommandIngress;
  constructor(private readonly store: SqlGatewayStore)
  {
    this.workspaceId = store.workspaceId;
    this.commands = new GatewayCommandIngress(new SqlCommandInbox(store));
  }
  private async lockAccount(transaction: GatewayTransaction, accountId: string): Promise<void>
  {
    const row = await transaction.updateTable("account").set({ generation: sql`generation` }).where(
      "workspace_id",
      "=",
      this.workspaceId,
    ).where("id", "=", accountId).returning("id").executeTakeFirst();
    if (!row) throw new Error("Stream account unavailable");
  }
  async register(requestedAccountId: string, streams: GatewayStreamNames): Promise<void>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    await this.store.transaction(async transaction =>
    {
      await this.lockAccount(transaction, accountId);
      const tail = await transaction.selectFrom("public_event").select("sequence").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).orderBy("sequence", "desc").limit(1).executeTakeFirst();
      for (const kind of ["events", "results"] as const)
      {
        await transaction.insertInto("stream_cursor").values({
          workspace_id: this.workspaceId,
          account_id: accountId,
          stream_name: streams[kind],
          kind,
          position: tail?.sequence ?? 0,
          claim_token: null,
          claimed_sequence: null,
          lease_until: null,
        }).onConflict(conflict => conflict.doNothing()).execute();
      }
    });
  }
  async receipt(accountId: string, stream: string, messageId: string): Promise<GatewayStreamReceipt>
  {
    return this.store.transaction(async transaction =>
    {
      const row = await transaction.selectFrom("stream_receipt").select("receipt").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", GatewayIdentifierSchema.parse(accountId)).where("source_stream", "=", stream)
        .where("source_message_id", "=", messageId).executeTakeFirst();
      if (!row) throw new Error("Stream receipt unavailable");
      const receipt = GatewayStreamReceiptSchema.parse(jsonValue(row.receipt));
      if (receipt.workspaceId !== this.workspaceId || receipt.accountId !== accountId)
      {
        throw new Error("Stream receipt scope mismatch");
      }
      return receipt;
    });
  }
  async intake(
    principal: GatewayPrincipal,
    requestedAccountId: string,
    stream: string,
    messageId: string,
    payload: string,
  ): Promise<GatewayStreamReceipt>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    principal.authorize({ workspaceId: this.workspaceId, accountId });
    const digest = createHash("sha256").update(payload).digest("hex");
    const previous = await this.store.transaction(async transaction =>
      transaction.selectFrom("stream_receipt").selectAll().where("workspace_id", "=", this.workspaceId).where(
        "account_id",
        "=",
        accountId,
      ).where("source_stream", "=", stream).where("source_message_id", "=", messageId).executeTakeFirst()
    );
    if (previous)
    {
      if (previous.digest !== digest) throw new GatewayConflictError("Stream ID has a different payload");
      return this.receipt(accountId, stream, messageId);
    }
    let input: unknown;
    if (Buffer.byteLength(payload) <= 1024 * 1024)
    {
      try
      {
        input = JSON.parse(payload);
      }
      catch
      {
        input = null;
      }
    }
    const identity = z.object({ requestId: GatewayIdentifierSchema }).safeParse(input);
    const parsed = GatewayCommandSchema.safeParse(input);
    let command: GatewayCommandResult | null = null;
    let failure: GatewayStreamReceipt["failure"] = "INVALID_REQUEST";
    if (parsed.success)
    {
      if (parsed.data.workspaceId !== this.workspaceId || parsed.data.accountId !== accountId)
      {
        failure = "UNAUTHORIZED_SCOPE";
      }
      else
      {
        try
        {
          command = await this.commands.submit(principal, parsed.data);
          failure = null;
        }
        catch (error)
        {
          if (error instanceof GatewayAuthorizationError) failure = "UNAUTHORIZED_SCOPE";
          else if (error instanceof GatewayConflictError) failure = "CONFLICT";
          else throw error;
        }
      }
    }
    const receipt = GatewayStreamReceiptSchema.parse({
      apiVersion: "1",
      workspaceId: this.workspaceId,
      accountId,
      sourceStream: stream,
      sourceMessageId: messageId,
      requestId: identity.success ? identity.data.requestId : null,
      status: command ? "QUEUED" : "REJECTED",
      command,
      failure,
    });
    return this.store.transaction(async transaction =>
    {
      await this.lockAccount(transaction, accountId);
      const existing = await transaction.selectFrom("stream_receipt").select("digest").where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("source_stream", "=", stream).where(
        "source_message_id",
        "=",
        messageId,
      ).executeTakeFirst();
      if (existing)
      {
        if (existing.digest !== digest) throw new GatewayConflictError("Stream ID has a different payload");
        const row = await transaction.selectFrom("stream_receipt").select("receipt").where(
          "workspace_id",
          "=",
          this.workspaceId,
        ).where("account_id", "=", accountId).where("source_stream", "=", stream).where(
          "source_message_id",
          "=",
          messageId,
        ).executeTakeFirstOrThrow();
        return GatewayStreamReceiptSchema.parse(jsonValue(row.receipt));
      }
      await transaction.insertInto("stream_receipt").values({
        workspace_id: this.workspaceId,
        account_id: accountId,
        source_stream: stream,
        source_message_id: messageId,
        digest,
        receipt: JSON.stringify(receipt),
      }).execute();
      await appendGatewayEvent(this.store, transaction, accountId, {
        type: "com.digows.whatsapp.ingress.receipt.v1",
        data: receipt,
      });
      return receipt;
    });
  }
  async publication(
    requestedAccountId: string,
    stream: string,
    kind: GatewayStreamKind,
    lifetimeMs: number,
  ): Promise<StreamPublicationWork>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    return this.store.transaction(async transaction =>
    {
      await this.lockAccount(transaction, accountId);
      const cursor = await transaction.selectFrom("stream_cursor").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("stream_name", "=", stream).executeTakeFirstOrThrow();
      if (cursor.kind !== kind) throw new Error("Stream cursor kind mismatch");
      const now = await this.store.databaseTime(transaction);
      if (cursor.lease_until && new Date(cursor.lease_until).getTime() > now.getTime())
      {
        return { claim: null, advanced: false };
      }
      const rows = await transaction.selectFrom("public_event").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", accountId).where("sequence", ">", cursor.position).orderBy("sequence").limit(
        100,
      ).execute();
      const events = rows.map(row =>
      {
        const event = GatewayCloudEventSchema.parse(jsonValue(row.envelope));
        if (
          event.workspaceid !== this.workspaceId || event.accountid !== accountId || event.id !== row.id
          || event.sequence !== row.sequence
        ) throw new Error("Stream publication event identity mismatch");
        return event;
      });
      const candidate = events.find(event =>
        (event.type === "com.digows.whatsapp.command.updated.v1"
          || event.type === "com.digows.whatsapp.ingress.receipt.v1") === (kind === "results")
      );
      if (!candidate)
      {
        const tail = events.at(-1);
        if (tail)
        {
          await transaction.updateTable("stream_cursor").set({
            position: tail.sequence,
            claim_token: null,
            claimed_sequence: null,
            lease_until: null,
          }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", accountId).where(
            "stream_name",
            "=",
            stream,
          ).execute();
        }
        return { claim: null, advanced: tail !== undefined };
      }
      const token = randomUUID();
      await transaction.updateTable("stream_cursor").set({
        claim_token: token,
        claimed_sequence: candidate.sequence,
        lease_until: new Date(now.getTime() + lifetimeMs).toISOString(),
      }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", accountId).where(
        "stream_name",
        "=",
        stream,
      ).execute();
      return {
        advanced: false,
        claim: { workspaceId: this.workspaceId, accountId, stream, token, event: candidate },
      };
    });
  }
  async published(claim: ClaimedStreamPublication): Promise<boolean>
  {
    if (claim.workspaceId !== this.workspaceId) throw new Error("Stream completion scope mismatch");
    return this.store.transaction(async transaction =>
    {
      await this.lockAccount(transaction, claim.accountId);
      const updated = await transaction.updateTable("stream_cursor").set({
        position: claim.event.sequence,
        claim_token: null,
        claimed_sequence: null,
        lease_until: null,
      }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", claim.accountId).where(
        "stream_name",
        "=",
        claim.stream,
      ).where("claim_token", "=", claim.token).where("claimed_sequence", "=", claim.event.sequence)
        .executeTakeFirstOrThrow();
      return updated.numUpdatedRows === 1n;
    });
  }
  async releasePublication(claim: ClaimedStreamPublication): Promise<void>
  {
    if (claim.workspaceId !== this.workspaceId) throw new Error("Stream release scope mismatch");
    await this.store.transaction(async transaction =>
    {
      await transaction.updateTable("stream_cursor").set({
        claim_token: null,
        claimed_sequence: null,
        lease_until: null,
      }).where("workspace_id", "=", this.workspaceId).where("account_id", "=", claim.accountId).where(
        "stream_name",
        "=",
        claim.stream,
      ).where("claim_token", "=", claim.token).execute();
    });
  }
}
