import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { S3MediaRepository } from "./media-storage.ts";
export const MediaStorageConfigurationSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("direct") }),
  z.strictObject({
    mode: z.literal("s3"),
    endpoint: z.url().refine(
      value => ["http:", "https:"].includes(new URL(value).protocol),
      "S3 endpoint must use HTTP(S)",
    ).optional(),
    region: z.string().min(1),
    bucket: z.string().min(1),
    forcePathStyle: z.boolean().default(false),
    credentials: z.strictObject({
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      sessionToken: z.string().min(1).optional(),
    }).optional(),
  }),
]);
export type MediaStorageConfiguration = z.infer<typeof MediaStorageConfigurationSchema>;
export interface MediaStorageResources
{
  readonly client: S3Client;
  readonly repository: S3MediaRepository;
}
export interface MediaTransferLimits
{
  readonly maximumBytes: number;
  readonly timeoutMs: number;
}
export function createMediaStorage(input: unknown, limits?: MediaTransferLimits): MediaStorageResources | null
{
  const configuration = MediaStorageConfigurationSchema.parse(input);
  if (configuration.mode === "direct") return null;
  const client = new S3Client({
    region: configuration.region,
    ...(configuration.endpoint ? { endpoint: configuration.endpoint } : {}),
    forcePathStyle: configuration.forcePathStyle,
    ...(configuration.credentials
      ? {
        credentials: {
          accessKeyId: configuration.credentials.accessKeyId,
          secretAccessKey: configuration.credentials.secretAccessKey,
          ...(configuration.credentials.sessionToken === undefined
            ? {}
            : { sessionToken: configuration.credentials.sessionToken }),
        },
      }
      : {}),
  });
  return {
    client,
    repository: new S3MediaRepository(client, configuration.bucket, limits?.maximumBytes, limits?.timeoutMs),
  };
}
