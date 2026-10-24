import type { WASocket } from "baileys";

export interface BaileysSocketTiming
{
  readonly connectTimeoutMs: number;
  readonly keepAliveIntervalMs: number;
  readonly defaultQueryTimeoutMs: number;
  readonly sendTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

export const baileysSocketTiming: BaileysSocketTiming = {
  connectTimeoutMs: 60000,
  keepAliveIntervalMs: 25000,
  defaultQueryTimeoutMs: 60000,
  sendTimeoutMs: 60000,
  closeTimeoutMs: 15000,
};

export class BaileysOperationTimeoutError extends Error
{
  constructor(readonly operation: string)
  {
    super(`WhatsApp ${operation} timed out`);
    this.name = "BaileysOperationTimeoutError";
  }
}

export async function withBaileysTimeout<Result>(
  task: Promise<Result>,
  timeoutMs: number,
  operation: string,
  signal?: AbortSignal,
): Promise<Result>
{
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupted: (() => void) | undefined;
  try
  {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) =>
      {
        interrupted = () => reject(new Error(`WhatsApp ${operation} interrupted`));
        if (signal?.aborted) interrupted();
        else signal?.addEventListener("abort", interrupted, { once: true });
      }),
      new Promise<never>((_resolve, reject) =>
      {
        timer = setTimeout(() => reject(new BaileysOperationTimeoutError(operation)), timeoutMs);
      }),
    ]);
  }
  finally
  {
    clearTimeout(timer);
    if (interrupted) signal?.removeEventListener("abort", interrupted);
  }
}

interface BaileysTransport
{
  readonly isClosed: boolean;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
  close(): Promise<void>;
}

interface BaileysClosableSocket
{
  readonly ws: BaileysTransport;
  readonly end: WASocket["end"];
}

export async function closeBaileysSocket(
  socket: BaileysClosableSocket,
  timeoutMs: number,
  reason?: Error,
): Promise<void>
{
  const transport = socket.ws;
  const failures: unknown[] = [];
  let ending: Promise<void>;
  try
  {
    // Baileys end() removes transport close listeners before awaiting ws.close().
    // Subscribe afterwards, or its cleanup would erase our closure confirmation.
    ending = Promise.resolve(socket.end(reason));
  }
  catch (error)
  {
    failures.push(error);
    ending = Promise.resolve();
  }
  let onClose: (() => void) | undefined;
  const closed = transport.isClosed ? Promise.resolve() : new Promise<void>((resolve) =>
  {
    onClose = resolve;
    transport.once("close", resolve);
    if (transport.isClosed) resolve();
  });
  try
  {
    try
    {
      await withBaileysTimeout(Promise.all([ending, closed]), timeoutMs, "socket close");
    }
    catch (error)
    {
      failures.push(error);
    }
    if (!transport.isClosed)
    {
      try
      {
        await withBaileysTimeout(Promise.all([transport.close(), closed]), timeoutMs, "transport close");
      }
      catch (error)
      {
        failures.push(error);
      }
    }
    if (!transport.isClosed) throw new AggregateError(failures, "WhatsApp transport closure is unconfirmed");
  }
  finally
  {
    if (onClose !== undefined) transport.removeListener("close", onClose);
  }
}
