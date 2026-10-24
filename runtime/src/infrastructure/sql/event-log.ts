import {
  type GatewayCloudEvent,
  GatewayCloudEventSchema,
  type GatewayEventPayload,
  GatewayIdentifierSchema,
} from "@digows/whatsapp-gateway-contracts";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GatewayTransaction, SqlGatewayStore } from "./gateway-store.ts";
import { jsonValue } from "./tables.ts";
/** Called inside the transaction changing the owning state; never publish to a network here. */
export async function appendGatewayEvent(
  store: SqlGatewayStore,
  transaction: GatewayTransaction,
  accountId: string,
  payload: GatewayEventPayload,
): Promise<GatewayCloudEvent>
{
  if (payload.data.workspaceId !== store.workspaceId || payload.data.accountId !== accountId)
  {
    throw new Error("Public event payload scope mismatch");
  }
  const account = await transaction.updateTable("account").set({ generation: sql`generation` }).where(
    "workspace_id",
    "=",
    store.workspaceId,
  ).where("id", "=", accountId).returning("id").executeTakeFirst();
  if (!account) throw new Error("Event account unavailable");
  const previous = await transaction.selectFrom("public_event").select("sequence").where(
    "workspace_id",
    "=",
    store.workspaceId,
  ).where("account_id", "=", accountId).orderBy("sequence", "desc").limit(1).executeTakeFirst();
  const now = (await store.databaseTime(transaction)).toISOString();
  const envelope = GatewayCloudEventSchema.parse({
    ...payload,
    specversion: "1.0",
    id: randomUUID(),
    source: "urn:digows:whatsapp-gateway",
    subject: `accounts/${accountId}`,
    time: now,
    datacontenttype: "application/json",
    workspaceid: store.workspaceId,
    accountid: accountId,
    sequence: (previous?.sequence ?? 0) + 1,
  });
  await transaction.insertInto("public_event").values({
    workspace_id: store.workspaceId,
    account_id: accountId,
    id: envelope.id,
    sequence: envelope.sequence,
    envelope: JSON.stringify(envelope),
    created_at: now,
  }).execute();
  return envelope;
}
export class SqlGatewayEventLog
{
  constructor(private readonly store: SqlGatewayStore)
  {}
  async after(
    requestedAccountId: string,
    sequence: number,
    limit: number,
  ): Promise<readonly GatewayCloudEvent[]>
  {
    const accountId = GatewayIdentifierSchema.parse(requestedAccountId);
    z.number().int().nonnegative().max(2147483647).parse(sequence);
    z.number().int().positive().max(1000).parse(limit);
    return this.store.transaction(async transaction =>
      (await transaction.selectFrom("public_event").select("envelope").where(
        "workspace_id",
        "=",
        this.store.workspaceId,
      ).where("account_id", "=", accountId).where("sequence", ">", sequence).orderBy("sequence").limit(limit)
        .execute()).map(row => GatewayCloudEventSchema.parse(jsonValue(row.envelope)))
    );
  }
}
