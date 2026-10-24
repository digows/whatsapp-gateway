import {
  type GatewayHistoryPage,
  type GatewayMediaUploadResult,
  GatewayMediaUploadResultSchema,
  GatewayMediaUploadSchema,
  type GatewayObservedMessage,
  type GatewayOperations,
  type GatewayQueryResponse,
  GatewayQueryResponseSchema,
  GatewayQuerySchema,
  type MediaReference,
} from "@digows/whatsapp-gateway-contracts";
import type { GatewayPrincipal } from "../domain/authorization.ts";
import type { GatewayStore } from "../domain/gateway-store.ts";
export interface GatewayHistoryReader
{
  readonly workspaceId: string;
  page(input: unknown): Promise<GatewayHistoryPage>;
  message(input: unknown): Promise<GatewayObservedMessage | null>;
}
export interface GatewayMediaAccess
{
  readStoredMedia(accountId: string, reference: MediaReference): Promise<Uint8Array>;
  uploadMedia(
    accountId: string,
    bytes: Uint8Array,
    contentType: string,
    fileName?: string,
  ): Promise<MediaReference>;
}
export class GatewayQueryService
{
  readonly workspaceId: string;
  constructor(
    private readonly store: GatewayStore,
    private readonly gateway: GatewayOperations,
    private readonly history: GatewayHistoryReader,
    private readonly media?: GatewayMediaAccess,
  )
  {
    this.workspaceId = store.workspaceId;
    if (history.workspaceId !== this.workspaceId) throw new Error("Query history workspace mismatch");
  }
  async execute(principal: GatewayPrincipal, input: unknown): Promise<GatewayQueryResponse>
  {
    const request = GatewayQuerySchema.parse(input);
    principal.authorize(request);
    if (request.workspaceId !== this.workspaceId) throw new Error("Query workspace mismatch");
    const identity = {
      apiVersion: request.apiVersion,
      workspaceId: request.workspaceId,
      accountId: request.accountId,
      requestId: request.requestId,
      type: request.type,
    };
    let result;
    switch (request.type)
    {
      case "account.get":
        result = await this.store.account(request.accountId);
        break;
      case "operation.get":
        result = await this.gateway.operation(request.accountId, request.key);
        break;
      case "history.page":
      {
        const { requestId: _requestId, type: _type, ...historyRequest } = request;
        result = await this.history.page(historyRequest);
        break;
      }
      case "history.message":
        result = await this.history.message({
          apiVersion: request.apiVersion,
          workspaceId: request.workspaceId,
          accountId: request.accountId,
          chatAddress: request.chatAddress,
          messageId: request.messageId,
        });
        break;
      case "media.readStored":
      {
        if (!this.media) throw new Error("Stored media access is not configured");
        const bytes = await this.media.readStoredMedia(request.accountId, request.reference);
        result = {
          encoding: "base64",
          bytes: Buffer.from(bytes).toString("base64"),
          byteSize: bytes.byteLength,
        };
        break;
      }
      case "media.read":
      {
        const bytes = await this.gateway.readMedia(request.accountId, request.sourceId);
        result = {
          encoding: "base64",
          bytes: Buffer.from(bytes).toString("base64"),
          byteSize: bytes.byteLength,
        };
        break;
      }
    }
    return GatewayQueryResponseSchema.parse({ ...identity, result });
  }
  async upload(principal: GatewayPrincipal, input: unknown): Promise<GatewayMediaUploadResult>
  {
    const request = GatewayMediaUploadSchema.parse(input);
    principal.authorize(request);
    if (request.workspaceId !== this.workspaceId) throw new Error("Media upload workspace mismatch");
    if (!this.media) throw new Error("Media upload is not configured");
    const result = await this.media.uploadMedia(
      request.accountId,
      Buffer.from(request.media.bytes, "base64"),
      request.contentType,
      request.fileName,
    );
    return GatewayMediaUploadResultSchema.parse({
      apiVersion: "1",
      type: "media.upload",
      workspaceId: request.workspaceId,
      accountId: request.accountId,
      requestId: request.requestId,
      result,
    });
  }
}
