import {
  GatewayCloudEventSchema,
  GatewayCommandSchema,
  GatewayMediaUploadSchema,
  GatewayQueryCloudEventSchema,
  GatewayQuerySchema,
} from "@digows/whatsapp-gateway-contracts";
import { z } from "zod";
function messageReference(name: string)
{
  return { $ref: `#/components/messages/${name}` };
}
function channel(name: string, suffix: string, message: string, prefix: string)
{
  return {
    address: `${prefix}:{workspaceId}:{accountId}:${suffix}`,
    description:
      "Redis Stream. The field named payload contains UTF-8 JSON matching the logical message schema. Account stream keys are also the Redis ACL boundary.",
    parameters: {
      workspaceId: { description: "Canonical lowercase workspace UUID" },
      accountId: { description: "Canonical lowercase account UUID" },
    },
    messages: { [name]: messageReference(message) },
    servers: [{ $ref: "#/servers/redis" }],
    "x-redis-stream-field": "payload",
  };
}
export function createGatewayAsyncApi(prefix = "gateway:v1")
{
  z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).parse(prefix);
  return {
    asyncapi: "3.0.0",
    info: {
      title: "WhatsApp Gateway for AI Agents — Redis Streams",
      version: "1.0.0",
      description:
        "Versioned scoped commands and CloudEvents. ACK follows durable SQL intake/receipt, then the actual session owner executes. Publications require local AOF acknowledgement before SQL cursor advance. Delivery can duplicate stable event IDs after failures. New bindings start at current SQL event tail; retained Redis entries can be replayed with an independent consumer group. No full WhatsApp history import.",
    },
    defaultContentType: "application/json",
    servers: {
      redis: {
        host: "localhost:6379",
        protocol: "redis",
        protocolVersion: "8.2",
        description:
          "Qualified Redis 8.2 with AOF and noeviction. Use rediss/TLS and account-specific ACL credentials for exposed deployments.",
        security: [{ $ref: "#/components/securitySchemes/redisAcl" }],
      },
    },
    channels: {
      commands: channel("command", "commands", "GatewayCommand", prefix),
      results: channel("result", "results", "GatewayCloudEvent", prefix),
      events: channel("event", "events", "GatewayCloudEvent", prefix),
    },
    operations: {
      receiveCommand: {
        action: "receive",
        channel: { $ref: "#/channels/commands" },
        messages: [{ $ref: "#/channels/commands/messages/command" }],
        description:
          "XREADGROUP gateway with per-boot consumer identity. XAUTOCLAIM recovers idle pending entries. Commands XACK only after SQL intake and a durable receipt. Read-only queries execute without a session owner and XACK after their result is fsynced in local Redis AOF; replay can re-evaluate newer state. Query replies have no SQL account sequence and media bytes never enter SQL. Publisher identity comes from configured account stream binding, never message fields.",
      },
      sendResult: {
        action: "send",
        channel: { $ref: "#/channels/results" },
        messages: [{ $ref: "#/channels/results/messages/result" }],
        description:
          "Ingress receipts and command state observations. Correlate data.requestId; an ingress receipt is separate from a terminal command result. Native ACCEPTED means submission, and UNKNOWN never authorizes automatic resend.",
      },
      sendEvent: {
        action: "send",
        channel: { $ref: "#/channels/events" },
        messages: [{ $ref: "#/channels/events/messages/event" }],
        description:
          "Account, desired-state, operation and message observations. IDs are stable, sequence orders each account's SQL source. Consumers deduplicate IDs and serialize application effects as needed. No global cross-account effect order.",
      },
    },
    components: {
      securitySchemes: {
        redisAcl: {
          type: "userPassword",
          description:
            "Dedicated Redis ACL user with keys limited to configured workspace/account streams. SQL scope grants additionally check each payload. Producer cannot write another account's stream or gateway result/event streams.",
        },
      },
      messages: {
        GatewayCommand: {
          name: "GatewayCommand",
          contentType: "application/json",
          correlationId: { location: "$message.payload#/requestId" },
          payload: {
            schemaFormat: "application/schema+json;version=draft-07",
            schema: z.toJSONSchema(
              z.union([GatewayCommandSchema, GatewayQuerySchema, GatewayMediaUploadSchema]),
              {
                io: "input",
                target: "draft-7",
              },
            ),
          },
        },
        GatewayCloudEvent: {
          name: "GatewayCloudEvent",
          contentType: "application/cloudevents+json",
          correlationId: { location: "$message.payload#/id" },
          payload: {
            schemaFormat: "application/schema+json;version=draft-07",
            schema: z.toJSONSchema(z.union([GatewayCloudEventSchema, GatewayQueryCloudEventSchema]), {
              io: "input",
              target: "draft-7",
            }),
          },
        },
      },
    },
    "x-retention":
      "Age-based XTRIM MINID ACKED using Redis server time; preserves pending/unread entries across consumer groups. Lag can retain bodies beyond nominal age. XACK removes only PEL membership. SQL history/idempotency is separate.",
  };
}
