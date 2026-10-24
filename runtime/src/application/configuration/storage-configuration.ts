import { GatewayIdentifierSchema } from "@digows/whatsapp-gateway-contracts";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  PostgresStorageConfigurationSchema,
  type StorageConfiguration,
} from "../../infrastructure/sql/storage.ts";

export const GatewayRuntimeStorageConfigurationSchema = z.discriminatedUnion("engine", [
  z.strictObject({ engine: z.literal("sqlite"), mode: z.literal("local"), directory: z.string().min(1) }),
  PostgresStorageConfigurationSchema,
]);
export type GatewayRuntimeStorageConfiguration = z.infer<typeof GatewayRuntimeStorageConfigurationSchema>;

export function gatewayWorkspaceStorageConfiguration(
  input: unknown,
  workspaceId: string,
): StorageConfiguration
{
  const configuration = GatewayRuntimeStorageConfigurationSchema.parse(input);
  const canonical = GatewayIdentifierSchema.parse(workspaceId);
  return configuration.engine === "postgresql" ? configuration : {
    engine: "sqlite",
    mode: "local",
    workspaceId: canonical,
    filename: join(resolve(configuration.directory), `${canonical}.sqlite`),
  };
}
function selectedStorageConfigurations(
  configuration: GatewayRuntimeStorageConfiguration,
  workspaceIds: readonly string[],
): readonly StorageConfiguration[]
{
  const canonical = [...new Set(z.array(GatewayIdentifierSchema).min(1).parse(workspaceIds))];
  return configuration.engine === "postgresql"
    ? [configuration]
    : canonical.map(workspaceId => gatewayWorkspaceStorageConfiguration(configuration, workspaceId));
}
export async function migrateGatewayRuntimeStorage(
  input: unknown,
  workspaceIds: readonly string[],
): Promise<void>
{
  const configuration = GatewayRuntimeStorageConfigurationSchema.parse(input);
  const selected = selectedStorageConfigurations(configuration, workspaceIds);
  if (configuration.engine === "sqlite")
  {
    await mkdir(configuration.directory, { recursive: true, mode: 0o700 });
  }
  for (const storage of selected) await migrateGatewayStorage(storage);
}
export async function verifyGatewayRuntimeStorage(
  input: unknown,
  workspaceIds: readonly string[],
  logger?: Logger,
): Promise<void>
{
  const configuration = GatewayRuntimeStorageConfigurationSchema.parse(input);
  for (const selected of selectedStorageConfigurations(configuration, workspaceIds))
  {
    const storage = await openGatewayStorage(selected, logger);
    await storage.close();
  }
}
