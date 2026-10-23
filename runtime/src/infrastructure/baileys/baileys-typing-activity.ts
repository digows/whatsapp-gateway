import type { WASocket } from "baileys";
import type { Logger } from "pino";
import { describeWhatsAppError } from "../../domain/error-details.ts";
import { withBaileysTimeout } from "./baileys-socket-lifecycle.ts";

export interface BaileysTypingConfiguration
{
  readonly minimumDelayMs: number;
  readonly maximumDelayMs: number;
  readonly presenceTimeoutMs: number;
  readonly heartbeatTtlMs: number;
  readonly minimumHeartbeatIntervalMs: number;
  readonly maximumHeartbeatIntervalMs: number;
}

export const baileysTypingConfiguration: BaileysTypingConfiguration = {
  minimumDelayMs: 400,
  maximumDelayMs: 1000,
  presenceTimeoutMs: 1000,
  heartbeatTtlMs: 30000,
  minimumHeartbeatIntervalMs: 4000,
  maximumHeartbeatIntervalMs: 7000,
};

type PresenceSocket = Pick<WASocket, "sendPresenceUpdate">;

export class BaileysTypingActivity
{
  private stopped = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private finishWait: (() => void) | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly socket: PresenceSocket,
    private readonly recipientJid: string,
    private readonly configuration: BaileysTypingConfiguration,
    private readonly logger: Logger,
    private readonly onStopped: () => void,
    private readonly mayClear: () => boolean = () => true,
  )
  {}

  async start(ttlMs: number): Promise<void>
  {
    if (this.stopped) return;
    this.expiryTimer = setTimeout(() =>
    {
      void this.stop();
    }, ttlMs);
    this.expiryTimer.unref();
    await this.compose();
  }

  async waitBeforeSend(): Promise<void>
  {
    await this.wait(this.randomDelay(this.configuration.minimumDelayMs, this.configuration.maximumDelayMs));
  }

  async heartbeat(): Promise<void>
  {
    while (!this.isStopped())
    {
      await this.wait(this.randomDelay(
        this.configuration.minimumHeartbeatIntervalMs,
        this.configuration.maximumHeartbeatIntervalMs,
      ));
      if (!this.isStopped()) await this.compose();
    }
  }

  stop(): Promise<void>
  {
    if (this.stopping !== undefined) return this.stopping;
    this.stopped = true;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.waitTimer);
    this.finishWait?.();
    this.onStopped();
    this.stopping = this.presence("paused");
    return this.stopping;
  }

  private isStopped(): boolean
  {
    return this.stopped;
  }

  private async compose(): Promise<void>
  {
    if (this.stopped) return;
    try
    {
      const pending = this.socket.sendPresenceUpdate("composing", this.recipientJid);
      // A timed-out transport call can complete later. Clear that late indicator too.
      void pending.then(() =>
      {
        if (this.stopped) void this.presence("paused");
      }, () => undefined);
      await withBaileysTimeout(pending, this.configuration.presenceTimeoutMs, "typing presence");
    }
    catch (error)
    {
      this.logger.warn({
        event: "typing_presence_failed",
        state: "composing",
        failure: describeWhatsAppError(error),
      });
      await this.stop();
    }
  }

  private async presence(state: "paused"): Promise<void>
  {
    if (!this.mayClear()) return;
    try
    {
      await withBaileysTimeout(
        this.socket.sendPresenceUpdate(state, this.recipientJid),
        this.configuration.presenceTimeoutMs,
        "typing cleanup",
      );
    }
    catch (error)
    {
      this.logger.warn({ event: "typing_presence_failed", state, failure: describeWhatsAppError(error) });
    }
  }

  private wait(delayMs: number): Promise<void>
  {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) =>
    {
      this.finishWait = resolve;
      this.waitTimer = setTimeout(() =>
      {
        this.finishWait = undefined;
        this.waitTimer = undefined;
        resolve();
      }, delayMs);
    });
  }

  private randomDelay(minimum: number, maximum: number): number
  {
    return Math.round(minimum + Math.random() * (maximum - minimum));
  }
}
