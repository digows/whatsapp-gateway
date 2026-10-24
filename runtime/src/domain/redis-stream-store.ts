import type {
  AccountScope,
  GatewayCloudEvent,
  GatewayStreamNames,
  GatewayStreamReceipt,
} from "@digows/whatsapp-gateway-contracts";
import type { GatewayPrincipal } from "./authorization.ts";
export type GatewayStreamKind = "events" | "results";
export interface ClaimedStreamPublication extends AccountScope
{
  readonly stream: string;
  readonly token: string;
  readonly event: GatewayCloudEvent;
}
export interface StreamPublicationWork
{
  readonly claim: ClaimedStreamPublication | null;
  readonly advanced: boolean;
}
export interface RedisStreamStore
{
  readonly workspaceId: string;
  register(accountId: string, streams: GatewayStreamNames): Promise<void>;
  intake(
    principal: GatewayPrincipal,
    accountId: string,
    stream: string,
    messageId: string,
    payload: string,
  ): Promise<GatewayStreamReceipt>;
  publication(
    accountId: string,
    stream: string,
    kind: GatewayStreamKind,
    lifetimeMs: number,
  ): Promise<StreamPublicationWork>;
  published(claim: ClaimedStreamPublication): Promise<boolean>;
  releasePublication(claim: ClaimedStreamPublication): Promise<void>;
}
