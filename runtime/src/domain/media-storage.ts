import type { MediaReference } from "@digows/whatsapp-gateway-contracts";
import type { Readable } from "node:stream";

export interface IMediaRepository
{
  write(
    storageKey: string,
    bytes: Uint8Array,
    contentType: string,
    fileName?: string,
  ): Promise<MediaReference>;
  read(reference: MediaReference, maximumBytes?: number): Promise<Uint8Array>;
  /** Streams the stored bytes; the stream fails when the body differs from the reference size. */
  open(reference: MediaReference, maximumBytes?: number, signal?: AbortSignal): Promise<Readable>;
}
