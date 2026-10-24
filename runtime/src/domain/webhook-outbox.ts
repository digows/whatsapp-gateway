import type { AccountScope, GatewayCloudEvent } from "@digows/whatsapp-gateway-contracts";
import { z } from "zod";
export const WebhookDeliveryPolicySchema = z.strictObject({
  timeoutMs: z.number().int().positive().max(60000).default(10000),
  minimumRetryDelayMs: z.number().int().positive().max(86400000).default(1000),
  maximumRetryDelayMs: z.number().int().positive().max(86400000).default(60000),
  maximumAttempts: z.number().int().positive().max(1000).default(12),
  deliveryLifetimeMs: z.number().int().positive().max(2147483647).default(86400000),
  terminalRetentionMs: z.number().int().nonnegative().max(365 * 86400000).default(7 * 86400000),
  successRetentionMs: z.number().int().nonnegative().max(365 * 86400000).default(0),
}).refine(
  value => value.maximumRetryDelayMs >= value.minimumRetryDelayMs,
  "Maximum retry delay is below minimum",
);
export type WebhookDeliveryPolicy = z.infer<typeof WebhookDeliveryPolicySchema>;
export type WebhookDeliveryPolicyInput = z.input<typeof WebhookDeliveryPolicySchema>;
export interface WebhookDestination extends AccountScope
{
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly enabled: boolean;
}
export type WebhookDeliveryState = "PENDING" | "DELIVERING" | "SUCCEEDED" | "EXHAUSTED" | "EXPIRED";
export type WebhookAttemptFailure = "TIMEOUT" | "NETWORK_ERROR" | "HTTP_ERROR" | "STOPPED";
export interface ClaimedWebhookDelivery extends AccountScope
{
  readonly destinationId: string;
  readonly event: GatewayCloudEvent;
  readonly body: string;
  readonly url: string;
  readonly secret: string;
  readonly token: string;
  readonly attempt: number;
  readonly timeoutMs: number;
}
export interface WebhookDeliveryObservation extends AccountScope
{
  readonly destinationId: string;
  readonly eventId: string;
  readonly state: WebhookDeliveryState;
  readonly attempts: number;
  readonly lastStatus: number | null;
  readonly failure: WebhookAttemptFailure | null;
}
export interface WebhookOutbox
{
  readonly policy: WebhookDeliveryPolicy;
  destinations(): Promise<readonly WebhookDestination[]>;
  claim(destination: WebhookDestination): Promise<ClaimedWebhookDelivery | null>;
  complete(
    claim: ClaimedWebhookDelivery,
    status: number | null,
    failure: WebhookAttemptFailure | null,
  ): Promise<boolean>;
  cleanup(): Promise<void>;
}
