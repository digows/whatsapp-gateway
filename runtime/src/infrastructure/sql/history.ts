import {
  type GatewayHistoryPage,
  GatewayHistoryPageSchema,
  GatewayHistoryRequestSchema,
  GatewayMessageRequestSchema,
  type GatewayObservedMessage,
  GatewayObservedMessageSchema,
  type InboundMessage,
  InboundMessageSchema,
} from "@digows/whatsapp-gateway-contracts";
import { type Selectable } from "kysely";
import { z } from "zod";
import type { AcceptedOutboundPart } from "../../domain/accepted-outbound-part.ts";
import type { SendOperation } from "../../domain/send-operation.ts";
import { appendGatewayEvent } from "./event-log.ts";
import { type GatewayTransaction, type SqlGatewayStore } from "./gateway-store.ts";
import { jsonValue, type MessageSnapshotTable } from "./tables.ts";
const HistoryCursorSchema = GatewayHistoryRequestSchema.pick({
  workspaceId: true,
  accountId: true,
  chatAddress: true,
  direction: true,
}).extend({ time: z.iso.datetime({ offset: true }), position: z.number().int().positive() });
export function observedSnapshot(row: Selectable<MessageSnapshotTable>): GatewayObservedMessage
{
  return GatewayObservedMessageSchema.parse({
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    direction: row.direction,
    message: jsonValue(row.message),
    observedAt: new Date(row.observed_at).toISOString(),
    timestampSource: row.timestamp_source,
    edited: row.edited === 1,
    deleted: row.deleted === 1,
  });
}
export async function retainSnapshot(
  store: SqlGatewayStore,
  transaction: GatewayTransaction,
  observation: GatewayObservedMessage,
  native: string | null,
): Promise<void>
{
  if (observation.workspaceId !== store.workspaceId)
  {
    throw new Error("Message observation workspace mismatch");
  }
  const message = observation.message;
  if (message.contentKind === "REACTION" || message.contentKind === "SELECTION") return;
  if (message.contentKind === "EDIT" || message.contentKind === "DELETE")
  {
    const target = message.target;
    const rows = await transaction.selectFrom("message_snapshot").selectAll().where(
      "workspace_id",
      "=",
      store.workspaceId,
    ).where("account_id", "=", observation.accountId).where("chat_address", "=", target.chatAddress).where(
      "message_id",
      "=",
      target.channelMessageId,
    ).where("sender_address", "=", target.senderAddress).execute();
    for (const row of rows)
    {
      const previous = InboundMessageSchema.parse(jsonValue(row.message));
      if (message.contentKind === "DELETE")
      {
        await transaction.updateTable("message_snapshot").set({ deleted: 1 }).where(
          "workspace_id",
          "=",
          store.workspaceId,
        ).where("account_id", "=", observation.accountId).where("position", "=", row.position).execute();
      }
      else if (previous.contentKind === "TEXT")
      {
        const updated = InboundMessageSchema.parse({ ...previous, text: message.text });
        await transaction.updateTable("message_snapshot").set({ message: JSON.stringify(updated), edited: 1 })
          .where("workspace_id", "=", store.workspaceId).where("account_id", "=", observation.accountId)
          .where("position", "=", row.position).execute();
      }
    }
    return;
  }
  const previous = await transaction.selectFrom("message_snapshot").select([
    "position",
    "direction",
    "edited",
    "deleted",
  ]).where("workspace_id", "=", store.workspaceId).where("account_id", "=", observation.accountId).where(
    "chat_address",
    "=",
    message.chatAddress,
  ).where("message_id", "=", message.channelMessageId).where("sender_address", "=", message.senderAddress)
    .executeTakeFirst();
  if (previous && previous.direction !== observation.direction)
  {
    throw new Error("Message observation direction conflict");
  }
  const last = previous
    ? null
    : await transaction.selectFrom("message_snapshot").select("position").where(
      "workspace_id",
      "=",
      store.workspaceId,
    ).where("account_id", "=", observation.accountId).orderBy("position", "desc").limit(1).executeTakeFirst();
  await transaction.insertInto("message_snapshot").values({
    workspace_id: store.workspaceId,
    account_id: observation.accountId,
    chat_address: message.chatAddress,
    message_id: message.channelMessageId,
    sender_address: message.senderAddress,
    position: previous?.position ?? (last?.position ?? 0) + 1,
    direction: observation.direction,
    message: JSON.stringify(message),
    native,
    occurred_at: new Date(message.occurredAt).toISOString(),
    observed_at: observation.observedAt,
    timestamp_source: observation.timestampSource,
    edited: previous?.edited ?? (observation.edited ? 1 : 0),
    deleted: previous?.deleted ?? (observation.deleted ? 1 : 0),
  })
    .onConflict(conflict =>
      conflict.columns(["workspace_id", "account_id", "chat_address", "message_id", "sender_address"])
        .doUpdateSet({ message: JSON.stringify(message), native, observed_at: observation.observedAt })
    ).execute();
}
export async function retainAcceptedOutbound(
  store: SqlGatewayStore,
  transaction: GatewayTransaction,
  operation: SendOperation,
  accepted: AcceptedOutboundPart,
): Promise<void>
{
  const id = operation.nativeIds[accepted.index];
  if (!id || operation.acceptedParts !== accepted.index + 1)
  {
    throw new Error("Accepted outbound part identity mismatch");
  }
  const now = (await store.databaseTime(transaction)).toISOString();
  const { senderAddress, recipientAddress: _recipientAddress, idempotencyKey: _idempotencyKey, ...content } =
    accepted.message;
  let message: InboundMessage;
  const fields = {
    channel: "WHATSAPP" as const,
    receivingAddress: senderAddress,
    senderAddress,
    chatAddress: accepted.chatAddress,
    channelMessageId: id,
    mentionsReceiver: false,
    occurredAt: accepted.occurredAt ?? now,
  };
  if (content.contentKind === "ALBUM")
  {
    if (accepted.index === 0)
    {
      message = InboundMessageSchema.parse({
        ...fields,
        contentKind: "ALBUM",
        imageCount: content.parts.filter(part => part.contentKind === "IMAGE").length,
        videoCount: content.parts.filter(part => part.contentKind === "VIDEO").length,
      });
    }
    else
    {
      const part = content.parts[accepted.index - 1];
      if (!part) throw new Error("Accepted album part unavailable");
      message = InboundMessageSchema.parse({ ...fields, ...part, albumMessageId: operation.nativeIds[0] });
    }
  }
  else message = InboundMessageSchema.parse({ ...content, ...fields });
  const observation = GatewayObservedMessageSchema.parse({
    workspaceId: store.workspaceId,
    accountId: operation.accountId,
    direction: "OUTBOUND",
    message,
    observedAt: now,
    timestampSource: accepted.occurredAt ? "PROVIDER" : "GATEWAY_OBSERVATION",
    edited: false,
    deleted: false,
  });
  await retainSnapshot(store, transaction, observation, accepted.native);
  await appendGatewayEvent(store, transaction, operation.accountId, {
    type: "com.digows.whatsapp.message.sent.v1",
    data: observation,
  });
}
export class SqlGatewayHistory
{
  readonly workspaceId: string;
  constructor(private readonly store: SqlGatewayStore)
  {
    this.workspaceId = store.workspaceId;
  }
  async page(input: unknown): Promise<GatewayHistoryPage>
  {
    const request = GatewayHistoryRequestSchema.parse(input);
    if (request.workspaceId !== this.workspaceId) throw new Error("History workspace mismatch");
    const cursor = request.cursor
      ? HistoryCursorSchema.parse(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")))
      : null;
    if (
      cursor
      && (cursor.workspaceId !== this.workspaceId || cursor.accountId !== request.accountId
        || cursor.chatAddress !== request.chatAddress || cursor.direction !== request.direction
        || Buffer.from(JSON.stringify(cursor)).toString("base64url") !== request.cursor)
    ) throw new Error("History cursor scope or encoding mismatch");
    return this.store.transaction(async transaction =>
    {
      let query = transaction.selectFrom("message_snapshot").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", request.accountId).where("chat_address", "=", request.chatAddress).where(
        "deleted",
        "=",
        0,
      );
      const comparison = request.direction === "forward" ? ">" : "<";
      if (cursor)
      {
        query = query.where(expression =>
          expression.or([
            expression("occurred_at", comparison, cursor.time),
            expression.and([
              expression("occurred_at", "=", cursor.time),
              expression("position", comparison, cursor.position),
            ]),
          ])
        );
      }
      const order = request.direction === "forward" ? "asc" : "desc";
      const rows = await query.orderBy("occurred_at", order).orderBy("position", order).limit(
        request.limit + 1,
      ).execute();
      const selected = rows.slice(0, request.limit);
      const boundary = selected.at(-1);
      const nextCursor = rows.length > request.limit && boundary
        ? Buffer.from(
          JSON.stringify(
            HistoryCursorSchema.parse({
              workspaceId: this.workspaceId,
              accountId: request.accountId,
              chatAddress: request.chatAddress,
              direction: request.direction,
              time: new Date(boundary.occurred_at).toISOString(),
              position: boundary.position,
            }),
          ),
        ).toString("base64url")
        : null;
      const chronological = request.direction === "forward" ? selected : selected.toReversed();
      return GatewayHistoryPageSchema.parse({
        apiVersion: "1",
        workspaceId: this.workspaceId,
        accountId: request.accountId,
        chatAddress: request.chatAddress,
        coverage: "GATEWAY_OBSERVED",
        messages: chronological.map(observedSnapshot),
        nextCursor,
      });
    });
  }
  async message(input: unknown): Promise<GatewayObservedMessage | null>
  {
    const request = GatewayMessageRequestSchema.parse(input);
    if (request.workspaceId !== this.workspaceId) throw new Error("History workspace mismatch");
    return this.store.transaction(async transaction =>
    {
      const rows = await transaction.selectFrom("message_snapshot").selectAll().where(
        "workspace_id",
        "=",
        this.workspaceId,
      ).where("account_id", "=", request.accountId).where("chat_address", "=", request.chatAddress).where(
        "message_id",
        "=",
        request.messageId,
      ).limit(2).execute();
      if (rows.length > 1) throw new Error("Message sender identity is ambiguous");
      return rows[0] ? observedSnapshot(rows[0]) : null;
    });
  }
}
