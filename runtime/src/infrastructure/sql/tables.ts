import type { GatewayCommandState, OperationState, SessionState } from "@digows/whatsapp-gateway-contracts";
import type { ColumnType, Generated } from "kysely";
export type JsonColumn = ColumnType<unknown, string, string>;
export type NullableJsonColumn = ColumnType<unknown, string | null, string | null>;
import type { WebhookAttemptFailure, WebhookDeliveryState } from "../../domain/webhook-outbox.ts";
export type NullableTimestampColumn = ColumnType<Date | string | null, string | null, string | null>;
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
export interface CommandTable
{
  workspace_id: string;
  account_id: string;
  request_id: string;
  sequence: number;
  digest: string;
  command: JsonColumn;
  state: GatewayCommandState;
  response: NullableJsonColumn;
  failure: string | null;
  claim_token: string | null;
  generation: number | null;
  created_at: TimestampColumn;
}
export interface RuntimeTable
{
  workspace_id: string;
  id: string;
  capacity: number;
  draining: number;
  expires_at: TimestampColumn;
}
export interface DesiredAccountTable
{
  workspace_id: string;
  account_id: string;
  revision: number;
  enabled: number;
  assigned_runtime_id: string | null;
  attempted_revision: number;
  blocked_revision: number;
}
export interface PublicEventTable
{
  workspace_id: string;
  account_id: string;
  id: string;
  sequence: number;
  envelope: JsonColumn;
  created_at: TimestampColumn;
}
export interface WebhookDestinationTable
{
  workspace_id: string;
  account_id: string;
  id: string;
  url: string;
  secret: string;
  enabled: number;
  delivery_lifetime_ms: number;
}
export interface WebhookDeliveryTable
{
  workspace_id: string;
  account_id: string;
  destination_id: string;
  event_id: string;
  event_sequence: number;
  body: string;
  state: WebhookDeliveryState;
  attempts: number;
  next_attempt_at: TimestampColumn;
  expires_at: TimestampColumn;
  terminal_at: NullableTimestampColumn;
  claim_token: string | null;
  lease_until: NullableTimestampColumn;
  last_status: number | null;
  failure: WebhookAttemptFailure | null;
}
export interface StreamReceiptTable
{
  workspace_id: string;
  account_id: string;
  source_stream: string;
  source_message_id: string;
  digest: string;
  receipt: JsonColumn;
}
export interface StreamCursorTable
{
  workspace_id: string;
  account_id: string;
  stream_name: string;
  kind: "events" | "results";
  position: number;
  claim_token: string | null;
  claimed_sequence: number | null;
  lease_until: NullableTimestampColumn;
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
  command: CommandTable;
  runtime: RuntimeTable;
  desired_account: DesiredAccountTable;
  public_event: PublicEventTable;
  webhook_destination: WebhookDestinationTable;
  webhook_delivery: WebhookDeliveryTable;
  stream_receipt: StreamReceiptTable;
  stream_cursor: StreamCursorTable;
}
export function jsonValue(value: unknown): unknown
{
  return typeof value === "string" ? JSON.parse(value) : value;
}
