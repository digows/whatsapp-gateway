import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { describeWhatsAppError } from "../../domain/error-details.ts";
import type { SocketConfiguration } from "./baileys-connection.ts";
type NativeLogger = NonNullable<SocketConfiguration["logger"]>;
type NativeLogLevel = "trace" | "debug" | "info" | "warn" | "error";
const safeSignals = new Set([
  "connected to WA",
  "not logged in, attempting registration...",
  "pair success recv",
  "pairing configured successfully, expect to restart the connection...",
  "connection errored",
  "Event buffer destroyed",
  "recv xml",
  "xml send",
  "closing socket",
  "opened connection to WA",
]);
/** Protocol objects and free-form strings may contain QR/auth keys, JIDs or message bodies. */
export class BaileysProtocolLogger implements NativeLogger
{
  constructor(
    private readonly logger: Logger,
    private readonly intentionallyStopping: () => boolean = () => false,
  )
  {}
  get level(): string
  {
    return this.logger.level;
  }
  set level(value: string)
  {
    this.logger.level = value;
  }
  child(_bindings: Record<string, unknown>): NativeLogger
  {
    return new BaileysProtocolLogger(this.logger, this.intentionallyStopping);
  }
  trace(value: unknown, message?: string): void
  {
    this.write("trace", value, message);
  }
  debug(value: unknown, message?: string): void
  {
    this.write("debug", value, message);
  }
  info(value: unknown, message?: string): void
  {
    this.write("info", value, message);
  }
  warn(value: unknown, message?: string): void
  {
    this.write("warn", value, message);
  }
  error(value: unknown, message?: string): void
  {
    this.write("error", value, message);
  }
  private write(level: NativeLogLevel, value: unknown, message?: string): void
  {
    const candidate = message ?? (typeof value === "string" ? value : "");
    if (candidate === "connection errored" && this.intentionallyStopping())
    {
      this.logger.debug({ event: "socket_closed_intentionally" });
      return;
    }

    const failure = typeof value === "object" && value !== null && "err" in value
      ? describeWhatsAppError(value.err)
      : undefined;
    this.logger[level]({
      event: "baileys_protocol",
      signal: safeSignals.has(candidate) ? candidate : "unclassified",
      ...(candidate && !safeSignals.has(candidate)
        ? { signalHash: createHash("sha256").update(candidate).digest("hex") }
        : {}),
      ...(failure ? { failure } : {}),
    });
  }
}
