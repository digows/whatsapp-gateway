import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { type MediaReference, MediaReferenceSchema } from "@digows/whatsapp-gateway-contracts";
import {
  collectMediaBytes,
  defaultMaximumMediaBytes,
  validateMediaLimit,
  webMediaChunks,
} from "../../domain/media-bytes.ts";
import type { IMediaRepository } from "../../domain/media-storage.ts";

type MediaObjectCommand = GetObjectCommand | PutObjectCommand;
type MediaObjectOutput = GetObjectCommandOutput | PutObjectCommandOutput;

export interface MediaObjectRequestOptions
{
  readonly abortSignal: AbortSignal;
}
export interface MediaObjectClient
{
  send(command: MediaObjectCommand, options?: MediaObjectRequestOptions): Promise<MediaObjectOutput>;
}

export class S3MediaRepository implements IMediaRepository
{
  constructor(
    private readonly client: MediaObjectClient,
    private readonly bucket: string,
    private readonly maximumBytes = defaultMaximumMediaBytes,
    private readonly timeoutMs = 60000,
  )
  {
    validateMediaLimit(maximumBytes);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    {
      throw new Error("Media timeout must be a positive safe integer");
    }
  }

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
    if (bytes.byteLength > this.maximumBytes) throw new Error("Media exceeds configured byte limit");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: reference.storageKey,
        Body: bytes,
        ContentType: reference.contentType,
        Metadata: fileName === undefined ? undefined : { originalfilename: encodeURIComponent(fileName) },
      }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
    return reference;
  }

  async read(reference: MediaReference, maximumBytes = this.maximumBytes): Promise<Uint8Array>
  {
    validateMediaLimit(maximumBytes);
    const validated = MediaReferenceSchema.parse(reference);
    if (validated.byteSize > maximumBytes) throw new Error("Media exceeds configured byte limit");
    const controller = new AbortController();
    try
    {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: validated.storageKey }),
        { abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]) },
      );
      if (!("Body" in result) || !result.Body) throw new Error("Stored media has no body");
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
      const bytes = await collectMediaBytes(webMediaChunks(result.Body.transformToWebStream()), maximumBytes);
      if (bytes.byteLength !== validated.byteSize)
      {
        throw new Error("Stored media body size does not match the reference");
      }
      return bytes;
    }
    finally
    {
      controller.abort();
    }
  }
}
