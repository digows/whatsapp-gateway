import { DEF_MEDIA_HOST, DEFAULT_ORIGIN, getMediaKeys, type MediaType } from "baileys";
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { collectMediaBytes, webMediaChunks } from "../../domain/media-bytes.ts";
import type { VerifiedMediaFile } from "../../domain/media-stream.ts";
import type { NativeMedia } from "./baileys-media-repository.ts";

// AES-CBC adds at most16 padding bytes, followed by the native10-byte HMAC.
const nativeMacBytes = 10;
const nativeFramingBytes = 16 + nativeMacBytes;
const privateFileMode = 0o600;

function nativeMediaUrl(source: NativeMedia): string
{
  let parsed: URL | undefined;
  if (source.url && URL.canParse(source.url)) parsed = new URL(source.url);
  if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:")
  {
    throw new Error("Native media protocol is unsupported");
  }
  const host = parsed?.hostname === "a.whatsapp.net" ? DEF_MEDIA_HOST : parsed?.host ?? DEF_MEDIA_HOST;
  if (source.directPath && (!source.directPath.startsWith("/") || source.directPath.startsWith("//")))
  {
    throw new Error("Native media direct path is invalid");
  }
  const url = source.directPath ? `https://${host}${source.directPath}` : parsed?.href;
  if (!url) throw new Error("Native media source URL is unavailable");
  return url;
}

/** Counts and hashes plaintext as it passes, failing as soon as the configured limit is exceeded. */
class PlaintextMeasure extends Transform
{
  byteSize = 0;
  private readonly hash = createHash("sha256");
  constructor(private readonly maximumBytes: number)
  {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void
  {
    this.byteSize += chunk.byteLength;
    if (this.byteSize > this.maximumBytes)
    {
      callback(new Error("Media exceeds configured byte limit"));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
  digest(): Buffer
  {
    return this.hash.digest();
  }
}

/**
 * Downloads native media into a private directory with memory bounded by the transport chunk size.
 * Encrypted bytes are authenticated (HMAC and declared encrypted hash) before any decryption, and the
 * plaintext is measured while it is written; the caller verifies the plaintext checksum before exposure.
 */
export async function downloadNativeMediaFile(
  source: NativeMedia,
  kind: MediaType,
  maximumBytes: number,
  timeoutMs: number,
  directory: string,
  signal?: AbortSignal,
): Promise<VerifiedMediaFile>
{
  const url = nativeMediaUrl(source);
  const keys = await getMediaKeys(source.mediaKey, kind);
  if (!keys.macKey) throw new Error("Native media authentication key is unavailable");
  const encryptedPath = join(directory, "encrypted");
  const plaintextPath = join(directory, "plaintext");
  const controller = new AbortController();
  const bounded = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(timeoutMs),
    ...(signal === undefined ? [] : [signal]),
  ]);
  try
  {
    const response = await fetch(url, { headers: { Origin: DEFAULT_ORIGIN }, signal: bounded });
    if (!response.ok || !response.body) throw new Error("Native media source is unavailable or expired");
    const encryptedHash = createHash("sha256");
    const mac = createHmac("sha256", keys.macKey).update(keys.iv);
    let encryptedBytes = 0;
    let trailing = Buffer.alloc(0);
    const authenticate = new Transform({
      transform(chunk: Buffer, _encoding, callback)
      {
        encryptedBytes += chunk.byteLength;
        if (encryptedBytes > maximumBytes + nativeFramingBytes)
        {
          callback(new Error("Media exceeds configured byte limit"));
          return;
        }
        encryptedHash.update(chunk);
        // The trailing native MAC is not part of the authenticated ciphertext.
        const pending = Buffer.concat([trailing, chunk]);
        const authenticated = Math.max(0, pending.byteLength - nativeMacBytes);
        mac.update(pending.subarray(0, authenticated));
        trailing = Buffer.from(pending.subarray(authenticated));
        callback(null, chunk);
      },
    });
    await pipeline(
      webMediaChunks(response.body),
      authenticate,
      createWriteStream(encryptedPath, { mode: privateFileMode, flags: "wx" }),
      { signal: bounded },
    );
    if (encryptedBytes < nativeFramingBytes || (encryptedBytes - nativeMacBytes) % 16 !== 0)
    {
      throw new Error("Native media encrypted framing is invalid");
    }
    if (!timingSafeEqual(mac.digest().subarray(0, nativeMacBytes), trailing))
    {
      throw new Error("Native media integrity check failed");
    }
    if (Object.hasOwn(source, "fileEncSha256") && source.fileEncSha256)
    {
      const actualHash = encryptedHash.digest();
      if (
        source.fileEncSha256.byteLength !== actualHash.byteLength
        || !timingSafeEqual(source.fileEncSha256, actualHash)
      ) throw new Error("Native encrypted media integrity check failed");
    }
    const measure = new PlaintextMeasure(maximumBytes);
    await pipeline(
      createReadStream(encryptedPath, { end: encryptedBytes - nativeMacBytes - 1 }),
      createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv),
      measure,
      createWriteStream(plaintextPath, { mode: privateFileMode, flags: "wx" }),
      { signal: bounded },
    );
    return { path: plaintextPath, byteSize: measure.byteSize, sha256: measure.digest() };
  }
  catch (error)
  {
    // A caller abort surfaces as its own reason, not as a stream pipeline aggregate.
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
  finally
  {
    controller.abort();
    await rm(encryptedPath, { force: true });
  }
}

// The pinned getHttpStream ignores AbortSignal and pipes upstream errors without forwarding.
// Own bounded HTTP I/O here; retain its public key derivation and AES-CBC/HMAC media framing.
export async function downloadNativeMedia(
  source: NativeMedia,
  kind: MediaType,
  maximumBytes: number,
  timeoutMs: number,
): Promise<Uint8Array>
{
  const url = nativeMediaUrl(source);
  const controller = new AbortController();
  try
  {
    const response = await fetch(url, {
      headers: { Origin: DEFAULT_ORIGIN },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok || !response.body) throw new Error("Native media source is unavailable or expired");
    const encrypted = Buffer.from(
      await collectMediaBytes(webMediaChunks(response.body), maximumBytes + nativeFramingBytes),
    );
    if (encrypted.byteLength < nativeFramingBytes || (encrypted.byteLength - nativeMacBytes) % 16 !== 0)
    {
      throw new Error("Native media encrypted framing is invalid");
    }
    const ciphertext = encrypted.subarray(0, -nativeMacBytes);
    const actualMac = encrypted.subarray(-nativeMacBytes);
    const keys = await getMediaKeys(source.mediaKey, kind);
    if (!keys.macKey) throw new Error("Native media authentication key is unavailable");
    const expectedMac = createHmac("sha256", keys.macKey).update(keys.iv).update(ciphertext).digest()
      .subarray(0, nativeMacBytes);
    if (!timingSafeEqual(expectedMac, actualMac)) throw new Error("Native media integrity check failed");
    if (Object.hasOwn(source, "fileEncSha256") && source.fileEncSha256)
    {
      const actualHash = createHash("sha256").update(encrypted).digest();
      if (
        source.fileEncSha256.byteLength !== actualHash.byteLength
        || !timingSafeEqual(source.fileEncSha256, actualHash)
      ) throw new Error("Native encrypted media integrity check failed");
    }
    const decipher = createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
    const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (bytes.byteLength > maximumBytes) throw new Error("Media exceeds configured byte limit");
    return bytes;
  }
  finally
  {
    controller.abort();
  }
}
