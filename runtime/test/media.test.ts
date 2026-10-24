import { type S3Client } from "@aws-sdk/client-s3";
import { InboundMessageSchema } from "@digows/whatsapp-gateway-contracts";
import { BufferJSON, getMediaKeys, type WAMessage } from "baileys";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayChatMapping } from "../../packages/chat-adapter/src/index.ts";
import { Gateway } from "../src/application/gateway.ts";
import { encodeWhatsAppMediaSource } from "../src/domain/media-source.ts";
import { BaileysConnection } from "../src/infrastructure/baileys/baileys-connection.ts";
import { createMediaStorage } from "../src/infrastructure/s3/configuration.ts";
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
  readonly payload = Buffer.from("controlled encrypted WhatsApp media");
  readonly accountId = randomUUID();
  readonly workspaceId = randomUUID();
  readonly messageId = randomUUID();
  readonly server: Server;
  readonly sourceId = encodeWhatsAppMediaSource({
    workspaceId: this.workspaceId,
    accountId: this.accountId,
    messageId: this.messageId,
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
    if (request.url === "/source")
    {
      this.mediaRequests++;
      response.writeHead(this.expired ? 404 : 200);
      if (this.stall)
      {
        response.flushHeaders();
        return;
      }
      response.end(this.expired ? "Unavailable" : this.encrypted);
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
