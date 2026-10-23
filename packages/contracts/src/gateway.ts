import { z } from "zod";
import type { OutboundMessage } from "./content/outbound-message.ts";

export const AccountScopeSchema = z.strictObject({ workspaceId: z.uuid(), accountId: z.uuid() });
export type AccountScope = z.infer<typeof AccountScopeSchema>;
export const SessionStateSchema = z.enum([
  "STOPPED",
  "CONNECTING",
  "AWAITING_PAIRING",
  "CONNECTED",
  "LOGGED_OUT",
  "FAILED",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const OperationStateSchema = z.enum(["PENDING", "IN_FLIGHT", "ACCEPTED", "FAILED", "UNKNOWN"]);
export type OperationState = z.infer<typeof OperationStateSchema>;
export interface Account extends AccountScope
{
  readonly state: SessionState;
  readonly generation: number;
  readonly nativeJid: string | null;
  readonly qr: string | null;
}
export interface OperationResult
{
  readonly key: string;
  readonly digest: string;
  readonly nativeIds: readonly string[];
  readonly acceptedParts: number;
  readonly state: OperationState;
}
/** A confirmed integration boundary; implementations must not translate UNKNOWN into retry. */
export interface GatewayOperations
{
  send(accountId: string, message: OutboundMessage): Promise<OperationResult>;
  operation(accountId: string, key: string): Promise<OperationResult>;
  presence(accountId: string, chatId: string, composing: boolean): Promise<void>;
  readMedia(accountId: string, sourceId: string): Promise<Uint8Array>;
}
export interface DeliveryObservation
{
  readonly channelMessageId: string;
  readonly chatAddress: string | null;
  readonly status: string;
}
