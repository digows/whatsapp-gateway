import pino, { type Logger } from "pino";
import { type GatewayLogComponent, type GatewayLoggingConfiguration } from "./runtime-configuration.ts";
export function createRuntimeLogger(configuration: GatewayLoggingConfiguration): Logger
{
  return pino({
    name: "whatsapp-gateway",
    level: configuration.level,
    base: { service: "whatsapp-gateway", pid: process.pid },
  });
}
export function componentLogger(
  logger: Logger,
  configuration: GatewayLoggingConfiguration,
  component: GatewayLogComponent,
): Logger
{
  return logger.child({ component }, { level: configuration.components[component] ?? configuration.level });
}
