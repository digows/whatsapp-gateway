import {
  type AccountScope,
  AccountScopeSchema,
  DesiredAccountRequestSchema,
  DesiredAccountSchema,
  GatewayAccountResultSchema,
  GatewayCommandSchema,
  type GatewayHttpError,
  GatewayIdentifierSchema,
  GatewayMediaUploadSchema,
  GatewayOperationResultSchema,
  type GatewayOperations,
  GatewayQuerySchema,
} from "@digows/whatsapp-gateway-contracts";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import pino, { type Logger } from "pino";
import { z } from "zod";
import type { GatewayCommandIngress } from "../../application/command-ingress.ts";
import type { GatewayQueryService } from "../../application/query-service.ts";
import { GatewayAuthorizationError, type GatewayPrincipal } from "../../domain/authorization.ts";
import { GatewayConflictError, GatewayResourceUnavailableError } from "../../domain/errors.ts";
import type { GatewayFleetStore } from "../../domain/fleet-store.ts";
import type { GatewayStore } from "../../domain/gateway-store.ts";
import { createGatewayAsyncApi } from "../redis/asyncapi.ts";
import { createGatewayOpenApi, gatewayDocumentationHtml, gatewayDocumentationInitialize } from "./openapi.ts";

export const GatewayHttpConfigurationSchema = z.strictObject({
  enabled: z.boolean(),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8080),
  maximumRequestBytes: z.number().int().positive().max(16 * 1024 * 1024).default(1024 * 1024),
  requestTimeoutMs: z.number().int().positive().max(60000).default(15000),
  shutdownTimeoutMs: z.number().int().positive().max(60000).default(15000),
});
export type GatewayHttpConfiguration = z.infer<typeof GatewayHttpConfigurationSchema>;
export type GatewayHttpConfigurationInput = z.input<typeof GatewayHttpConfigurationSchema>;
export interface GatewayHttpWorkspace
{
  readonly store: GatewayStore;
  readonly commands: GatewayCommandIngress;
  readonly gateway: GatewayOperations;
  readonly fleet?: GatewayFleetStore;
  readonly queries?: GatewayQueryService;
}
export interface GatewayHttpCredential
{
  readonly token: string;
  readonly principal: GatewayPrincipal;
}
interface HashedCredential
{
  readonly digest: Buffer;
  readonly principal: GatewayPrincipal;
}
class HttpFailure extends Error
{
  constructor(readonly status: number, readonly code: GatewayHttpError["code"])
  {
    super(code);
  }
}
export interface GatewayHttpLifecycle
{
  isReady(): boolean;
  isAccepting(): boolean;
}
export class GatewayHttpTransport
{
  private readonly configuration: GatewayHttpConfiguration;
  private readonly workspaces = new Map<string, GatewayHttpWorkspace>();
  private readonly credentials: readonly HashedCredential[];
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly handlers = new Set<Promise<void>>();
  constructor(
    configuration: GatewayHttpConfigurationInput,
    workspaces: readonly GatewayHttpWorkspace[],
    credentials: readonly GatewayHttpCredential[],
    private readonly logger: Logger = pino(),
    private readonly redisDocumentationPrefix = "gateway:v1",
    private readonly lifecycle?: GatewayHttpLifecycle,
  )
  {
    this.configuration = GatewayHttpConfigurationSchema.parse(configuration);
    if (this.configuration.enabled && credentials.length === 0)
    {
      throw new Error("HTTP requires authenticated credentials");
    }
    const hashed = credentials.map(credential => ({
      digest: digestToken(z.string().min(32).max(1024).parse(credential.token)),
      principal: credential.principal,
    }));
    if (new Set(hashed.map(value => value.digest.toString("hex"))).size !== hashed.length)
    {
      throw new Error("Duplicate HTTP credentials");
    }
    this.credentials = hashed;
    for (const workspace of workspaces)
    {
      if (workspace.store.workspaceId !== workspace.commands.workspaceId)
      {
        throw new Error("HTTP workspace command routing mismatch");
      }
      if (workspace.fleet && workspace.fleet.workspaceId !== workspace.store.workspaceId)
      {
        throw new Error("HTTP fleet workspace routing mismatch");
      }
      if (this.workspaces.has(workspace.store.workspaceId)) throw new Error("Duplicate HTTP workspace");
      this.workspaces.set(workspace.store.workspaceId, workspace);
    }
  }
  get origin(): string | null
  {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }
  async start(): Promise<void>
  {
    if (this.closing) throw new Error("HTTP transport is closed");
    if (!this.configuration.enabled) return;
    this.starting ??= this.listen();
    await this.starting;
  }
  private async listen(): Promise<void>
  {
    const server = createServer({
      requestTimeout: this.configuration.requestTimeoutMs,
      headersTimeout: Math.min(10000, this.configuration.requestTimeoutMs),
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: Math.min(1000, this.configuration.requestTimeoutMs),
    }, (request, response) =>
    {
      const handler = this.handle(request, response);
      this.handlers.add(handler);
      void handler.finally(() => this.handlers.delete(handler)).catch(() =>
      {
        response.destroy();
        this.logger.error({ event: "gateway_http_response_failed" });
      });
    });
    this.server = server;
    try
    {
      await new Promise<void>((resolve, reject) =>
      {
        server.once("error", reject);
        server.listen(this.configuration.port, this.configuration.host, () =>
        {
          server.off("error", reject);
          server.on("error", () => this.logger.error({ event: "gateway_http_listener_failed" }));
          resolve();
        });
      });
    }
    catch (error)
    {
      this.server = undefined;
      throw error;
    }
  }
  private authenticate(request: IncomingMessage): GatewayPrincipal
  {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || authorization.length > 1031)
    {
      throw new HttpFailure(401, "UNAUTHORIZED");
    }
    const digest = digestToken(authorization.slice(7));
    let principal: GatewayPrincipal | undefined;
    for (const credential of this.credentials)
    {
      if (timingSafeEqual(credential.digest, digest)) principal = credential.principal;
    }
    if (!principal) throw new HttpFailure(401, "UNAUTHORIZED");
    return principal;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void>
  {
    const started = performance.now();
    let route = "unmatched";
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try
    {
      if (this.closing) throw new HttpFailure(503, "UNAVAILABLE");
      const url = new URL(request.url ?? "/", "http://gateway.invalid");
      if (url.pathname === "/health/live" || url.pathname === "/health/ready")
      {
        route = url.pathname;
        if (request.method !== "GET") throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
        const ready = url.pathname === "/health/live" || (this.lifecycle?.isReady() ?? false);
        sendJson(response, ready ? 200 : 503, { status: ready ? "ok" : "unavailable" });
        return;
      }
      if (await this.documentation(request, response, url.pathname)) return;
      if (this.lifecycle && !this.lifecycle.isAccepting()) throw new HttpFailure(503, "UNAVAILABLE");
      const principal = this.authenticate(request);
      if (url.pathname === "/v1/media")
      {
        route = "/v1/media";
        if (request.method !== "POST") throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
        const upload = parseInput(GatewayMediaUploadSchema, await this.readJson(request));
        principal.authorize(upload);
        const workspace = this.workspaces.get(upload.workspaceId);
        if (!workspace) throw new HttpFailure(404, "NOT_FOUND");
        if (!workspace.queries) throw new HttpFailure(503, "UNAVAILABLE");
        sendJson(response, 200, await workspace.queries.upload(principal, upload));
        return;
      }
      if (url.pathname === "/v1/queries")
      {
        route = "/v1/queries";
        if (request.method !== "POST") throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
        const query = parseInput(GatewayQuerySchema, await this.readJson(request));
        principal.authorize(query);
        const workspace = this.workspaces.get(query.workspaceId);
        if (!workspace) throw new HttpFailure(404, "NOT_FOUND");
        if (!workspace.queries) throw new HttpFailure(503, "UNAVAILABLE");
        sendJson(response, 200, await workspace.queries.execute(principal, query));
        return;
      }
      if (url.pathname === "/v1/commands")
      {
        route = "/v1/commands";
        if (request.method !== "POST") throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
        const command = parseInput(GatewayCommandSchema, await this.readJson(request));
        principal.authorize(command);
        const workspace = this.workspaces.get(command.workspaceId);
        if (!workspace) throw new HttpFailure(404, "NOT_FOUND");
        sendJson(response, 202, await workspace.commands.submit(principal, command));
        return;
      }
      const match =
        /^\/v1\/accounts\/([^/]+)\/([^/]+)(?:\/(commands|operations|media|desired)(?:\/([^/]+))?)?$/.exec(
          url.pathname,
        );
      if (!match) throw new HttpFailure(404, "NOT_FOUND");
      const action = match[3];
      if (request.method !== "GET" && !(action === "desired" && request.method === "PUT"))
      {
        throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
      }
      const scope = parseInput(AccountScopeSchema, {
        workspaceId: decodePath(match[1]!),
        accountId: decodePath(match[2]!),
      });
      principal.authorize(scope);
      const workspace = this.workspaces.get(scope.workspaceId);
      if (!workspace) throw new HttpFailure(404, "NOT_FOUND");
      const key = match[4] === undefined ? undefined : decodePath(match[4]);
      route = `/v1/accounts/:workspaceId/:accountId/${action ?? ""}`;
      if (!action)
      {
        const account = await workspace.store.account(scope.accountId);
        assertResponseScope(account, scope);
        sendJson(response, 200, GatewayAccountResultSchema.parse({ ...account, apiVersion: "1" }));
      }
      else if (action === "commands" && key)
      {
        sendJson(
          response,
          200,
          await workspace.commands.result(principal, {
            ...scope,
            requestId: parseInput(GatewayIdentifierSchema, key),
          }),
        );
      }
      else if (action === "operations" && key)
      {
        const operation = await workspace.gateway.operation(scope.accountId, key);
        assertResponseScope(operation, scope);
        sendJson(response, 200, GatewayOperationResultSchema.parse({ ...operation, apiVersion: "1" }));
      }
      else if (action === "desired" && !key)
      {
        if (!workspace.fleet) throw new HttpFailure(503, "UNAVAILABLE");
        let recorded;
        if (request.method === "PUT")
        {
          const desired = parseInput(DesiredAccountRequestSchema, await this.readJson(request));
          if (desired.workspaceId !== scope.workspaceId || desired.accountId !== scope.accountId)
          {
            throw new HttpFailure(400, "INVALID_REQUEST");
          }
          recorded = await workspace.fleet.setDesired(desired);
        }
        else recorded = await workspace.fleet.desired(scope.accountId);
        assertResponseScope(recorded, scope);
        sendJson(response, 200, DesiredAccountSchema.parse(recorded));
      }
      else if (action === "media" && !key)
      {
        const sourceId = parseInput(z.string().min(1).max(16384), url.searchParams.get("sourceId"));
        const bytes = await workspace.gateway.readMedia(scope.accountId, sourceId);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": bytes.byteLength,
        });
        response.end(bytes);
      }
      else throw new HttpFailure(404, "NOT_FOUND");
    }
    catch (error)
    {
      let failure: HttpFailure;
      if (error instanceof HttpFailure) failure = error;
      else if (error instanceof GatewayAuthorizationError) failure = new HttpFailure(403, "FORBIDDEN");
      else if (error instanceof GatewayConflictError) failure = new HttpFailure(409, "CONFLICT");
      else if (error instanceof GatewayResourceUnavailableError) failure = new HttpFailure(404, "NOT_FOUND");
      else
      {
        failure = new HttpFailure(503, "UNAVAILABLE");
        this.logger.error({
          event: "gateway_http_operation_failed",
          route,
          errorName: error instanceof Error ? error.name : "Error",
        });
      }
      if (response.destroyed) return;
      if (failure.status === 401) response.setHeader("WWW-Authenticate", "Bearer");
      response.setHeader("Connection", "close");
      sendJson(response, failure.status, { apiVersion: "1", code: failure.code });
    }
    finally
    {
      this.logger.info({
        event: "gateway_http_request_completed",
        method: request.method,
        route,
        statusCode: response.headersSent ? response.statusCode : undefined,
        aborted: request.aborted || response.destroyed,
        durationMs: performance.now() - started,
      });
    }
  }
  private async readJson(request: IncomingMessage): Promise<unknown>
  {
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    {
      throw new HttpFailure(415, "UNSUPPORTED_MEDIA_TYPE");
    }
    const limit = this.configuration.maximumRequestBytes;
    const declared = request.headers["content-length"];
    if (declared && Number(declared) > limit) throw new HttpFailure(413, "PAYLOAD_TOO_LARGE");
    return new Promise<unknown>((resolve, reject) =>
    {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = (): void =>
      {
        clearTimeout(timer);
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("error", onError);
        request.off("aborted", onAborted);
      };
      const onError = (error: Error): void =>
      {
        cleanup();
        reject(error);
      };
      const onAborted = (): void => onError(new HttpFailure(400, "INVALID_REQUEST"));
      const onData = (bytes: Buffer): void =>
      {
        size += bytes.byteLength;
        if (size > limit)
        {
          request.pause();
          onError(new HttpFailure(413, "PAYLOAD_TOO_LARGE"));
          return;
        }
        chunks.push(bytes);
      };
      const onEnd = (): void =>
      {
        cleanup();
        try
        {
          resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
        }
        catch (error)
        {
          reject(error instanceof SyntaxError ? new HttpFailure(400, "INVALID_REQUEST") : error);
        }
      };
      const timer = setTimeout(() =>
      {
        request.pause();
        onError(new HttpFailure(408, "REQUEST_TIMEOUT"));
      }, this.configuration.requestTimeoutMs);
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("error", onError);
      request.once("aborted", onAborted);
    });
  }

  private async documentation(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<boolean>
  {
    if (
      path !== "/openapi.json" && path !== "/asyncapi.json" && path !== "/docs" && !path.startsWith("/docs/")
    ) return false;
    if (request.method !== "GET") throw new HttpFailure(405, "METHOD_NOT_ALLOWED");
    if (path === "/openapi.json") sendJson(response, 200, createGatewayOpenApi());
    else if (path === "/asyncapi.json")
    {
      sendJson(response, 200, createGatewayAsyncApi(this.redisDocumentationPrefix));
    }
    else if (path === "/docs")
    {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(gatewayDocumentationHtml);
    }
    else if (path === "/docs/initialize.js")
    {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(gatewayDocumentationInitialize);
    }
    else if (path === "/docs/swagger-ui-bundle.js" || path === "/docs/swagger-ui.css")
    {
      const name = path.endsWith(".css") ? "swagger-ui.css" : "swagger-ui-bundle.js";
      const bytes = await readFile(new URL(import.meta.resolve(`swagger-ui-dist/${name}`)));
      response.writeHead(200, {
        "Content-Type": name.endsWith(".css") ? "text/css" : "text/javascript",
        "Content-Length": bytes.byteLength,
      });
      response.end(bytes);
    }
    else throw new HttpFailure(404, "NOT_FOUND");
    return true;
  }
  async close(): Promise<void>
  {
    this.closing ??= (async () =>
    {
      await this.starting?.catch(() => undefined);
      const server = this.server;
      if (!server) return;
      const timeout = setTimeout(() => server.closeAllConnections(), this.configuration.shutdownTimeoutMs);
      try
      {
        await new Promise<void>((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve())
        );
        await Promise.allSettled([...this.handlers]);
      }
      finally
      {
        clearTimeout(timeout);
      }
    })();
    await this.closing;
  }
}
function digestToken(token: string): Buffer
{
  return createHash("sha256").update(token).digest();
}
function sendJson(response: ServerResponse, status: number, value: unknown): void
{
  if (response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function assertResponseScope(actual: AccountScope, expected: AccountScope): void
{
  if (actual.workspaceId !== expected.workspaceId || actual.accountId !== expected.accountId)
  {
    throw new Error("HTTP response scope mismatch");
  }
}

function parseInput<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema>
{
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpFailure(400, "INVALID_REQUEST");
  return parsed.data;
}
function decodePath(value: string): string
{
  try
  {
    return decodeURIComponent(value);
  }
  catch
  {
    throw new HttpFailure(400, "INVALID_REQUEST");
  }
}
