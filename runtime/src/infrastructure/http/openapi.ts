import {
  DesiredAccountRequestSchema,
  DesiredAccountSchema,
  GatewayAccountResultSchema,
  GatewayCommandResultSchema,
  GatewayCommandSchema,
  GatewayHttpErrorSchema,
  GatewayMediaUploadResultSchema,
  GatewayMediaUploadSchema,
  GatewayOperationResultSchema,
  GatewayQueryResponseSchema,
  GatewayQuerySchema,
} from "@digows/whatsapp-gateway-contracts";
import { z } from "zod";

function schemaReference(name: string)
{
  return { $ref: `#/components/schemas/${name}` };
}
function jsonResponse(description: string, schema: string)
{
  return { description, content: { "application/json": { schema: schemaReference(schema) } } };
}
function pathParameter(name: string, format?: string)
{
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string", ...(format ? { format } : {}), minLength: 1 },
  };
}
const accountParameters = [pathParameter("workspaceId", "uuid"), pathParameter("accountId", "uuid")];
const errors = {
  "400": jsonResponse("Invalid or unsupported request", "GatewayHttpError"),
  "401": jsonResponse("Missing or invalid bearer credential", "GatewayHttpError"),
  "403": jsonResponse("Credential does not authorize this workspace/account", "GatewayHttpError"),
  "404": jsonResponse("Resource unavailable in this scope", "GatewayHttpError"),
  "405": jsonResponse("Method not allowed", "GatewayHttpError"),
  "503": jsonResponse("Storage or provider operation unavailable", "GatewayHttpError"),
};
export function createGatewayOpenApi()
{
  return {
    openapi: "3.1.1",
    info: {
      title: "WhatsApp Gateway for AI Agents",
      version: "1.0.0",
      description:
        "Version 1. Commands are durably queued before 202; poll their scoped result. COMPLETED is evaluation, ACCEPTED is native submission, and UNKNOWN never authorizes automatic resend. Byte media access is lazy, authenticated and bounded. No full WhatsApp history import.",
    },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/media": {
        post: {
          operationId: "uploadMedia",
          description:
            "Bounded base64 upload to configured private object storage. Content plus metadata determines the scoped object key, so replay reuses the reference. No media bytes enter SQL. Requires configured media storage.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schemaReference("GatewayMediaUpload") } },
          },
          responses: {
            "200": jsonResponse("Scoped private reference", "GatewayMediaUploadResult"),
            ...errors,
          },
        },
      },
      "/v1/queries": {
        post: {
          operationId: "query",
          description:
            "Authorized read-only observations; available without local account ownership. Repeating a query may observe newer state. Media bytes are bounded base64 here; the binary GET route avoids that overhead.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schemaReference("GatewayQuery") } },
          },
          responses: { "200": jsonResponse("Scoped query result", "GatewayQueryResponse"), ...errors },
        },
      },
      "/v1/commands": {
        post: {
          operationId: "submitCommand",
          description:
            "Keep requestId across delivery retries and the send idempotencyKey across native-operation retries. A conflicting payload for an existing request is rejected. Acceptance does not require this HTTP instance to own the account.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schemaReference("GatewayCommand") } },
          },
          responses: {
            "202": jsonResponse(
              "Durable receipt, including a previous result on replay",
              "GatewayCommandResult",
            ),
            ...errors,
            "408": jsonResponse("Request body deadline expired", "GatewayHttpError"),
            "409": jsonResponse("Request ID already has a different payload", "GatewayHttpError"),
            "413": jsonResponse("Request exceeds the configured byte limit", "GatewayHttpError"),
            "415": jsonResponse("Content-Type must be application/json", "GatewayHttpError"),
          },
        },
      },
      "/v1/accounts/{workspaceId}/{accountId}": {
        get: {
          operationId: "getAccount",
          parameters: accountParameters,
          responses: {
            "200": jsonResponse(
              "Scoped account observation, including pairing QR when available",
              "GatewayAccountResult",
            ),
            ...errors,
          },
        },
      },
      "/v1/accounts/{workspaceId}/{accountId}/commands/{requestId}": {
        get: {
          operationId: "getCommand",
          parameters: [...accountParameters, pathParameter("requestId", "uuid")],
          responses: {
            "200": jsonResponse("Durable command observation", "GatewayCommandResult"),
            ...errors,
          },
        },
      },
      "/v1/accounts/{workspaceId}/{accountId}/operations/{key}": {
        get: {
          operationId: "getOperation",
          parameters: [...accountParameters, pathParameter("key")],
          responses: {
            "200": jsonResponse("Native send-operation observation", "GatewayOperationResult"),
            ...errors,
          },
        },
      },
      "/v1/accounts/{workspaceId}/{accountId}/desired": {
        get: {
          operationId: "getDesiredAccount",
          parameters: accountParameters,
          responses: {
            "200": jsonResponse(
              "Durable desired state and assignment; requires configured fleet store",
              "DesiredAccount",
            ),
            ...errors,
          },
        },
        put: {
          operationId: "setDesiredAccount",
          parameters: accountParameters,
          description:
            "Compare-and-set desired state using expectedRevision. A new enabled revision explicitly authorizes a fresh pairing/restart attempt. Recording intent does not prove the session is connected. Same expectedRevision/payload can be replayed only against its immediate successor. Requires configured fleet store.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: schemaReference("DesiredAccountRequest") } },
          },
          responses: {
            "200": jsonResponse("Durable decision recorded", "DesiredAccount"),
            ...errors,
            "409": jsonResponse("Desired revision changed", "GatewayHttpError"),
            "408": jsonResponse("Request body deadline expired", "GatewayHttpError"),
            "413": jsonResponse("Request byte limit exceeded", "GatewayHttpError"),
            "415": jsonResponse("Expected application/json", "GatewayHttpError"),
          },
        },
      },
      "/v1/accounts/{workspaceId}/{accountId}/media": {
        get: {
          operationId: "readMedia",
          parameters: [...accountParameters, {
            name: "sourceId",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1 },
          }],
          responses: {
            "200": {
              description: "Bounded decrypted bytes; no provider keys or URLs",
              content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
            },
            ...errors,
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        GatewayMediaUpload: z.toJSONSchema(GatewayMediaUploadSchema, { io: "input" }),
        GatewayMediaUploadResult: z.toJSONSchema(GatewayMediaUploadResultSchema, { io: "input" }),
        GatewayQuery: z.toJSONSchema(GatewayQuerySchema, { io: "input" }),
        GatewayQueryResponse: z.toJSONSchema(GatewayQueryResponseSchema, { io: "input" }),
        DesiredAccount: z.toJSONSchema(DesiredAccountSchema, { io: "input" }),
        DesiredAccountRequest: z.toJSONSchema(DesiredAccountRequestSchema, { io: "input" }),
        GatewayCommand: z.toJSONSchema(GatewayCommandSchema, { io: "input" }),
        GatewayCommandResult: z.toJSONSchema(GatewayCommandResultSchema, { io: "input" }),
        GatewayAccountResult: z.toJSONSchema(GatewayAccountResultSchema, { io: "input" }),
        GatewayOperationResult: z.toJSONSchema(GatewayOperationResultSchema, { io: "input" }),
        GatewayHttpError: z.toJSONSchema(GatewayHttpErrorSchema, { io: "input" }),
      },
    },
  };
}
export const gatewayDocumentationHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Gateway for AI Agents — API</title><link rel="stylesheet" href="/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/docs/swagger-ui-bundle.js"></script><script src="/docs/initialize.js"></script></body></html>`;
export const gatewayDocumentationInitialize =
  `SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",deepLinking:true,persistAuthorization:false,validatorUrl:null});`;
