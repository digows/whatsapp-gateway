import SwaggerParser from "@apidevtools/swagger-parser";
import { GatewayCommandResultSchema, type OperationResult } from "@digows/whatsapp-gateway-contracts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayCommandIngress, GatewayCommandWorker } from "../src/application/command-ingress.ts";
import { Gateway } from "../src/application/gateway.ts";
import { GatewayPrincipal } from "../src/domain/authorization.ts";
import { GatewayHttpTransport } from "../src/infrastructure/http/transport.ts";
import { SqlCommandInbox } from "../src/infrastructure/sql/command-inbox.ts";
import { SqlFleetStore } from "../src/infrastructure/sql/fleet-store.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { ControlledConnection } from "./support/controlled-connection.ts";
class InvalidResponseGateway extends Gateway
{
  responseMode: "normal" | "scope" | "invalid" = "normal";
  override async operation(accountId: string, key: string): Promise<OperationResult>
  {
    const result = await super.operation(accountId, key);
    if (this.responseMode === "scope") return { ...result, accountId: randomUUID() };
    if (this.responseMode === "invalid") return { ...result, nativeIds: [] };
    return result;
  }
}
const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!temporaryRoot || !postgresUrl) throw new Error("Explicit isolated fixtures required");
for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} real HTTP authenticates durable commands, polls scoped outcomes and serves valid interactive OpenAPI`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "gateway-http-"));
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, filename: join(directory, "http.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const workspaceId = randomUUID();
    const store = storage.workspace(workspaceId);
    const account = await store.createAccount();
    const denied = await store.createAccount();
    const accountId = account.accountId;
    const principal = new GatewayPrincipal("agent", [{ workspaceId, accountIds: [accountId] }]);
    const token = randomBytes(32).toString("hex");
    const socket = new ControlledConnection();
    const gateway = new InvalidResponseGateway(store, () => socket, {
      minimumDelayMs: 0,
      maximumDelayMs: 0,
      typingDelayMs: 0,
    });
    const inbox = new SqlCommandInbox(store);
    const commands = new GatewayCommandIngress(inbox);
    let http = new GatewayHttpTransport({ enabled: true, port: 0, maximumRequestBytes: 2048 }, [{
      store,
      commands,
      gateway,
    }], [{ token, principal }]);
    const command = {
      apiVersion: "1",
      workspaceId,
      accountId,
      requestId: randomUUID(),
      type: "send",
      message: {
        channel: "WHATSAPP",
        contentKind: "TEXT",
        senderAddress: "100@s.whatsapp.net",
        recipientAddress: "200@s.whatsapp.net",
        idempotencyKey: "http-one-effect",
        text: "HTTP integration",
      },
    };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    try
    {
      await http.start();
      let base = http.origin;
      assert.ok(base);
      assert.equal(
        (await fetch(base + "/v1/commands", { method: "POST", body: JSON.stringify(command) })).status,
        401,
      );
      assert.equal(
        (await fetch(base + "/v1/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...command, accountId: denied.accountId }),
        })).status,
        403,
      );
      assert.equal((await fetch(base + "/v1/commands", { method: "POST", headers, body: "{" })).status, 400);
      assert.equal(
        (await fetch(base + "/v1/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...command, apiVersion: "99" }),
        })).status,
        400,
      );
      assert.equal(
        (await fetch(base + "/v1/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...command, text: "x".repeat(5000) }),
        })).status,
        413,
      );
      const submitted = await fetch(base + "/v1/commands", {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      });
      assert.equal(submitted.status, 202);
      const receipt = GatewayCommandResultSchema.parse(await submitted.json());
      assert.equal(receipt.state, "PENDING");
      assert.equal(socket.sent.length, 0);
      const conflict = await fetch(base + "/v1/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...command, message: { ...command.message, text: "changed" } }),
      });
      assert.equal(conflict.status, 409);
      await http.close();
      // HTTP restart and caller retry preserve SQL intake before any owner executes it.
      http = new GatewayHttpTransport({ enabled: true, port: 0 }, [{
        store,
        commands,
        gateway,
        fleet: new SqlFleetStore(store),
      }], [{
        token,
        principal,
      }]);
      await http.start();
      base = http.origin;
      assert.ok(base);
      const replay = await fetch(base + "/v1/commands", {
        method: "POST",
        headers,
        body: JSON.stringify(command),
      });
      assert.equal(replay.status, 202);
      assert.deepEqual(await replay.json(), receipt);
      await gateway.start(accountId);
      const worker = new GatewayCommandWorker(inbox, gateway);
      await worker.runOne(await gateway.ownership(accountId));
      const path = `/v1/accounts/${workspaceId}/${accountId}`;
      const outcome = await fetch(base + path + "/commands/" + command.requestId, { headers });
      const completed = GatewayCommandResultSchema.parse(await outcome.json());
      assert.equal(completed.state, "COMPLETED");
      assert.equal(completed.response?.type, "send");
      assert.equal(socket.sent.length, 1);
      assert.equal((await fetch(base + path + "/commands/" + randomUUID(), { headers })).status, 404);
      assert.equal(
        (await fetch(base + `/v1/accounts/${workspaceId}/${denied.accountId}`, { headers })).status,
        403,
      );
      const desiredRequest = { apiVersion: "1", workspaceId, accountId, expectedRevision: 0, enabled: true };
      const desired = await fetch(base + path + "/desired", {
        method: "PUT",
        headers,
        body: JSON.stringify(desiredRequest),
      });
      assert.equal(desired.status, 200);
      const recordedDesired = await desired.json();
      assert.equal(recordedDesired.revision, 1);
      assert.equal((await fetch(base + path + "/desired", { headers })).status, 200);
      const staleDesired = await fetch(base + path + "/desired", {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...desiredRequest, enabled: false }),
      });
      assert.equal(staleDesired.status, 409);
      const mismatchedDesired = await fetch(base + path + "/desired", {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...desiredRequest, accountId: denied.accountId }),
      });
      assert.equal(mismatchedDesired.status, 400);
      const observedAccount = await fetch(base + path, { headers });
      assert.equal(observedAccount.status, 200);
      const operation = await fetch(base + path + "/operations/http-one-effect", { headers });
      assert.equal(operation.status, 200);
      gateway.responseMode = "scope";
      assert.equal((await fetch(base + path + "/operations/http-one-effect", { headers })).status, 503);
      gateway.responseMode = "invalid";
      assert.equal((await fetch(base + path + "/operations/http-one-effect", { headers })).status, 503);
      gateway.responseMode = "normal";
      const openapi = await fetch(base + "/openapi.json");
      assert.equal(openapi.status, 200);
      const document = await SwaggerParser.validate(await openapi.json());
      assert.ok("openapi" in document);
      assert.equal(document.openapi, "3.1.1");
      assert.equal((await fetch(base + "/asyncapi.json")).status, 200);
      const docs = await fetch(base + "/docs");
      assert.match(await docs.text(), /swagger-ui-bundle.js/);
      const javascript = await fetch(base + "/docs/swagger-ui-bundle.js");
      assert.equal(javascript.status, 200);
      assert.match(await javascript.text(), /SwaggerUIBundle/);
      assert.equal((await fetch(base + "/docs/swagger-ui.css")).status, 200);
      assert.equal((await fetch(base + "/docs/../../package.json", { headers })).status, 404);
    }
    finally
    {
      await http.close();
      await gateway.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
test("disabled HTTP opens no listener and enabled HTTP refuses absent credentials", async () =>
{
  const disabled = new GatewayHttpTransport({ enabled: false }, [], []);
  await disabled.start();
  assert.equal(disabled.origin, null);
  await disabled.close();
  assert.throws(() => new GatewayHttpTransport({ enabled: true }, [], []), /credentials/);
});

test("HTTP bounds incomplete and chunked bodies without enqueueing them", async () =>
{
  const token = randomBytes(32).toString("hex");
  const principal = new GatewayPrincipal("fixture", [{ workspaceId: randomUUID(), accountIds: "*" }]);
  const http = new GatewayHttpTransport(
    { enabled: true, port: 0, maximumRequestBytes: 64, requestTimeoutMs: 60 },
    [],
    [{ token, principal }],
  );
  try
  {
    await http.start();
    assert.ok(http.origin);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const status = await new Promise<number>((resolve, reject) =>
    {
      const request = httpRequest(http.origin + "/v1/commands", { method: "POST", headers }, response =>
      {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.setTimeout(1000, () => request.destroy(new Error("Body timeout was not bounded")));
      request.write("{");
    });
    assert.equal(status, 408);
    const oversized = await new Promise<number>((resolve, reject) =>
    {
      const request = httpRequest(http.origin + "/v1/commands", { method: "POST", headers }, response =>
      {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end("x".repeat(128));
    });
    assert.equal(oversized, 413);
  }
  finally
  {
    await http.close();
  }
});
