import type {
  AccountScope,
  ContactRegistration,
  GatewayOperations,
  OperationResult,
  OutboundMessage,
} from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { GatewayChatMapping, GatewayOutcomeError } from "../src/index.ts";
class Operations implements GatewayOperations
{
  constructor(private readonly scope: AccountScope)
  {}
  readonly keys: string[] = [];
  reads = 0;
  state: OperationResult["state"] = "ACCEPTED";
  async send(_account: string, message: OutboundMessage): Promise<OperationResult>
  {
    this.keys.push(message.idempotencyKey);
    return {
      ...this.scope,
      key: message.idempotencyKey,
      digest: "fixture",
      nativeIds: ["native"],
      acceptedParts: 1,
      state: this.state,
    };
  }
  async operation(_account: string, key: string): Promise<OperationResult>
  {
    return {
      ...this.scope,
      key,
      digest: "fixture",
      nativeIds: ["native"],
      acceptedParts: 1,
      state: this.state,
    };
  }
  async lookupContactAddress(): Promise<ContactRegistration>
  {
    throw new Error("Registration fixture is not configured");
  }
  async presence(): Promise<void>
  {}
  async readMedia(): Promise<Uint8Array>
  {
    this.reads++;
    return Buffer.from("fixture");
  }
}
test("actual Chat SDK Message retains self-chat authorship and fetches media only on demand", async () =>
{
  const scope = { workspaceId: randomUUID(), accountId: randomUUID() };
  const operations = new Operations(scope);
  const mapping = new GatewayChatMapping(scope, "123@s.whatsapp.net", operations);
  const message = mapping.parseMessage({
    channel: "WHATSAPP",
    receivingAddress: "123@s.whatsapp.net",
    senderAddress: "123@s.whatsapp.net",
    chatAddress: "123@s.whatsapp.net",
    mentionsReceiver: false,
    channelMessageId: "inbound",
    occurredAt: new Date().toISOString(),
    contentKind: "IMAGE",
    media: { sourceId: "opaque", contentType: "image/jpeg" },
    caption: "action",
  });
  assert.equal(message.author.isMe, false);
  assert.equal(message.raw.contentKind, "IMAGE");
  assert.equal(operations.reads, 0);
  const attachment = message.attachments[0];
  assert.ok(attachment);
  await attachment.fetchData?.();
  assert.equal(operations.reads, 1);
  const restored = mapping.rehydrateAttachment(JSON.parse(JSON.stringify(attachment)));
  await restored.fetchData?.();
  assert.equal(operations.reads, 2);
  assert.throws(
    () =>
      mapping.decodeThreadId(
        new GatewayChatMapping({ ...scope, workspaceId: randomUUID() }, "123@s.whatsapp.net", operations)
          .encodeThreadId({ ...scope, workspaceId: randomUUID(), chatId: "x" }),
      ),
    /scope/,
  );
});
test("explicit operation key survives caller replay and UNKNOWN is never a fresh automatic post", async () =>
{
  const scope = { workspaceId: randomUUID(), accountId: randomUUID() };
  const operations = new Operations(scope);
  const mapping = new GatewayChatMapping(scope, "123@s.whatsapp.net", operations);
  const thread = mapping.encodeThreadId({ ...scope, chatId: "456@s.whatsapp.net" });
  await mapping.postWithKey(thread, "test", "stable");
  await mapping.postWithKey(thread, "test", "stable");
  assert.deepEqual(operations.keys, ["stable", "stable"]);
  operations.state = "UNKNOWN";
  await assert.rejects(mapping.postWithKey(thread, "test", "unknown"), GatewayOutcomeError);
  assert.deepEqual(operations.keys, ["stable", "stable", "unknown"]);
  await assert.rejects(
    mapping.postMessage(thread, { card: { type: "card", children: [] } }),
    /cannot be flattened/,
  );
});

test("SDK contexts canonicalize UUIDs and reject another account's operation result", async () =>
{
  const scope = { workspaceId: randomUUID(), accountId: randomUUID() };
  const uppercase = {
    workspaceId: scope.workspaceId.toUpperCase(),
    accountId: scope.accountId.toUpperCase(),
  };
  const mapping = new GatewayChatMapping(uppercase, "123@s.whatsapp.net", new Operations(scope));
  assert.deepEqual(mapping.scope, scope);
  const thread = mapping.encodeThreadId({ ...uppercase, chatId: "456@s.whatsapp.net" });
  assert.deepEqual(mapping.decodeThreadId(thread), { ...scope, chatId: "456@s.whatsapp.net" });
  const mismatched = new GatewayChatMapping(
    scope,
    "123@s.whatsapp.net",
    new Operations({ ...scope, accountId: randomUUID() }),
  );
  await assert.rejects(mismatched.postWithKey(thread, "message", "scope-mismatch"), /scope/);
});
