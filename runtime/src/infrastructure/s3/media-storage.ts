import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { type MediaReference, MediaReferenceSchema } from "@digows/whatsapp-gateway-contracts";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
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

  private async object(
    reference: MediaReference,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<{ readonly reference: MediaReference; readonly body: ReadableStream<Uint8Array> }>
  {
    validateMediaLimit(maximumBytes);
    const validated = MediaReferenceSchema.parse(reference);
    if (validated.byteSize > maximumBytes) throw new Error("Media exceeds configured byte limit");
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: validated.storageKey }),
      { abortSignal: signal },
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
    return { reference: validated, body: result.Body.transformToWebStream() };
  }

  async read(reference: MediaReference, maximumBytes = this.maximumBytes): Promise<Uint8Array>
  {
    const controller = new AbortController();
    try
    {
      const stored = await this.object(
        reference,
        maximumBytes,
        AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs)]),
      );
      const bytes = await collectMediaBytes(webMediaChunks(stored.body), maximumBytes);
      if (bytes.byteLength !== stored.reference.byteSize)
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

  /** Streams a stored object, failing on a body shorter or longer than its reference. */
  async open(
    reference: MediaReference,
    maximumBytes = this.maximumBytes,
    signal?: AbortSignal,
  ): Promise<Readable>
  {
    const controller = new AbortController();
    try
    {
      const stored = await this.object(
        reference,
        maximumBytes,
        AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.timeoutMs),
          ...(signal === undefined ? [] : [signal]),
        ]),
      );
      const expected = stored.reference.byteSize;
      let received = 0;
      const measured = new Transform({
        transform(chunk: Buffer, _encoding, callback)
        {
          received += chunk.byteLength;
          if (received > expected) callback(new Error("Stored media body size does not match the reference"));
          else callback(null, chunk);
        },
        flush(callback)
        {
          callback(
            received === expected ? null : new Error("Stored media body size does not match the reference"),
          );
        },
      });
      const source = Readable.fromWeb(stored.body as WebReadableStream<Uint8Array>);
      source.once("error", error => measured.destroy(error));
      measured.once("close", () =>
      {
        source.destroy();
        controller.abort();
      });
      return source.pipe(measured);
    }
    catch (error)
    {
      controller.abort();
      throw error;
    }
  }
}
