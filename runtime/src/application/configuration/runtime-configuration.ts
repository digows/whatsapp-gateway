import { AccountScopeSchema, GatewayIdentifierSchema } from "@digows/whatsapp-gateway-contracts";
import { z } from "zod";
import { AccountGrantSchema, GatewayPrincipal } from "../../domain/authorization.ts";
import { WebhookDeliveryPolicySchema } from "../../domain/webhook-outbox.ts";
import { GatewayHttpConfigurationSchema } from "../../infrastructure/http/transport.ts";
import { GatewayRedisConfigurationSchema } from "../../infrastructure/redis/transport.ts";
import { MediaStorageConfigurationSchema } from "../../infrastructure/s3/configuration.ts";
import { StorageConfigurationSchema } from "../../infrastructure/sql/storage.ts";
import { WebhookDestinationSchema } from "../../infrastructure/sql/webhook-outbox.ts";
import { FleetConfigurationSchema } from "../fleet-participant.ts";
import { GatewayConfigurationSchema } from "../gateway.ts";
export const GatewayLogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
export const GatewayLogComponentSchema = z.enum([
  "runtime",
  "sessions",
  "baileys",
  "http",
  "redis",
  "webhooks",
  "fleet",
]);
export type GatewayLogComponent = z.infer<typeof GatewayLogComponentSchema>;
export const GatewayLoggingConfigurationSchema = z.strictObject({
  level: GatewayLogLevelSchema.default("info"),
  components: z.partialRecord(GatewayLogComponentSchema, GatewayLogLevelSchema).default({}),
});
export type GatewayLoggingConfiguration = z.infer<typeof GatewayLoggingConfigurationSchema>;
export const GatewayRuntimeConfigurationSchema = z.strictObject({
  storage: StorageConfigurationSchema,
  workspaces: z.array(z.strictObject({
    workspaceId: GatewayIdentifierSchema,
    accounts: z.array(z.strictObject({ accountId: GatewayIdentifierSchema, enabled: z.boolean().optional() }))
      .default([]),
    fleet: FleetConfigurationSchema.prefault({}),
  })).min(1),
  principals: z.array(
    z.strictObject({
      id: z.string().min(1).max(256),
      grants: z.array(AccountGrantSchema).min(1),
      httpToken: z.string().min(32).max(1024).optional(),
    }),
  ).default([]),
  http: GatewayHttpConfigurationSchema.prefault({ enabled: true }),
  redis: z.strictObject({
    transport: GatewayRedisConfigurationSchema.prefault({ enabled: false }),
    bindings: z.array(AccountScopeSchema.extend({ principalId: z.string().min(1) })).default([]),
    retentionMs: z.number().int().nonnegative().max(365 * 86400000).default(0),
  }).prefault({}),
  webhooks: z.strictObject({
    enabled: z.boolean().default(false),
    policy: WebhookDeliveryPolicySchema.prefault({}),
    destinations: z.array(WebhookDestinationSchema).default([]),
  }).prefault({}),
  media: MediaStorageConfigurationSchema.prefault({ mode: "direct" }),
  gateway: GatewayConfigurationSchema.prefault({}),
  logging: GatewayLoggingConfigurationSchema.prefault({}),
}).superRefine((configuration, context) =>
{
  const workspaces = new Set(configuration.workspaces.map(workspace => workspace.workspaceId));
  const principals = new Map(
    configuration.principals.map(
      principal => [principal.id, new GatewayPrincipal(principal.id, principal.grants)],
    ),
  );
  const fail = (message: string): void =>
  {
    context.addIssue({ code: "custom", message });
  };
  if (
    workspaces.size !== configuration.workspaces.length || principals.size !== configuration.principals.length
  ) fail("Duplicate workspace or principal configuration");
  for (const workspace of configuration.workspaces)
  {
    if (new Set(workspace.accounts.map(account => account.accountId)).size !== workspace.accounts.length)
    {
      fail("Duplicate configured account");
    }
  }
  if (configuration.http.enabled && !configuration.principals.some(principal => principal.httpToken))
  {
    fail("Enabled HTTP requires an authenticated credential");
  }
  const bindings = new Set<string>();
  for (const binding of configuration.redis.bindings)
  {
    const principal = principals.get(binding.principalId);
    if (!workspaces.has(binding.workspaceId) || !principal)
    {
      fail("Redis binding references an unavailable workspace or principal");
      continue;
    }
    try
    {
      principal.authorize(binding);
    }
    catch
    {
      fail("Redis binding is not authorized by its principal");
    }
    const key = `${binding.workspaceId}:${binding.accountId}`;
    if (bindings.has(key)) fail("Duplicate Redis account binding");
    bindings.add(key);
  }
  const destinations = new Set<string>();
  for (const destination of configuration.webhooks.destinations)
  {
    if (!workspaces.has(destination.workspaceId))
    {
      fail("Webhook destination references an unavailable workspace");
    }
    const key = `${destination.workspaceId}:${destination.accountId}:${destination.id}`;
    if (destinations.has(key)) fail("Duplicate webhook destination");
    destinations.add(key);
  }
});
export type GatewayRuntimeConfiguration = z.infer<typeof GatewayRuntimeConfigurationSchema>;
