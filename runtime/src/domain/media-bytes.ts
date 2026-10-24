export const defaultMaximumMediaBytes = 32 * 1024 * 1024;
export function validateMediaLimit(maximumBytes: number): void
{
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
  {
    throw new Error("Media byte limit must be a positive safe integer");
  }
}
export async function collectMediaBytes(
  stream: AsyncIterable<unknown>,
  maximumBytes: number,
): Promise<Uint8Array>
{
  validateMediaLimit(maximumBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream)
  {
    if (!(chunk instanceof Uint8Array)) throw new Error("Media stream yielded invalid bytes");
    total += chunk.byteLength;
    if (total > maximumBytes) throw new Error("Media exceeds configured byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
export async function* webMediaChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array>
{
  const reader = stream.getReader();
  try
  {
    while (true)
    {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  }
  finally
  {
    // Preserve the original read/limit failure while releasing an already-ending source.
    try
    {
      await reader.cancel().catch(() => undefined);
    }
    finally
    {
      reader.releaseLock();
    }
  }
}
