import { type MediaReference, type OutboundMessage } from "@digows/whatsapp-gateway-contracts";
import { type WAMessage } from "baileys";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Gateway } from "../src/application/gateway.ts";
import { encodeWhatsAppMediaSource } from "../src/domain/media-source.ts";
import type { IMediaRepository } from "../src/domain/media-storage.ts";
import { BaileysConnection } from "../src/infrastructure/baileys/baileys-connection.ts";
import { PostgresGatewayStore } from "../src/infrastructure/postgres/gateway-store.ts";
import { NativeSocketFixture } from "./support/native-socket.ts";
class Media implements IMediaRepository
{
  readonly objects = new Map<string, Uint8Array>();
  writes = 0;
  async write(key: string, bytes: Uint8Array, contentType: string, fileName?: string): Promise<MediaReference>
  {
    this.writes++;
    this.objects.set(key, bytes);
    return { storageKey: key, contentType, byteSize: bytes.byteLength, ...(fileName ? { fileName } : {}) };
  }
  async read(reference: MediaReference): Promise<Uint8Array>
  {
    const bytes = this.objects.get(reference.storageKey);
    if (!bytes) throw new Error("Media unavailable");
    return bytes;
  }
}
const url = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!url) throw new Error("Owned disposable database required");
const store = new PostgresGatewayStore(url, randomUUID());
const accountId = randomUUID();
const media = new Media();
const connections: BaileysConnection[] = [];
const sockets: NativeSocketFixture[] = [];
const gateway = new Gateway(store, (_account, lease) =>
{
  const connection = new BaileysConnection(store, lease, media, configuration =>
  {
    const socket = new NativeSocketFixture(configuration);
    sockets.push(socket);
    return socket.socket;
  });
  connections.push(connection);
  return connection;
}, {
  minimumDelayMs: 0,
  maximumDelayMs: 0,
  dailyMaximum: 1500,
  sendTimeoutMs: 1000,
  typingDelayMs: 0,
  sendRateLimit: 100,
}, media);
after(async () =>
{
  await gateway.close();
  await store.close();
});

test("real Baileys adapter persists QR/creds, recreates on 515 and restores without a new QR", async () =>
{
  await store.createAccount(accountId);
  await gateway.start(accountId);
  const first = sockets[0];
  assert.ok(first);
  first.events.emit("connection.update", { qr: "fixture-qr" });
  await connections[0]?.drainEvents();
  assert.equal((await store.account(accountId)).state, "AWAITING_PAIRING");
  assert.match((await store.account(accountId)).qr ?? "", /^data:image\/png;base64,/);
  first.pair();
  first.update("close", 515);
  await connections[0]?.drainEvents();
  assert.equal(sockets.length, 2);
  assert.equal(first.closed, true);
  first.update("open");
  sockets[1]?.update("open");
  await connections[0]?.drainEvents();
  assert.equal((await store.account(accountId)).state, "CONNECTED");
  assert.equal((await store.account(accountId)).nativeJid, "100@s.whatsapp.net");
  await gateway.stop(accountId);
  await gateway.restore();
  const restored = sockets.at(-1);
  assert.ok(restored);
  assert.equal(restored.authentication.creds.me?.id, "100@s.whatsapp.net");
  restored.update("open");
  await connections.at(-1)?.drainEvents();
  assert.equal((await store.account(accountId)).qr, null);
});

test("rich sends exercise native builders with stable reserved IDs and ordered album association", async () =>
{
  const reference = await media.write(
    `media/whatsapp/${store.workspaceId}/${accountId}/image`,
    Buffer.from("image"),
    "image/jpeg",
  );
  const kinds: OutboundMessage[] = [
    {
      channel: "WHATSAPP",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "image",
      contentKind: "IMAGE",
      media: reference,
      caption: "ação",
    },
    {
      channel: "WHATSAPP",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "voice",
      contentKind: "AUDIO",
      media: reference,
      presentation: "VOICE_NOTE",
    },
    {
      channel: "WHATSAPP",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "gif",
      contentKind: "VIDEO",
      media: reference,
      presentation: "ANIMATION",
    },
    {
      channel: "WHATSAPP",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "buttons",
      contentKind: "BUTTONS",
      text: "Choose",
      choices: [{ id: "yes", label: "Yes" }],
    },
    {
      channel: "WHATSAPP",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "carousel",
      contentKind: "CAROUSEL",
      text: "Cards",
      cards: [{ title: "Card", text: "First", image: reference, choices: [{ id: "pick", label: "Pick" }] }],
    },
    {
      channel: "WHATSAPP",
      senderAddress: "100@s.whatsapp.net",
      recipientAddress: "200@s.whatsapp.net",
      idempotencyKey: "album",
      contentKind: "ALBUM",
      parts: [{ contentKind: "IMAGE", media: reference }, {
        contentKind: "VIDEO",
        media: reference,
        presentation: "VIDEO_NOTE",
      }],
    },
  ];
  for (const input of kinds)
  {
    const result = await gateway.send(accountId, input);
    assert.equal(result.state, "ACCEPTED");
    assert.equal(result.acceptedParts, result.nativeIds.length);
  }
  const sent = sockets.at(-1)?.sent;
  assert.ok(sent);
  assert.equal(sent.length, 8);
  assert.ok("image" in sent[0]!.content);
  assert.equal("ptt" in sent[1]!.content ? sent[1]!.content.ptt : false, true);
  assert.equal("gifPlayback" in sent[2]!.content ? sent[2]!.content.gifPlayback : false, true);
  const parent = sent[5];
  const child = sent[6];
  assert.ok(parent && child);
  assert.ok("albumParentKey" in child.content);
  assert.equal(child.content.albumParentKey?.id, parent.options?.messageId);
});

