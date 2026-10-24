import {
  AccountScopeSchema,
  GatewayCloudEventSchema,
  GatewayIdentifierSchema,
} from "@digows/whatsapp-gateway-contracts";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type ClaimedWebhookDelivery,
  type WebhookAttemptFailure,
  type WebhookDeliveryObservation,
  type WebhookDeliveryPolicyInput,
  WebhookDeliveryPolicySchema,
  type WebhookDestination,
  type WebhookOutbox,
} from "../../domain/webhook-outbox.ts";
import { type GatewayTransaction, SqlGatewayStore } from "./gateway-store.ts";
const DestinationSchema = AccountScopeSchema.extend({
  id: GatewayIdentifierSchema,
  url: z.url().refine(value =>
  {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  }, "Webhook URL must be HTTP(S) without embedded credentials"),
  secret: z.string().min(32).max(4096),
  enabled: z.boolean(),
});
export class SqlWebhookOutbox implements WebhookOutbox
{
  readonly policy;
  constructor(private readonly store: SqlGatewayStore, policy: WebhookDeliveryPolicyInput = {})
  {
    this.policy = WebhookDeliveryPolicySchema.parse(policy);
  }
  async configure(input: WebhookDestination): Promise<void>
  {
    const destination = DestinationSchema.parse(input);
    if (destination.workspaceId !== this.store.workspaceId)
    {
      throw new Error("Webhook destination workspace mismatch");
    }
    await this.store.transaction(async transaction =>
    {
      const account = await transaction.updateTable("account").set({ generation: sql`generation` }).where(
        "workspace_id",
        "=",
        this.store.workspaceId,
      ).where("id", "=", destination.accountId).returning("id").executeTakeFirst();
      if (!account) throw new Error("Webhook account unavailable");
      const values = {
        url: destination.url,
        secret: destination.secret,
        enabled: destination.enabled ? 1 : 0,
        delivery_lifetime_ms: this.policy.deliveryLifetimeMs,
      };
      await transaction.insertInto("webhook_destination").values({
        workspace_id: this.store.workspaceId,
        account_id: destination.accountId,
        id: destination.id,
        ...values,
      }).onConflict(conflict => conflict.columns(["workspace_id", "account_id", "id"]).doUpdateSet(values))
        .execute();
    });
  }
  async destinations(): Promise<readonly WebhookDestination[]>
  {
    return this.store.transaction(async transaction =>
      (await transaction.selectFrom("webhook_destination").selectAll().where(
        "workspace_id",
        "=",
        this.store.workspaceId,
      ).where("enabled", "=", 1).orderBy("account_id").orderBy("id").execute()).map(row =>
        DestinationSchema.parse({
          workspaceId: row.workspace_id,
          accountId: row.account_id,
          id: row.id,
          url: row.url,
          secret: row.secret,
          enabled: row.enabled === 1,
        })
      )
    );
  }
  private async lockAccount(transaction: GatewayTransaction, accountId: string): Promise<void>
  {
    await transaction.updateTable("account").set({ generation: sql`generation` }).where(
      "workspace_id",
      "=",
      this.store.workspaceId,
    ).where("id", "=", accountId).execute();
  }
  async claim(input: WebhookDestination): Promise<ClaimedWebhookDelivery | null>
  {
    const destination = DestinationSchema.parse(input);
    if (destination.workspaceId !== this.store.workspaceId) throw new Error("Webhook claim scope mismatch");
    return this.store.transaction(async transaction =>
    {
      await this.lockAccount(transaction, destination.accountId);
      const configured = await transaction.selectFrom("webhook_destination").selectAll().where(
        "workspace_id",
        "=",
        this.store.workspaceId,
      ).where("account_id", "=", destination.accountId).where("id", "=", destination.id).where(
        "enabled",
        "=",
        1,
      ).executeTakeFirst();
      if (!configured) return null;
      const now = await this.store.databaseTime(transaction);
      const row = await transaction.selectFrom("webhook_delivery").selectAll().where(
        "workspace_id",
        "=",
        this.store.workspaceId,
      ).where("account_id", "=", destination.accountId).where("destination_id", "=", destination.id).where(
        "state",
        "in",
        ["PENDING", "DELIVERING"],
      ).orderBy("event_sequence").limit(1).executeTakeFirst();
      if (!row) return null;
      if (
        row.state === "DELIVERING" && row.lease_until && new Date(row.lease_until).getTime() > now.getTime()
      ) return null;
      const expired = new Date(row.expires_at).getTime() <= now.getTime();
      if (expired || row.attempts >= this.policy.maximumAttempts)
      {
        await transaction.updateTable("webhook_delivery").set({
          state: expired ? "EXPIRED" : "EXHAUSTED",
          terminal_at: now.toISOString(),
          claim_token: null,
          lease_until: null,
        }).where("workspace_id", "=", this.store.workspaceId).where("account_id", "=", destination.accountId)
          .where("destination_id", "=", destination.id).where("event_id", "=", row.event_id).execute();
        return null;
      }
      if (new Date(row.next_attempt_at).getTime() > now.getTime()) return null;
      const event = GatewayCloudEventSchema.parse(JSON.parse(row.body));
      if (
        event.workspaceid !== this.store.workspaceId || event.accountid !== destination.accountId
        || event.id !== row.event_id || event.sequence !== row.event_sequence
      ) throw new Error("Webhook event identity mismatch");
      const token = randomUUID();
      const timeoutMs = Math.max(
        1,
        Math.min(this.policy.timeoutMs, new Date(row.expires_at).getTime() - now.getTime()),
      );
      await transaction.updateTable("webhook_delivery").set({
        state: "DELIVERING",
        attempts: row.attempts + 1,
        claim_token: token,
        lease_until: new Date(now.getTime() + timeoutMs + 1000).toISOString(),
      }).where("workspace_id", "=", this.store.workspaceId).where("account_id", "=", destination.accountId)
        .where("destination_id", "=", destination.id).where("event_id", "=", row.event_id).execute();
      return {
        workspaceId: this.store.workspaceId,
        accountId: destination.accountId,
        destinationId: destination.id,
        event,
        body: row.body,
        url: configured.url,
        secret: configured.secret,
        token,
        attempt: row.attempts + 1,
        timeoutMs,
      };
    });
  }
  async complete(
    claim: ClaimedWebhookDelivery,
    status: number | null,
    failure: WebhookAttemptFailure | null,
  ): Promise<boolean>
  {
    if (claim.workspaceId !== this.store.workspaceId) throw new Error("Webhook completion scope mismatch");
    return this.store.transaction(async transaction =>
    {
      await this.lockAccount(transaction, claim.accountId);
      const row = await transaction.selectFrom("webhook_delivery").selectAll().where(
        "workspace_id",
        "=",
        this.store.workspaceId,
      ).where("account_id", "=", claim.accountId).where("destination_id", "=", claim.destinationId).where(
        "event_id",
        "=",
        claim.event.id,
      ).where("state", "=", "DELIVERING").where("claim_token", "=", claim.token).executeTakeFirst();
      if (!row) return false;
      const now = await this.store.databaseTime(transaction);
      const expired = new Date(row.expires_at).getTime() <= now.getTime();
      const succeeded = status !== null && status >= 200 && status < 300 && failure === null && !expired;
      if (succeeded && this.policy.successRetentionMs === 0)
      {
        const deleted = await transaction.deleteFrom("webhook_delivery").where(
          "workspace_id",
          "=",
          this.store.workspaceId,
        ).where("account_id", "=", claim.accountId).where("destination_id", "=", claim.destinationId).where(
          "event_id",
          "=",
          claim.event.id,
        ).where("claim_token", "=", claim.token).executeTakeFirstOrThrow();
        return deleted.numDeletedRows === 1n;
      }
      const terminal = succeeded || expired || row.attempts >= this.policy.maximumAttempts;
      const backoff = Math.min(
        this.policy.maximumRetryDelayMs,
        this.policy.minimumRetryDelayMs * 2 ** (row.attempts - 1),
      );
      const updated = await transaction.updateTable("webhook_delivery").set({
        state: succeeded ? "SUCCEEDED" : expired ? "EXPIRED" : terminal ? "EXHAUSTED" : "PENDING",
        terminal_at: terminal ? now.toISOString() : null,
        next_attempt_at: new Date(now.getTime() + Math.ceil(backoff * (0.5 + Math.random() / 2)))
          .toISOString(),
        claim_token: null,
        lease_until: null,
        last_status: status,
        failure,
      }).where("workspace_id", "=", this.store.workspaceId).where("account_id", "=", claim.accountId).where(
        "destination_id",
        "=",
        claim.destinationId,
      ).where("event_id", "=", claim.event.id).where("claim_token", "=", claim.token)
        .executeTakeFirstOrThrow();
      return updated.numUpdatedRows === 1n;
    });
  }
  async cleanup(): Promise<void>
  {
    await this.store.transaction(async transaction =>
    {
      const now = await this.store.databaseTime(transaction);
      await transaction.updateTable("webhook_delivery").set({
        state: "EXPIRED",
        terminal_at: now.toISOString(),
        claim_token: null,
        lease_until: null,
      }).where("workspace_id", "=", this.store.workspaceId).where("state", "in", ["PENDING", "DELIVERING"])
        .where("expires_at", "<=", now.toISOString()).execute();
      for (const success of [true, false])
      {
        const retention = success ? this.policy.successRetentionMs : this.policy.terminalRetentionMs;
        await transaction.deleteFrom("webhook_delivery").where("workspace_id", "=", this.store.workspaceId)
          .where("state", success ? "=" : "in", success ? "SUCCEEDED" : ["EXHAUSTED", "EXPIRED"]).where(
            "terminal_at",
            "<=",
            new Date(now.getTime() - retention).toISOString(),
          ).execute();
      }
    });
  }
  async deliveries(accountId: string, destinationId: string): Promise<readonly WebhookDeliveryObservation[]>
  {
    return this.store.transaction(async transaction =>
      (await transaction.selectFrom("webhook_delivery").selectAll().where(
        "workspace_id",
        "=",
        this.store.workspaceId,
      ).where("account_id", "=", GatewayIdentifierSchema.parse(accountId)).where(
        "destination_id",
        "=",
        GatewayIdentifierSchema.parse(destinationId),
      ).orderBy("event_sequence").execute()).map(row => ({
        workspaceId: row.workspace_id,
        accountId: row.account_id,
        destinationId: row.destination_id,
        eventId: row.event_id,
        state: row.state,
        attempts: row.attempts,
        lastStatus: row.last_status,
        failure: row.failure,
      }))
    );
  }
}
