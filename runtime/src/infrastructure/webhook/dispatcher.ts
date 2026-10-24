import { signGatewayWebhook } from "@digows/whatsapp-gateway-contracts";
import pino, { type Logger } from "pino";
import { z } from "zod";
import type {
  ClaimedWebhookDelivery,
  WebhookAttemptFailure,
  WebhookOutbox,
} from "../../domain/webhook-outbox.ts";
export const WebhookDispatcherConfigurationSchema = z.strictObject({ enabled: z.boolean() });
export type WebhookDispatcherConfiguration = z.infer<typeof WebhookDispatcherConfigurationSchema>;
export class GatewayWebhookDispatcher
{
  private readonly enabled: boolean;
  private readonly controller = new AbortController();
  private running: Promise<boolean> | undefined;
  private closing: Promise<void> | undefined;
  private previousDestination: string | undefined;
  constructor(
    private readonly outbox: WebhookOutbox,
    configuration: WebhookDispatcherConfiguration,
    private readonly logger: Logger = pino(),
  )
  {
    this.enabled = WebhookDispatcherConfigurationSchema.parse(configuration).enabled;
  }
  async runOnce(): Promise<boolean>
  {
    if (!this.enabled || this.controller.signal.aborted) return false;
    this.running ??= this.perform();
    const current = this.running;
    try
    {
      return await current;
    }
    finally
    {
      if (this.running === current) this.running = undefined;
    }
  }
  private async perform(): Promise<boolean>
  {
    await this.outbox.cleanup();
    const destinations = await this.outbox.destinations();
    const previous = destinations.findIndex(value =>
      `${value.accountId}:${value.id}` === this.previousDestination
    );
    const ordered = [...destinations.slice(previous + 1), ...destinations.slice(0, previous + 1)];
    for (const destination of ordered)
    {
      if (this.controller.signal.aborted) return false;
      const claim = await this.outbox.claim(destination);
      if (!claim) continue;
      this.previousDestination = `${destination.accountId}:${destination.id}`;
      await this.deliver(claim);
      return true;
    }
    return false;
  }
  private async deliver(claim: ClaimedWebhookDelivery): Promise<void>
  {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.controller.signal.addEventListener("abort", abort, { once: true });
    if (this.controller.signal.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), claim.timeoutMs);
    let status: number | null = null;
    let failure: WebhookAttemptFailure | null = null;
    try
    {
      const body = new TextEncoder().encode(claim.body);
      const signature = await signGatewayWebhook(
        claim.secret,
        claim.event.id,
        String(Math.floor(Date.now() / 1000)),
        body,
      );
      const response = await fetch(claim.url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/cloudevents+json",
          "x-gateway-event-id": signature.eventId,
          "x-gateway-timestamp": signature.timestamp,
          "x-gateway-signature": signature.signature,
        },
        body,
      });
      status = response.status;
      if (status < 200 || status >= 300) failure = "HTTP_ERROR";
      await response.body?.cancel();
    }
    catch
    {
      failure = this.controller.signal.aborted
        ? "STOPPED"
        : controller.signal.aborted
        ? "TIMEOUT"
        : "NETWORK_ERROR";
    }
    finally
    {
      clearTimeout(timeout);
      controller.abort();
      this.controller.signal.removeEventListener("abort", abort);
    }
    const committed = await this.outbox.complete(claim, status, failure);
    this.logger.info({
      event: "gateway_webhook_attempt_finished",
      workspaceId: claim.workspaceId,
      accountId: claim.accountId,
      destinationId: claim.destinationId,
      eventId: claim.event.id,
      attempt: claim.attempt,
      statusCode: status,
      failure,
      committed,
    });
  }
  async close(): Promise<void>
  {
    this.closing ??= (async () =>
    {
      this.controller.abort();
      await this.running;
    })();
    await this.closing;
  }
}