test("incoming media is retained without download, explicit concurrent materialization is reused and scoped", async () =>
{
  const message: WAMessage = {
    key: { id: "incoming-link", remoteJid: "200@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1234,
    message: {
      extendedTextMessage: {
        text: "https://example.org",
        matchedText: "https://example.org",
        jpegThumbnail: Buffer.from("thumbnail"),
      },
    },
  };
  const before = media.writes;
  sockets.at(-1)?.events.emit("messages.upsert", { messages: [message] });
  await connections.at(-1)?.drainEvents();
  assert.equal(media.writes, before);
  const source = encodeWhatsAppMediaSource({
    workspaceId: store.workspaceId,
    accountId,
    messageId: "incoming-link",
    partId: "thumbnail",
  });
  const values = await Promise.all(Array.from({ length: 8 }, () => gateway.readMedia(accountId, source)));
  assert.equal(Buffer.from(values[0]!).toString(), "thumbnail");
  assert.equal(media.writes, before + 1);
  const wrong = encodeWhatsAppMediaSource({
    workspaceId: randomUUID(),
    accountId,
    messageId: "incoming-link",
    partId: "thumbnail",
  });
  await assert.rejects(gateway.readMedia(accountId, wrong), /scope/);
});

test("delivery observations remain separate from submission and duplicate native receipts deduplicate", async () =>
{
  const socket = sockets.at(-1);
  assert.ok(socket);
  const key = socket.sent[0]?.options?.messageId;
  assert.ok(key);
  socket.events.emit("messages.update", [{
    key: { id: key, remoteJid: "200@s.whatsapp.net" },
    update: { status: 3 },
  }]);
  socket.events.emit("messages.update", [{
    key: { id: key, remoteJid: "200@s.whatsapp.net" },
    update: { status: 3 },
  }]);
  await connections.at(-1)?.drainEvents();
  const receipts = await store.receipts(accountId, key);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.status, "DELIVERY_ACK");
  assert.equal((await store.operation(accountId, "image")).state, "ACCEPTED");
});

