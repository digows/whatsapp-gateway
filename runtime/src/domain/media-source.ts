export interface WhatsAppMediaSourceIdentity
{
  readonly accountId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly partId: string;
}

const sourcePrefix = "gateway-media:1:";

function isMediaSourceIdentity(value: unknown): value is WhatsAppMediaSourceIdentity
{
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 4
    && "workspaceId" in value && typeof value.workspaceId === "string" && value.workspaceId.length > 0
    && "accountId" in value && typeof value.accountId === "string" && value.accountId.length > 0
    && "messageId" in value && typeof value.messageId === "string" && value.messageId.length > 0
    && "partId" in value && typeof value.partId === "string"
    && /^(?:0|thumbnail|card-(?:0|[1-9][0-9]*))$/u.test(value.partId);
}

export function encodeWhatsAppMediaSource(identity: WhatsAppMediaSourceIdentity): string
{
  if (!isMediaSourceIdentity(identity)) throw new Error("WhatsApp media source identity is invalid");
  const serialized = JSON.stringify({
    workspaceId: identity.workspaceId,
    accountId: identity.accountId,
    messageId: identity.messageId,
    partId: identity.partId,
  });
  return sourcePrefix + Buffer.from(serialized).toString("base64url");
}

export function decodeWhatsAppMediaSource(sourceId: string): WhatsAppMediaSourceIdentity
{
  if (!sourceId.startsWith(sourcePrefix)) throw new Error("WhatsApp media source is invalid");
  const serialized = Buffer.from(sourceId.slice(sourcePrefix.length), "base64url").toString("utf8");
  const value: unknown = JSON.parse(serialized);
  if (!isMediaSourceIdentity(value)) throw new Error("WhatsApp media source identity is invalid");
  if (encodeWhatsAppMediaSource(value) !== sourceId)
  {
    throw new Error("WhatsApp media source encoding is invalid");
  }
  return value;
}
