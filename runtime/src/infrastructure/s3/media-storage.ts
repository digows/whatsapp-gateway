import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { type MediaReference, MediaReferenceSchema } from "@digows/whatsapp-gateway-contracts";
import type { IMediaRepository } from "../../domain/media-storage.ts";

type MediaObjectCommand = GetObjectCommand | PutObjectCommand;
type MediaObjectOutput = GetObjectCommandOutput | PutObjectCommandOutput;

export interface MediaObjectClient
{
  send(command: MediaObjectCommand): Promise<MediaObjectOutput>;
}

export class S3MediaRepository implements IMediaRepository
{
  constructor(private readonly client: MediaObjectClient, private readonly bucket: string)
  {}

  async write(
    storageKey: string,
    bytes: Uint8Array,
    contentType: string,
    fileName?: string,
  ): Promise<MediaReference>
  {
    const reference = MediaReferenceSchema.parse({
      storageKey,
      contentType,
      byteSize: bytes.byteLength,
      fileName,
    });
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: reference.storageKey,
        Body: bytes,
        ContentType: reference.contentType,
        Metadata: fileName === undefined ? undefined : { originalfilename: encodeURIComponent(fileName) },
      }),
    );
    return reference;
  }

  async read(reference: MediaReference): Promise<Uint8Array>
  {
    const validated = MediaReferenceSchema.parse(reference);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: validated.storageKey }),
    );
    if (!("Body" in result)) throw new Error("Stored media has no body");
    if (result.ContentType !== validated.contentType || result.ContentLength !== validated.byteSize)
    {
      throw new Error("Stored media metadata does not match the reference");
    }
    if (
      validated.fileName !== undefined
      && result.Metadata?.["originalfilename"] !== encodeURIComponent(validated.fileName)
    )
    {
      throw new Error("Stored media filename does not match the reference");
    }
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength !== validated.byteSize)
    {
      throw new Error("Stored media body size does not match the reference");
    }
    return bytes;
  }
}
