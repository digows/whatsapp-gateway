#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import pino from "pino";
import { componentLogger, createRuntimeLogger } from "./application/configuration/logging.ts";
import { GatewayRuntimeConfigurationSchema } from "./application/configuration/runtime-configuration.ts";
import {
  migrateGatewayRuntimeStorage,
  verifyGatewayRuntimeStorage,
} from "./application/configuration/storage-configuration.ts";
import { GatewayRuntime } from "./application/runtime.ts";
import { describeWhatsAppError } from "./domain/error-details.ts";
type GatewayCliFailureCode =
  | "UNSUPPORTED_COMMAND"
  | "INVALID_ARGUMENTS"
  | "CONFIG_REQUIRED"
  | "CONFIG_UNREADABLE"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_INVALID";
class GatewayCliFailure extends Error
{
  constructor(readonly code: GatewayCliFailureCode)
  {
    super(code);
    this.name = "GatewayCliFailure";
  }
}
async function main(): Promise<void>
{
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === "--help")
  {
    process.stdout.write(
      "whatsapp-gateway [serve|migrate|verify-storage] --config <operator.json>\nGATEWAY_CONFIG may supply the explicit configuration path.\n",
    );
    return;
  }
  const first = arguments_[0];
  const command = first && !first.startsWith("--") ? arguments_.shift() : "serve";
  if (command !== "serve" && command !== "migrate" && command !== "verify-storage")
  {
    throw new GatewayCliFailure("UNSUPPORTED_COMMAND");
  }
  let filename = process.env["GATEWAY_CONFIG"];
  if (arguments_.length)
  {
    if (arguments_.length !== 2 || arguments_[0] !== "--config" || !arguments_[1])
    {
      throw new GatewayCliFailure("INVALID_ARGUMENTS");
    }
    filename = arguments_[1];
  }
  if (!filename) throw new GatewayCliFailure("CONFIG_REQUIRED");
  let serialized: string;
  try
  {
    serialized = await readFile(filename, "utf8");
  }
  catch
  {
    throw new GatewayCliFailure("CONFIG_UNREADABLE");
  }
  let input: unknown;
  try
  {
    input = JSON.parse(serialized);
  }
  catch
  {
    throw new GatewayCliFailure("CONFIG_INVALID_JSON");
  }
  const parsed = GatewayRuntimeConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new GatewayCliFailure("CONFIG_INVALID");
  const configuration = parsed.data;
  const logger = componentLogger(
    createRuntimeLogger(configuration.logging),
    configuration.logging,
    "runtime",
  );
  if (command === "migrate")
  {
    await migrateGatewayRuntimeStorage(
      configuration.storage,
      configuration.workspaces.map(value => value.workspaceId),
    );
    logger.info({ event: "storage_migration_completed", storageEngine: configuration.storage.engine });
    return;
  }
  if (command === "verify-storage")
  {
    await verifyGatewayRuntimeStorage(
      configuration.storage,
      configuration.workspaces.map(value => value.workspaceId),
      logger,
    );
    logger.info({ event: "storage_verification_completed", storageEngine: configuration.storage.engine });
    return;
  }
  const runtime = new GatewayRuntime(configuration);
  let stopping: Promise<void> | undefined;
  const stop = (): void =>
  {
    stopping ??= runtime.close().catch(error =>
    {
      process.exitCode = 1;
      logger.error({ event: "runtime_shutdown_failed", failure: describeWhatsAppError(error) });
    }).finally(() =>
    {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try
  {
    await runtime.start();
  }
  catch (error)
  {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    throw error;
  }
}
void main().catch(error =>
{
  process.exitCode = 1;
  pino().fatal({
    event: "runtime_start_failed",
    failure: describeWhatsAppError(error),
    ...(error instanceof GatewayCliFailure ? { cliFailure: error.code } : {}),
  });
});
