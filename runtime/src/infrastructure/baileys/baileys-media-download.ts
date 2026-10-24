import { DEF_MEDIA_HOST, DEFAULT_ORIGIN, getMediaKeys, type MediaType } from "baileys";
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { collectMediaBytes, webMediaChunks } from "../../domain/media-bytes.ts";
import type { NativeMedia } from "./baileys-media-repository.ts";

// The pinned getHttpStream ignores AbortSignal and pipes upstream errors without forwarding.
// Own bounded HTTP I/O here; retain its public key derivation and AES-CBC/HMAC media framing.
export async function downloadNativeMedia(
  source: NativeMedia,
  kind: MediaType,
  maximumBytes: number,
  timeoutMs: number,
): Promise<Uint8Array>
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
  const controller = new AbortController();
  try
  {
    const response = await fetch(url, {
      headers: { Origin: DEFAULT_ORIGIN },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok || !response.body) throw new Error("Native media source is unavailable or expired");
    // AES-CBC adds at most16 padding bytes, followed by the native10-byte HMAC.
    const encrypted = Buffer.from(await collectMediaBytes(webMediaChunks(response.body), maximumBytes + 26));
    if (encrypted.byteLength < 26 || (encrypted.byteLength - 10) % 16 !== 0)
    {
      throw new Error("Native media encrypted framing is invalid");
    }
    const ciphertext = encrypted.subarray(0, -10);
    const actualMac = encrypted.subarray(-10);
    const keys = await getMediaKeys(source.mediaKey, kind);
    if (!keys.macKey) throw new Error("Native media authentication key is unavailable");
    const expectedMac = createHmac("sha256", keys.macKey).update(keys.iv).update(ciphertext).digest()
      .subarray(0, 10);
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
