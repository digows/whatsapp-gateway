import { type S3Client } from "@aws-sdk/client-s3";
import {
  GatewayMediaUploadResultSchema,
  GatewayQueryCloudEventSchema,
  GatewayQueryResponseSchema,
  gatewayStreamNames,
} from "@digows/whatsapp-gateway-contracts";
import { InboundMessageSchema } from "@digows/whatsapp-gateway-contracts";
import { BufferJSON, getMediaKeys, type WAMessage } from "baileys";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createClient } from "redis";
import {
  GatewayHttpClient,
  GatewayRemoteClient,
  WhatsAppGatewayAdapter,
} from "../../packages/chat-adapter/src/index.ts";
import { GatewayChatMapping } from "../../packages/chat-adapter/src/index.ts";
import { GatewayCommandWorker } from "../src/application/command-ingress.ts";
import { GatewayCommandIngress } from "../src/application/command-ingress.ts";
import { Gateway } from "../src/application/gateway.ts";
import { GatewayQueryService } from "../src/application/query-service.ts";
import { GatewayPrincipal } from "../src/domain/authorization.ts";
import { encodeWhatsAppMediaSource } from "../src/domain/media-source.ts";
import { BaileysConnection } from "../src/infrastructure/baileys/baileys-connection.ts";
import { GatewayHttpTransport } from "../src/infrastructure/http/transport.ts";
import { GatewayRedisTransport } from "../src/infrastructure/redis/transport.ts";
import { createMediaStorage } from "../src/infrastructure/s3/configuration.ts";
import { SqlCommandInbox } from "../src/infrastructure/sql/command-inbox.ts";
import { SqlGatewayHistory } from "../src/infrastructure/sql/history.ts";
import { SqlRedisStreamStore } from "../src/infrastructure/sql/redis-stream-store.ts";
import {
  type GatewayStorage,
  migrateGatewayStorage,
  openGatewayStorage,
} from "../src/infrastructure/sql/storage.ts";
import { jsonValue } from "../src/infrastructure/sql/tables.ts";
import { NativeSocketFixture } from "./support/native-socket.ts";
interface MediaFixtureOptions
{
  readonly maximumBytes?: number;
  readonly declareSize?: boolean;
  readonly corruptHash?: boolean;
  readonly timeoutMs?: number;
}
interface StoredObject
{
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly fileName: string | undefined;
}
class MediaFixture
{
  readonly objects = new Map<string, StoredObject>();
  readonly sourceObjects = new Map<string, Buffer>();
  socket: NativeSocketFixture | undefined;
  connection: BaileysConnection | undefined;
  readonly payload = Buffer.from("controlled encrypted WhatsApp media");
  readonly accountId = randomUUID();
  readonly workspaceId = randomUUID();
  readonly messageId = randomUUID();
  readonly server: Server;
  readonly sourceId = encodeWhatsAppMediaSource({
    workspaceId: this.workspaceId,
    accountId: this.accountId,
    messageId: this.messageId,
    chatId: "200@s.whatsapp.net",
    partId: "0",
  });
  mediaRequests = 0;
  objectWrites = 0;
  expired = false;
  stall = false;
  encrypted = Buffer.alloc(0);
  gateway!: Gateway;
  storage!: GatewayStorage;
  directory = "";
  client: S3Client | undefined;
  constructor()
  {
    this.server = createServer((request, response) =>
    {
      void this.respond(request, response).catch(() =>
      {
        response.writeHead(500);
        response.end();
      });
    });
  }
  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void>
  {
    if (request.url === "/source" || this.sourceObjects.has(request.url ?? ""))
    {
      this.mediaRequests++;
      response.writeHead(this.expired ? 404 : 200);
      if (this.stall)
      {
        response.flushHeaders();
        return;
      }
      response.end(
        this.expired ? "Unavailable" : this.sourceObjects.get(request.url ?? "") ?? this.encrypted,
      );
      return;
    }
    assert.match(String(request.headers.authorization), /^AWS4-HMAC-SHA256 /);
    const key = decodeURIComponent((request.url ?? "").split("?")[0]!);
    if (request.method === "PUT")
    {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      this.objects.set(key, {
        bytes: Buffer.concat(chunks),
        contentType: String(request.headers["content-type"]),
        fileName: request.headers["x-amz-meta-originalfilename"] as string | undefined,
      });
      this.objectWrites++;
      response.writeHead(200, { ETag: "\"fixture\"" });
      response.end();
      return;
    }
    const object = this.objects.get(key);
    if (!object)
    {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": object.contentType,
      "Content-Length": object.bytes.byteLength,
      ...(object.fileName ? { "x-amz-meta-originalfilename": object.fileName } : {}),
    });
    response.end(object.bytes);
  }
  async start(materialize: boolean, options: MediaFixtureOptions = {}): Promise<void>
  {
    const temporaryRoot = process.env["TMPDIR"];
    if (!temporaryRoot) throw new Error("Explicit owned TMPDIR required");
    this.directory = await mkdtemp(join(temporaryRoot, "gateway-media-"));
    const configuration = {
      engine: "sqlite",
      workspaceId: this.workspaceId,
      filename: join(this.directory, "gateway.sqlite"),
      mode: "local",
    } as const;
    await migrateGatewayStorage(configuration);
    this.storage = await openGatewayStorage(configuration);
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const resources = createMediaStorage(
      materialize
        ? {
          mode: "s3",
          endpoint,
          region: "auto",
          forcePathStyle: true,
          bucket: "bucket",
          credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-only" },
        }
        : { mode: "direct" },
    );
    this.client = resources?.client;
    const media = resources?.repository;
    const store = this.storage.workspace(this.workspaceId);
    let socket: NativeSocketFixture | undefined;
    let connection: BaileysConnection | undefined;
    this.gateway = new Gateway(store, (_account, lease) =>
    {
      connection = new BaileysConnection(store, lease, media ?? null, configuration =>
      {
        socket = new NativeSocketFixture(configuration);
        return socket.socket;
      });
      return connection;
    }, {
      ...(options.maximumBytes === undefined ? {} : { maximumMediaBytes: options.maximumBytes }),
      mediaTimeoutMs: options.timeoutMs ?? 3000,
    }, media);
    await store.createAccount(this.accountId);
    await this.gateway.start(this.accountId);
    assert.ok(socket);
    assert.ok(connection);
    this.socket = socket;
    this.connection = connection;
    socket.pair();
    socket.update("open");
    await connection.drainEvents();
    const mediaKey = randomBytes(32);
    const keys = await getMediaKeys(mediaKey, "image");
    const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
    const ciphertext = Buffer.concat([cipher.update(this.payload), cipher.final()]);
    assert.ok(keys.macKey);
    const mac = createHmac("sha256", keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10);
    this.encrypted = Buffer.concat([ciphertext, mac]);
    const message: WAMessage = {
      key: { id: this.messageId, remoteJid: "200@s.whatsapp.net", fromMe: false },
      messageTimestamp: 1234,
      message: {
        imageMessage: {
          url: endpoint + "/source",
          mediaKey,
          mimetype: "image/jpeg",
          ...(options.declareSize === false ? {} : { fileLength: this.payload.byteLength }),
          fileEncSha256: createHash("sha256").update(this.encrypted).digest(),
          fileSha256: options.corruptHash
            ? randomBytes(32)
            : createHash("sha256").update(this.payload).digest(),
        },
      },
    };
    socket.events.emit("messages.upsert", { messages: [message] });
    await connection.drainEvents();
    assert.equal(this.mediaRequests, 0);
    // SQL retains the private protocol envelope, not a downloaded plaintext media archive.
    assert.match(await store.native(this.accountId, this.messageId), /imageMessage/);
    assert.doesNotMatch(
      JSON.stringify(message, BufferJSON.replacer),
      new RegExp(this.payload.toString("base64")),
    );
  }
  async close(): Promise<void>
  {
    await this.gateway?.close();
    await this.storage?.close();
    this.client?.destroy();
    this.server.closeAllConnections();
    if (this.server.listening)
    {
      await new Promise<void>((resolve, reject) =>
        this.server.close(error => error ? reject(error) : resolve())
      );
    }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

test("no-S3 media remains lazy through actual SDK attachment access and native decryption", async () =>
{
  const fixture = new MediaFixture();
  try
  {
    await fixture.start(false);
    const store = fixture.storage.workspace(fixture.workspaceId);
    const row = await store.transaction(async transaction =>
      transaction.selectFrom("event").select("message").where("workspace_id", "=", fixture.workspaceId).where(
        "account_id",
        "=",
        fixture.accountId,
      ).executeTakeFirstOrThrow()
    );
    const message = InboundMessageSchema.parse(jsonValue(row.message));
    const mapping = new GatewayChatMapping(
      { workspaceId: fixture.workspaceId, accountId: fixture.accountId },
      "100@s.whatsapp.net",
      fixture.gateway,
    );
    const attachment = mapping.parseMessage(message).attachments[0];
    assert.equal(fixture.mediaRequests, 0);
    assert.ok(attachment?.fetchData);
    assert.deepEqual(await attachment.fetchData(), fixture.payload);
    assert.equal(fixture.mediaRequests, 1);
    assert.equal(fixture.objectWrites, 0);
    assert.equal(await store.materialized(fixture.accountId, fixture.sourceId), null);
    await assert.rejects(fixture.gateway.readMedia(randomUUID(), fixture.sourceId), /scope/);
    assert.equal(fixture.mediaRequests, 1);
    fixture.expired = true;
    await assert.rejects(fixture.gateway.readMedia(fixture.accountId, fixture.sourceId));
    const missing = encodeWhatsAppMediaSource({
      workspaceId: fixture.workspaceId,
      accountId: fixture.accountId,
      messageId: "missing",
      partId: "0",
    });
    await assert.rejects(fixture.gateway.readMedia(fixture.accountId, missing), /unavailable/);
  }
  finally
  {
    await fixture.close();
  }
});

test("optional S3 mode uses real AWS SDK requests and reuses materialization after the source expires", async () =>
{
  const fixture = new MediaFixture();
  try
  {
    await fixture.start(true);
    const values = await Promise.all(
      Array.from({ length: 8 }, () => fixture.gateway.readMedia(fixture.accountId, fixture.sourceId)),
    );
    assert.ok(values.every(value => Buffer.from(value).equals(fixture.payload)));
    assert.equal(fixture.mediaRequests, 1);
    assert.equal(fixture.objectWrites, 1);
    fixture.expired = true;
    assert.deepEqual(
      Buffer.from(await fixture.gateway.readMedia(fixture.accountId, fixture.sourceId)),
      fixture.payload,
    );
    assert.equal(fixture.mediaRequests, 1);
    assert.equal(fixture.objects.size, 1);
    const entry = [...fixture.objects.entries()][0];
    assert.ok(entry);
    fixture.objects.set(entry[0], { ...entry[1], contentType: "application/octet-stream" });
    await assert.rejects(fixture.gateway.readMedia(fixture.accountId, fixture.sourceId), /metadata/);
    assert.match(
      [...fixture.objects.keys()][0] ?? "",
      new RegExp(`/media/whatsapp/${fixture.workspaceId}/${fixture.accountId}/`),
    );
  }
  finally
  {
    await fixture.close();
  }
});

for (const declareSize of [true, false])
{
  test(`direct media enforces byte limits with declared size ${declareSize}`, async () =>
  {
    const fixture = new MediaFixture();
    try
    {
      await fixture.start(false, { maximumBytes: 8, declareSize });
      await assert.rejects(fixture.gateway.readMedia(fixture.accountId, fixture.sourceId), /byte limit/);
      assert.equal(fixture.objectWrites, 0);
      assert.equal(fixture.mediaRequests, declareSize ? 0 : 1);
    }
    finally
    {
      await fixture.close();
    }
  });
}

test("a missing native file length stays optional during bounded direct retrieval", async () =>
{
  const fixture = new MediaFixture();
  try
  {
    await fixture.start(false, { declareSize: false });
    assert.deepEqual(
      Buffer.from(await fixture.gateway.readMedia(fixture.accountId, fixture.sourceId)),
      fixture.payload,
    );
  }
  finally
  {
    await fixture.close();
  }
});

test("direct native downloads time out and release a source that stalls after headers", async () =>
{
  const fixture = new MediaFixture();
  try
  {
    await fixture.start(false, { timeoutMs: 50 });
    fixture.stall = true;
    await assert.rejects(
      fixture.gateway.readMedia(fixture.accountId, fixture.sourceId),
      error => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"),
    );
    assert.equal(fixture.mediaRequests, 1);
  }
  finally
  {
    await fixture.close();
  }
});

test("native plaintext checksum mismatch prevents direct return and S3 materialization", async () =>
{
  for (const materialize of [false, true])
  {
    const fixture = new MediaFixture();
    try
    {
      await fixture.start(materialize, { corruptHash: true });
      await assert.rejects(fixture.gateway.readMedia(fixture.accountId, fixture.sourceId), /integrity/);
      assert.equal(fixture.objectWrites, 0);
    }
    finally
    {
      await fixture.close();
    }
  }
});

test("altered encrypted native bytes fail authentication before bytes reach the consumer", async () =>
{
  const fixture = new MediaFixture();
  try
  {
    await fixture.start(false);
    const first = fixture.encrypted[0];
    assert.ok(first !== undefined);
    fixture.encrypted[0] = first ^ 1;
    await assert.rejects(fixture.gateway.readMedia(fixture.accountId, fixture.sourceId), /integrity/);
  }
  finally
  {
    await fixture.close();
  }
});

for (const materialize of [false, true])
{
  test(`authenticated HTTP retrieves lazy native media with S3 mode ${materialize}`, async () =>
  {
    const fixture = new MediaFixture();
    let http: GatewayHttpTransport | undefined;
    try
    {
      await fixture.start(materialize);
      const store = fixture.storage.workspace(fixture.workspaceId);
      const principal = new GatewayPrincipal("media-agent", [{
        workspaceId: fixture.workspaceId,
        accountIds: [fixture.accountId],
      }]);
      const token = randomBytes(32).toString("hex");
      http = new GatewayHttpTransport({ enabled: true, port: 0 }, [{
        store,
        commands: new GatewayCommandIngress(new SqlCommandInbox(store)),
        gateway: fixture.gateway,
      }], [{ token, principal }]);
      await http.start();
      const url = http.origin + `/v1/accounts/${fixture.workspaceId}/${fixture.accountId}/media?sourceId=`
        + encodeURIComponent(fixture.sourceId);
      assert.equal((await fetch(url)).status, 401);
      assert.equal(fixture.mediaRequests, 0);
      const headers = { authorization: `Bearer ${token}` };
      const forbidden = url.replace(fixture.accountId, randomUUID());
      assert.equal((await fetch(forbidden, { headers })).status, 403);
      assert.equal(fixture.mediaRequests, 0);
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/octet-stream");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.payload);
      assert.equal(fixture.objectWrites, materialize ? 1 : 0);
      fixture.expired = true;
      const afterExpiry = await fetch(url, { headers });
      assert.equal(afterExpiry.status, materialize ? 200 : 503);
      if (materialize) assert.deepEqual(Buffer.from(await afterExpiry.arrayBuffer()), fixture.payload);
      else assert.deepEqual(await afterExpiry.json(), { apiVersion: "1", code: "UNAVAILABLE" });
    }
    finally
    {
      await http?.close();
      await fixture.close();
    }
  });
}

for (const materialize of [false, true])
{
  test(`native media identifiers distinguish the same message ID across chats with S3 mode ${materialize}`, async () =>
  {
    const fixture = new MediaFixture();
    try
    {
      await fixture.start(materialize);
      const store = fixture.storage.workspace(fixture.workspaceId);
      const oldSourceId = encodeWhatsAppMediaSource({
        workspaceId: fixture.workspaceId,
        accountId: fixture.accountId,
        messageId: fixture.messageId,
        partId: "0",
      });
      if (materialize) await fixture.gateway.readMedia(fixture.accountId, oldSourceId);
      const secondPayload = Buffer.from("second chat private media payload");
      const mediaKey = randomBytes(32);
      const keys = await getMediaKeys(mediaKey, "image");
      const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
      const ciphertext = Buffer.concat([cipher.update(secondPayload), cipher.final()]);
      const mac = createHmac("sha256", keys.macKey!).update(keys.iv).update(ciphertext).digest().subarray(
        0,
        10,
      );
      const encrypted = Buffer.concat([ciphertext, mac]);
      fixture.sourceObjects.set("/source-b", encrypted);
      const address = fixture.server.address();
      assert.ok(address && typeof address !== "string");
      const native: WAMessage = {
        key: { id: fixture.messageId, remoteJid: "300@s.whatsapp.net", fromMe: false },
        messageTimestamp: 1235,
        message: {
          imageMessage: {
            url: `http://127.0.0.1:${address.port}/source-b`,
            mediaKey,
            mimetype: "image/jpeg",
            fileLength: secondPayload.byteLength,
            fileEncSha256: createHash("sha256").update(encrypted).digest(),
            fileSha256: createHash("sha256").update(secondPayload).digest(),
          },
        },
      };
      fixture.socket?.events.emit("messages.upsert", { messages: [native] });
      await fixture.connection?.drainEvents();
      const second = await new SqlGatewayHistory(store).message({
        apiVersion: "1",
        workspaceId: fixture.workspaceId,
        accountId: fixture.accountId,
        chatAddress: "300@s.whatsapp.net",
        messageId: fixture.messageId,
      });
      assert.ok(second && "media" in second.message && "sourceId" in second.message.media);
      assert.notEqual(second.message.media.sourceId, fixture.sourceId);
      const legacy = encodeWhatsAppMediaSource({
        workspaceId: fixture.workspaceId,
        accountId: fixture.accountId,
        messageId: fixture.messageId,
        partId: "0",
      });
      await assert.rejects(fixture.gateway.readMedia(fixture.accountId, legacy), /ambiguous/);

      assert.deepEqual(
        Buffer.from(await fixture.gateway.readMedia(fixture.accountId, fixture.sourceId)),
        fixture.payload,
      );
      assert.deepEqual(
        Buffer.from(await fixture.gateway.readMedia(fixture.accountId, second.message.media.sourceId)),
        secondPayload,
      );
    }
    finally
    {
      await fixture.close();
    }
  });
}

test("remote HTTP and Redis media use actual native decryption and private S3 upload without SQL blobs", async () =>
{
  const fixture = new MediaFixture();
  let http: GatewayHttpTransport | undefined;
  let redis: GatewayRedisTransport | undefined;
  const redisUrl = process.env["GATEWAY_TEST_REDIS_URL"];
  assert.ok(redisUrl);
  const client = createClient({ url: redisUrl });
  client.on("error", () => undefined);
  try
  {
    await fixture.start(true);
    const store = fixture.storage.workspace(fixture.workspaceId);
    const queries = new GatewayQueryService(
      store,
      fixture.gateway,
      new SqlGatewayHistory(store),
      fixture.gateway,
    );
    const scope = { workspaceId: fixture.workspaceId, accountId: fixture.accountId };
    const principal = new GatewayPrincipal("media-consumer", [{
      workspaceId: fixture.workspaceId,
      accountIds: [fixture.accountId],
    }]);
    const token = randomUUID();
    http = new GatewayHttpTransport({ enabled: true, port: 0 }, [{
      store,
      gateway: fixture.gateway,
      queries,
      commands: new GatewayCommandIngress(new SqlCommandInbox(store)),
    }], [{ token, principal }]);
    await http.start();
    const payload = Buffer.from("remote outbound bytes");
    const upload = {
      ...scope,
      apiVersion: "1",
      requestId: randomUUID(),
      type: "media.upload",
      contentType: "image/jpeg",
      fileName: "sample.jpg",
      media: { encoding: "base64", bytes: payload.toString("base64"), byteSize: payload.byteLength },
    };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const response = await fetch(http.origin + "/v1/media", {
      method: "POST",
      headers,
      body: JSON.stringify(upload),
    });
    assert.equal(response.status, 200);
    const result = GatewayMediaUploadResultSchema.parse(await response.json());
    const duplicate = await fetch(http.origin + "/v1/media", {
      method: "POST",
      headers,
      body: JSON.stringify(upload),
    });
    assert.deepEqual(await duplicate.json(), result);
    assert.equal(fixture.objects.size, 1);
    const read = {
      ...scope,
      apiVersion: "1",
      requestId: randomUUID(),
      type: "media.readStored",
      reference: result.result,
    };
    const stored = await fetch(http.origin + "/v1/queries", {
      method: "POST",
      headers,
      body: JSON.stringify(read),
    });
    const storedResponse = GatewayQueryResponseSchema.parse(await stored.json());
    assert.equal(storedResponse.type, "media.readStored");
    if (storedResponse.type !== "media.readStored") throw new Error("Incorrect media response");
    assert.deepEqual(Buffer.from(storedResponse.result.bytes, "base64"), payload);
    const prefix = `test:${randomUUID()}`;
    redis = new GatewayRedisTransport(
      new SqlRedisStreamStore(store),
      { enabled: true, url: redisUrl, prefix },
      [{ accountId: fixture.accountId, principal }],
      undefined,
      queries,
    );
    await redis.start();
    await client.connect();
    const streams = gatewayStreamNames(prefix, scope);
    await client.xAdd(streams.commands, "*", {
      payload: JSON.stringify({
        ...scope,
        apiVersion: "1",
        requestId: randomUUID(),
        type: "media.read",
        sourceId: fixture.sourceId,
      }),
    });
    await redis.consumeOnce();
    const events = await client.xRange(streams.results, "-", "+");
    assert.ok(events && events.length === 1);
    const event = GatewayQueryCloudEventSchema.parse(JSON.parse(events[0]!.message["payload"]!));
    assert.equal(event.data.response?.type, "media.read");
    if (event.data.response?.type !== "media.read") throw new Error("Native media reply unavailable");
    assert.deepEqual(Buffer.from(event.data.response.result.bytes, "base64"), fixture.payload);
    const wrong = {
      ...read,
      reference: {
        ...result.result,
        storageKey: result.result.storageKey.replace(fixture.accountId, randomUUID()),
      },
    };
    const forbidden = await fetch(http.origin + "/v1/queries", {
      method: "POST",
      headers,
      body: JSON.stringify(wrong),
    });
    assert.equal(forbidden.status, 503);
    await assert.rejects(
      queries.execute(principal, { ...read, reference: { ...result.result, byteSize: 999999999 } }),
    );
    const sourceBodies = await store.transaction(transaction =>
      transaction.selectFrom("public_event").selectAll().where("workspace_id", "=", fixture.workspaceId)
        .where("account_id", "=", fixture.accountId).execute()
    );
    assert.ok(!JSON.stringify(sourceBodies).includes(payload.toString("base64")));
    assert.equal((await client.xPending(streams.commands, "gateway")).pending, 0);
    const remote = new GatewayRemoteClient(
      scope,
      new GatewayHttpClient({ url: http.origin!, token, pollIntervalMs: 5, timeoutMs: 10000 }),
    );
    const adapter = new WhatsAppGatewayAdapter({ ...scope, client: remote, nativeJid: "100@s.whatsapp.net" });
    try
    {
      const observation = await new SqlGatewayHistory(store).message({
        ...scope,
        apiVersion: "1",
        chatAddress: "200@s.whatsapp.net",
        messageId: fixture.messageId,
      });
      assert.ok(observation);
      const projected = adapter.parseMessage(observation);
      const attachment = projected.attachments[0];
      assert.ok(attachment?.fetchData);
      assert.deepEqual(await attachment.fetchData(), fixture.payload);
      assert.deepEqual(await adapter.rehydrateAttachment(attachment).fetchData?.(), fixture.payload);
      const threadId = adapter.encodeThreadId({ ...scope, chatId: "200@s.whatsapp.net" });
      const post = adapter.postWithKey(threadId, {
        raw: "document",
        files: [{ data: payload, filename: "sample.txt", mimeType: "text/plain" }],
      }, "sdk-file-upload");
      let finished = false;
      void post.finally(() =>
      {
        finished = true;
      }).catch(() => undefined);
      const worker = new GatewayCommandWorker(new SqlCommandInbox(store), fixture.gateway);
      const deadline = Date.now() + 10000;
      while (!finished && Date.now() < deadline)
      {
        await worker.runOne(await fixture.gateway.ownership(fixture.accountId));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const accepted = await post;
      assert.equal(accepted.raw.message.contentKind, "FILE");
      assert.equal(adapter.parseMessage(accepted.raw).author.isMe, true);
    }
    finally
    {
      await adapter.disconnect();
    }
  }
  finally
  {
    await http?.close();
    await redis?.close();
    if (client.isOpen) await client.close();
    await fixture.close();
  }
});