test("portable rich families and correlated quote/actions reach the native send boundary intact", async () =>
{
  const reference = await media.write(
    `media/whatsapp/${store.workspaceId}/${accountId}/rich`,
    Buffer.from("image"),
    "image/jpeg",
  );
  const base = {
    channel: "WHATSAPP" as const,
    senderAddress: "100@s.whatsapp.net",
    recipientAddress: "200@s.whatsapp.net",
  };
  const target = {
    channelMessageId: "original",
    senderAddress: base.senderAddress,
    chatAddress: base.recipientAddress,
  };
  const input: OutboundMessage[] = [
    { ...base, idempotencyKey: "file", contentKind: "FILE", media: reference },
    {
      ...base,
      idempotencyKey: "sticker",
      contentKind: "STICKER",
      media: reference,
      presentation: "ANIMATED",
    },
    {
      ...base,
      idempotencyKey: "contacts",
      contentKind: "CONTACTS",
      contacts: [{
        displayName: "Sample",
        vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Sample\nTEL:+12125550100\nEND:VCARD",
      }],
    },
    {
      ...base,
      idempotencyKey: "location",
      contentKind: "LOCATION",
      location: { latitude: -23, longitude: -46 },
    },
    {
      ...base,
      idempotencyKey: "poll",
      contentKind: "POLL",
      question: "Choose",
      options: ["One", "Two"],
      selectionCount: 1,
    },
    {
      ...base,
      idempotencyKey: "event",
      contentKind: "EVENT",
      title: "Meeting",
      startsAt: "2026-10-24T12:00:00Z",
    },
    {
      ...base,
      idempotencyKey: "card",
      contentKind: "CARD",
      text: "Card",
      image: reference,
      choices: [{ id: "yes", label: "Yes" }],
    },
    {
      ...base,
      idempotencyKey: "link",
      contentKind: "LINK",
      text: "Open",
      label: "Website",
      url: "https://example.org",
    },
    {
      ...base,
      idempotencyKey: "list",
      contentKind: "LIST",
      title: "Options",
      description: "Choose",
      openingLabel: "Open",
      sections: [{ title: "Section", rows: [{ id: "first", label: "First" }] }],
    },
    { ...base, idempotencyKey: "reaction", contentKind: "REACTION", target, emoji: "✅" },
    { ...base, idempotencyKey: "edit", contentKind: "EDIT", target, text: "Corrected" },
    { ...base, idempotencyKey: "delete", contentKind: "DELETE", target },
    {
      ...base,
      idempotencyKey: "context",
      contentKind: "TEXT",
      text: "Quoted",
      quotedMessage: {
        channelMessageId: "incoming-link",
        senderAddress: base.recipientAddress,
        chatAddress: base.recipientAddress,
      },
      mentionedAddresses: [base.recipientAddress],
      forwarded: true,
      lifetimeSeconds: 86400,
      linkPreview: {
        url: "https://example.org",
        title: "Example",
        description: "Description",
        thumbnail: reference,
      },
    },
  ];
  const expected = [
    "document",
    "sticker",
    "contacts",
    "location",
    "poll",
    "event",
    "replyButtons",
    "urlButton",
    "list",
    "react",
    "edit",
    "delete",
    "text",
  ];
  for (const [index, message] of input.entries())
  {
    const result = await gateway.send(accountId, message);
    assert.equal(result.state, "ACCEPTED");
    const sent = sockets.at(-1)?.sent.at(-1);
    assert.ok(sent);
    assert.ok(expected[index]! in sent.content);
    assert.equal(sent.options?.messageId, result.nativeIds[0]);
  }
  const contextual = sockets.at(-1)?.sent.at(-1);
  assert.ok(contextual?.options?.quoted);
  assert.equal(contextual.options.ephemeralExpiration, 86400);
  await assert.rejects(
    gateway.send(accountId, {
      ...base,
      idempotencyKey: "wrong-quote",
      contentKind: "TEXT",
      text: "Wrong",
      quotedMessage: {
        channelMessageId: "incoming-link",
        senderAddress: base.recipientAddress,
        chatAddress: "300@s.whatsapp.net",
      },
    }),
    /Quote chat/,
  );
  await assert.rejects(
    gateway.send(accountId, {
      ...base,
      idempotencyKey: "foreign-media",
      contentKind: "IMAGE",
      media: { ...reference, storageKey: `media/whatsapp/${randomUUID()}/${accountId}/private` },
    }),
    /scope/,
  );
});

test("known preparation failure stays FAILED without a native resend", async () =>
{
  const result = await store.operation(accountId, "wrong-quote");
  assert.equal(result.state, "FAILED");
  const count = sockets.at(-1)?.sent.length;
  const repeated = await gateway.send(accountId, {
    channel: "WHATSAPP",
    senderAddress: "100@s.whatsapp.net",
    recipientAddress: "200@s.whatsapp.net",
    idempotencyKey: "wrong-quote",
    contentKind: "TEXT",
    text: "Wrong",
    quotedMessage: {
      channelMessageId: "incoming-link",
      senderAddress: "200@s.whatsapp.net",
      chatAddress: "300@s.whatsapp.net",
    },
  });
  assert.equal(repeated.state, "FAILED");
  assert.equal(sockets.at(-1)?.sent.length, count);
});

test("logout clears revoked credentials and restore does not start a new pairing attempt", async () =>
{
  const socket = sockets.at(-1);
  assert.ok(socket);
  socket.update("close", 401);
  await connections.at(-1)?.drainEvents();
  assert.equal((await store.account(accountId)).state, "LOGGED_OUT");
  assert.equal(await store.readAuthentication(accountId, "credentials", "default"), null);
  await gateway.stop(accountId);
  const count = sockets.length;
  await gateway.restore();
  assert.equal(sockets.length, count);
});

test("repeated QR observations do not extend the bounded unpaired attempt", async () =>
{
  const id = randomUUID();
  await store.createAccount(id);
  let connection: BaileysConnection | undefined;
  let fixture: NativeSocketFixture | undefined;
  const bounded = new Gateway(store, (_account, lease) =>
  {
    connection = new BaileysConnection(store, lease, media, configuration =>
    {
      fixture = new NativeSocketFixture(configuration);
      return fixture.socket;
    }, 20);
    return connection;
  });
  try
  {
    await bounded.start(id);
    assert.ok(fixture);
    fixture.events.emit("connection.update", { qr: "first" });
    fixture.events.emit("connection.update", { qr: "second" });
    await new Promise(resolve => setTimeout(resolve, 50));
    await connection?.drainEvents();
    assert.equal((await store.account(id)).state, "STOPPED");
    assert.equal(fixture.closed, true);
  }
  finally
  {
    await bounded.close();
  }
});
