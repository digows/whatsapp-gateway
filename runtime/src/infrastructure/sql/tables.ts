import type { OperationState, SessionState } from "@digows/whatsapp-gateway-contracts";
import type { ColumnType, Generated } from "kysely";
export type JsonColumn = ColumnType<unknown, string, string>;
export type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;
export type TimestampColumn = ColumnType<Date | string, string, string>;
export interface AccountTable
{
  workspace_id: string;
  id: string;
  state: Generated<SessionState>;
  generation: Generated<number>;
  native_jid: string | null;
  qr: string | null;
}
export interface AuthenticationTable
{
  workspace_id: string;
  account_id: string;
  category: string;
  key_id: string;
  serialized_value: string;
}
export interface OperationTable
{
  workspace_id: string;
  account_id: string;
  key: string;
  digest: string;
  native_ids: JsonColumn;
  accepted_parts: Generated<number>;
  state: Generated<OperationState>;
}
export interface EventTable
{
  workspace_id: string;
  account_id: string;
  id: string;
  message: NullableJsonColumn;
  native: string;
  kind: Generated<string>;
  error_name: string | null;
  created_at: TimestampColumn;
}
export interface MediaTable
{
  workspace_id: string;
  account_id: string;
  source_id: string;
  reference: JsonColumn;
}
export interface PacingTable
{
  workspace_id: string;
  account_id: string;
  next_send_at: TimestampColumn;
  started_at: TimestampColumn;
  last_active_at: TimestampColumn;
  recent_times: JsonColumn;
  daily_date: string;
  daily_count: number;
}
export interface DeliveryTable
{
  workspace_id: string;
  account_id: string;
  message_id: string;
  status: string;
  chat_address: string | null;
  observed_at: TimestampColumn;
}
export interface SchemaVersionTable
{
  version: number;
}
export interface GatewayTables
{
  account: AccountTable;
  authentication: AuthenticationTable;
  operation: OperationTable;
  event: EventTable;
  media: MediaTable;
  pacing: PacingTable;
  delivery: DeliveryTable;
  schema_version: SchemaVersionTable;
}
export function jsonValue(value: unknown): unknown
{
  return typeof value === "string" ? JSON.parse(value) : value;
}
