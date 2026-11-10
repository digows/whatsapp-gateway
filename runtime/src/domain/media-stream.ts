import type { Readable } from "node:stream";

/** Verified media exposed as a stream; destroying or finishing the stream releases its private resources. */
export interface OpenedMedia
{
  readonly byteSize: number;
  readonly contentType: string;
  readonly fileName?: string;
  readonly stream: Readable;
}

/** Plaintext media verified and written to a private temporary file. */
export interface VerifiedMediaFile
{
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: Buffer;
}

/** Opens verified media as a stream for a scoped consumer. */
export interface MediaStreamReader
{
  openMedia(accountId: string, sourceId: string, signal?: AbortSignal): Promise<OpenedMedia>;
}
