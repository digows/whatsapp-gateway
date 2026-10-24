import type { MediaReference } from "@digows/whatsapp-gateway-contracts";

export interface IMediaRepository
{
  write(
    storageKey: string,
    bytes: Uint8Array,
    contentType: string,
    fileName?: string,
  ): Promise<MediaReference>;
  read(reference: MediaReference, maximumBytes?: number): Promise<Uint8Array>;
}
