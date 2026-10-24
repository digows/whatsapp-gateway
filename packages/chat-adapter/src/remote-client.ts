import {
  type Account,
  type AccountScope,
  AccountScopeSchema,
  type ContactRegistration,
  type GatewayCommandResponse,
  GatewayCommandResultSchema,
  GatewayCommandSchema,
  type GatewayHistoryPage,
  type GatewayHistoryRequest,
  type GatewayMediaUploadResult,
  GatewayMediaUploadResultSchema,
  GatewayMediaUploadSchema,
  type GatewayObservedMessage,
  type GatewayOperations,
  type GatewayQuery,
  type GatewayQueryResponse,
  GatewayQueryResponseSchema,
  GatewayQuerySchema,
  type MediaReference,
  type OperationResult,
  type OutboundMessage,
} from "@digows/whatsapp-gateway-contracts";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
export const GatewayRemoteRequestSchema = z.union([
  GatewayCommandSchema,
  GatewayQuerySchema,
  GatewayMediaUploadSchema,
]);
export type GatewayRemoteRequest = z.infer<typeof GatewayRemoteRequestSchema>;
export type GatewayRemoteResponse = GatewayCommandResponse | GatewayQueryResponse | GatewayMediaUploadResult;
export interface GatewayRemoteWire
{
  request(request: GatewayRemoteRequest): Promise<GatewayRemoteResponse>;
  close(): Promise<void>;
}
export class GatewayRemoteRequestError extends Error
{
  constructor(readonly request: GatewayRemoteRequest, message: string)
  {
    super(message);
    this.name = "GatewayRemoteRequestError";
  }
}
export interface GatewayHttpClientConfiguration
{
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}
export class GatewayHttpClient implements GatewayRemoteWire
{
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly controller = new AbortController();
  constructor(private readonly configuration: GatewayHttpClientConfiguration)
  {
    const url = new URL(configuration.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    {
      throw new Error("Expected a gateway HTTP origin or base URL without credentials");
    }
    this.url = url.href.replace(/\/$/u, "");
    z.string().min(32).max(1024).parse(configuration.token);
    this.timeoutMs = z.number().int().positive().max(300000).parse(configuration.timeoutMs ?? 120000);
    this.pollIntervalMs = z.number().int().positive().max(5000).parse(configuration.pollIntervalMs ?? 200);
  }
  async request(input: GatewayRemoteRequest): Promise<GatewayRemoteResponse>
  {
    const request = GatewayRemoteRequestSchema.parse(input);
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)]);
    const command = GatewayCommandSchema.safeParse(request);
    const route = command.success
      ? "/v1/commands"
      : request.type === "media.upload"
      ? "/v1/media"
      : "/v1/queries";
    try
    {
      let value = await this.fetchJson(route, signal, request);
      if (!command.success)
      {
        const response = request.type === "media.upload"
          ? GatewayMediaUploadResultSchema.parse(value)
          : GatewayQueryResponseSchema.parse(value);
        assertCorrelation(request, response);
        return response;
      }
      for (;;)
      {
        const result = GatewayCommandResultSchema.parse(value);
        assertCorrelation(request, result);
        if (result.state === "FAILED")
        {
          throw new GatewayRemoteRequestError(
            request,
            "Gateway command execution failed; inspect the original operation key before retrying",
          );
        }
        if (result.response)
        {
          assertCorrelation(request, result.response);
          return result.response;
        }
        await delay(this.pollIntervalMs, undefined, { signal });
        value = await this.fetchJson(
          `/v1/accounts/${request.workspaceId}/${request.accountId}/commands/${request.requestId}`,
          signal,
        );
      }
    }
    catch (error)
    {
      if (error instanceof GatewayRemoteRequestError) throw error;
      throw new GatewayRemoteRequestError(
        request,
        "Gateway request did not produce a confirmed result; preserve its identity and native operation key",
      );
    }
  }
  private async fetchJson(path: string, signal: AbortSignal, body?: GatewayRemoteRequest): Promise<unknown>
  {
    const response = await fetch(this.url + path, {
      method: body ? "POST" : "GET",
      signal,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.configuration.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
    {
      await response.body?.cancel();
      throw new Error(`Gateway HTTP status ${response.status}`);
    }
    return response.json();
  }
  async close(): Promise<void>
  {
    this.controller.abort();
  }
}
export function assertCorrelation(
  request: GatewayRemoteRequest,
  response: AccountScope & RequestCorrelation,
): void
{
  if (
    request.workspaceId !== response.workspaceId || request.accountId !== response.accountId
    || request.requestId !== response.requestId
    || (response.type !== undefined && request.type !== response.type)
  )
  {
    throw new Error("Remote gateway response identity mismatch");
  }
}
interface RequestCorrelation
{
  readonly requestId: string;
  readonly type?: string;
}
export class GatewayRemoteClient implements GatewayOperations
{
  readonly scope: AccountScope;
  constructor(scope: AccountScope, readonly wire: GatewayRemoteWire)
  {
    this.scope = Object.freeze(AccountScopeSchema.parse(scope));
  }
  private identity(accountId = this.scope.accountId)
  {
    if (AccountScopeSchema.parse({ ...this.scope, accountId }).accountId !== this.scope.accountId)
    {
      throw new Error("Remote gateway account mismatch");
    }
    return { ...this.scope, apiVersion: "1" as const, requestId: randomUUID() };
  }
  async send(accountId: string, message: OutboundMessage): Promise<OperationResult>
  {
    const response = await this.wire.request({ ...this.identity(accountId), type: "send", message });
    if (response.type !== "send") throw new Error("Unexpected gateway send result");
    return response.result;
  }
  async presence(accountId: string, chatId: string, composing: boolean): Promise<void>
  {
    const response = await this.wire.request({
      ...this.identity(accountId),
      type: "presence",
      chatAddress: chatId,
      composing,
    });
    if (response.type !== "presence") throw new Error("Unexpected gateway presence result");
  }
  async lookupContactAddress(accountId: string, address: string): Promise<ContactRegistration>
  {
    const response = await this.wire.request({
      ...this.identity(accountId),
      type: "contact.lookup",
      address,
    });
    if (response.type !== "contact.lookup") throw new Error("Unexpected contact registration result");
    return response.result;
  }
  private async query(request: GatewayQuery): Promise<GatewayQueryResponse>
  {
    return GatewayQueryResponseSchema.parse(await this.wire.request(request));
  }
  async account(): Promise<Account>
  {
    const response = await this.query({ ...this.identity(), type: "account.get" });
    if (response.type !== "account.get") throw new Error("Unexpected account result");
    return response.result;
  }
  async operation(accountId: string, key: string): Promise<OperationResult>
  {
    const response = await this.query({ ...this.identity(accountId), type: "operation.get", key });
    if (response.type !== "operation.get") throw new Error("Unexpected operation result");
    return response.result;
  }
  async history(chatAddress: string, options: GatewayHistoryOptions = {}): Promise<GatewayHistoryPage>
  {
    const request = GatewayQuerySchema.parse({
      ...this.identity(),
      type: "history.page",
      chatAddress,
      ...options,
    });
    const response = await this.query(request);
    if (response.type !== "history.page") throw new Error("Unexpected history page result");
    return response.result;
  }
  async message(chatAddress: string, messageId: string): Promise<GatewayObservedMessage | null>
  {
    const response = await this.query({
      ...this.identity(),
      type: "history.message",
      chatAddress,
      messageId,
    });
    if (response.type !== "history.message") throw new Error("Unexpected history message result");
    return response.result;
  }
  async readMedia(accountId: string, sourceId: string): Promise<Uint8Array>
  {
    const response = await this.query({ ...this.identity(accountId), type: "media.read", sourceId });
    if (response.type !== "media.read") throw new Error("Unexpected media result");
    return Buffer.from(response.result.bytes, "base64");
  }
  async readStoredMedia(reference: MediaReference): Promise<Uint8Array>
  {
    const response = await this.query({ ...this.identity(), type: "media.readStored", reference });
    if (response.type !== "media.readStored") throw new Error("Unexpected stored media result");
    return Buffer.from(response.result.bytes, "base64");
  }
  async upload(bytes: Uint8Array, contentType: string, fileName?: string): Promise<MediaReference>
  {
    const response = await this.wire.request({
      ...this.identity(),
      type: "media.upload",
      contentType,
      ...(fileName ? { fileName } : {}),
      media: { encoding: "base64", bytes: Buffer.from(bytes).toString("base64"), byteSize: bytes.byteLength },
    });
    if (response.type !== "media.upload") throw new Error("Unexpected upload result");
    return response.result;
  }
  async close(): Promise<void>
  {
    await this.wire.close();
  }
}
export type GatewayHistoryOptions = Partial<Pick<GatewayHistoryRequest, "cursor" | "direction" | "limit">>;
