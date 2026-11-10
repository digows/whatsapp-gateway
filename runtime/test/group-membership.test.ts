import { GatewayCloudEventSchema } from "@digows/whatsapp-gateway-contracts";
import { type GroupParticipant, proto, type WAMessage } from "baileys";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Gateway } from "../src/application/gateway.ts";
import { BaileysConnection } from "../src/infrastructure/baileys/baileys-connection.ts";
import { SqlGatewayEventLog } from "../src/infrastructure/sql/event-log.ts";
import {
  migrateGatewayStorage,
  openGatewayStorage,
  type StorageConfiguration,
} from "../src/infrastructure/sql/storage.ts";
import { SqlWebhookOutbox } from "../src/infrastructure/sql/webhook-outbox.ts";
import { NativeSocketFixture } from "./support/native-socket.ts";

const temporaryRoot = process.env["TMPDIR"];
const postgresUrl = process.env["GATEWAY_TEST_DATABASE_URL"];
if (!temporaryRoot || !postgresUrl) throw new Error("Explicit isolated fixtures required");
const nativeTime = 1760000000;
const groupAddress = "120000000000001@g.us";

function membershipMessage(
  id: string,
  stub: proto.WebMessageInfo.StubType,
  participants: readonly GroupParticipant[],
  actor?: string,
  alternateActor?: string,
  chatAddress = groupAddress,
): WAMessage
{
  return {
    key: {
      id,
      remoteJid: chatAddress,
      fromMe: false,
      ...(actor === undefined ? {} : { participant: actor }),
      ...(alternateActor === undefined ? {} : { participantAlt: alternateActor }),
    },
    messageTimestamp: nativeTime,
    messageStubType: stub,
    messageStubParameters: participants.map(participant => JSON.stringify(participant)),
  };
}

for (const engine of ["sqlite", "postgresql"] as const)
{
  test(`${engine} publishes only the connected number's native group membership changes`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "membership-"));
    const workspaceId = randomUUID();
    const accountId = randomUUID();
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId, filename: join(directory, "gateway.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    await migrateGatewayStorage(configuration);
    const storage = await openGatewayStorage(configuration);
    const store = storage.workspace(workspaceId);
    let connection: BaileysConnection;
    let socket: NativeSocketFixture;
    const gateway = new Gateway(store, (_account, lease) =>
    {
      connection = new BaileysConnection(store, lease, null, settings =>
      {
        socket = new NativeSocketFixture(settings);
        return socket.socket;
      });
      return connection;
    }, { minimumDelayMs: 0, maximumDelayMs: 0, typingDelayMs: 0 });
    try
    {
      await store.createAccount(accountId);
      await gateway.start(accountId);
      socket!.pair("100:2@s.whatsapp.net");
      socket!.authentication.creds.me!.lid = "900:3@lid";
      socket!.update("open");
      await connection!.drainEvents();
      const added = membershipMessage(
        "self-added",
        proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
        [{ id: "900@lid", phoneNumber: "100@s.whatsapp.net" }],
        "800:4@lid",
        "200@s.whatsapp.net",
      );
      const removed = membershipMessage(
        "self-removed",
        proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_REMOVE,
        [{ id: "900@lid" }],
      );
      socket!.events.emit("messages.upsert", {
        messages: [
          added,
          added,
          membershipMessage("other-added", proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD, [{
            id: "300@s.whatsapp.net",
          }]),
          membershipMessage(
            "same-user-different-server",
            proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
            [{ id: "100@lid" }],
          ),
          membershipMessage("self-promoted", proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_PROMOTE, [{
            id: "100@s.whatsapp.net",
          }]),
          { ...added, key: { ...added.key, id: "malformed" }, messageStubParameters: ["not JSON"] },
          removed,
          membershipMessage("self-left", proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_LEAVE, [{
            id: "100@s.whatsapp.net",
          }], "100@s.whatsapp.net"),
          membershipMessage("self-invited", proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_INVITE, [{
            id: "100@s.whatsapp.net",
          }], "800@lid"),
          membershipMessage(
            "self-approved",
            proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN,
            [{ id: "100@s.whatsapp.net" }],
          ),
        ],
      });
      await connection!.drainEvents();
      const log = new SqlGatewayEventLog(store);
      const changes = (await log.after(accountId, 0, 100))
        .filter(event => event.type === "com.digows.whatsapp.group.membership.v1");
      assert.equal(changes.length, 5);
      assert.deepEqual(changes.map(event => event.data.change), [
        "JOINED",
        "LEFT",
        "LEFT",
        "JOINED",
        "JOINED",
      ]);
      assert.deepEqual(changes[0]!.data, {
        workspaceId,
        accountId,
        receivingAddress: "100@s.whatsapp.net",
        chatAddress: groupAddress,
        channelMessageId: "self-added",
        occurredAt: new Date(nativeTime * 1000).toISOString(),
        change: "JOINED",
        actorAddress: "200@s.whatsapp.net",
      });
      assert.equal(Object.hasOwn(changes[1]!.data, "actorAddress"), false);
      assert.equal(changes[2]!.data.actorAddress, "100@s.whatsapp.net");
      assert.equal(changes[3]!.data.actorAddress, "800@lid");
      assert.equal((await store.account(accountId)).state, "CONNECTED");
      assert.equal(
        (await log.after(accountId, 0, 100))
          .filter(event => event.type === "com.digows.whatsapp.message.rejected.v1").length,
        1,
      );
      for (const event of changes)
      {
        assert.deepEqual(GatewayCloudEventSchema.parse(JSON.parse(JSON.stringify(event))), event);
        assert.equal(event.workspaceid, workspaceId);
        assert.equal(event.accountid, accountId);
      }

      socket!.events.emit("messages.upsert", {
        messages: [
          membershipMessage("self-added", proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD, [{
            id: "100@s.whatsapp.net",
          }]),
          membershipMessage(
            "self-added",
            proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD,
            [{ id: "100@s.whatsapp.net" }],
            undefined,
            undefined,
            "120000000000002@g.us",
          ),
        ],
      });
      await connection!.drainEvents();
      const replayed = (await log.after(accountId, 0, 100))
        .filter(event => event.type === "com.digows.whatsapp.group.membership.v1");
      assert.equal(replayed.length, 6);
      assert.deepEqual(replayed[0], changes[0]);
      assert.notEqual(replayed[5]!.id, changes[0]!.id);

      const createdGroup = "120000000000003@g.us";
      socket!.events.emit("groups.upsert", [{ id: createdGroup, participants: [{ id: "900@lid" }] }]);
      socket!.events.emit("messages.upsert", {
        messages: [{
          ...membershipMessage(
            "self-created",
            proto.WebMessageInfo.StubType.GROUP_CREATE,
            [],
            "200@s.whatsapp.net",
            undefined,
            createdGroup,
          ),
          messageStubParameters: ["A new group"],
        }],
      });
      await connection!.drainEvents();
      const created = (await log.after(accountId, 0, 100))
        .filter(event => event.type === "com.digows.whatsapp.group.membership.v1");
      assert.equal(created.length, 7);
      assert.equal(created[6]!.data.change, "JOINED");
      assert.equal(created[6]!.data.chatAddress, createdGroup);
      const unrelatedGroup = "120000000000004@g.us";
      socket!.events.emit("groups.upsert", [{
        id: unrelatedGroup,
        participants: [{ id: "300@s.whatsapp.net" }],
      }]);
      socket!.events.emit("messages.upsert", {
        messages: [
          membershipMessage(
            "unrelated-create",
            proto.WebMessageInfo.StubType.GROUP_CREATE,
            [],
            undefined,
            undefined,
            unrelatedGroup,
          ),
        ],
      });
      await connection!.drainEvents();
      assert.equal(
        (await log.after(accountId, 0, 100))
          .filter(event => event.type === "com.digows.whatsapp.group.membership.v1").length,
        7,
      );

      const lease = await gateway.ownership(accountId);
      lease.lose();
      socket!.events.emit("messages.upsert", {
        messages: [
          membershipMessage("stale", proto.WebMessageInfo.StubType.GROUP_PARTICIPANT_ADD, [{
            id: "100@s.whatsapp.net",
          }]),
        ],
      });
      await connection!.drainEvents();
      assert.equal(
        (await log.after(accountId, 0, 100))
          .filter(event => event.type === "com.digows.whatsapp.group.membership.v1").length,
        7,
      );
    }
    finally
    {
      await gateway.close();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`${engine} membership events isolate accounts and workspaces, replay durably and enqueue one webhook`, async () =>
  {
    const directory = await mkdtemp(join(temporaryRoot, "membership-scopes-"));
    const workspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const accountId = randomUUID();
    const secondAccountId = randomUUID();
    const configuration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId, filename: join(directory, "gateway.sqlite"), mode: "local" }
      : { engine, url: postgresUrl, mode: "cluster" };
    const otherConfiguration: StorageConfiguration = engine === "sqlite"
      ? { engine, workspaceId: otherWorkspaceId, filename: join(directory, "other.sqlite"), mode: "local" }
      : configuration;
    await migrateGatewayStorage(configuration);
    await migrateGatewayStorage(otherConfiguration);
    let storage = await openGatewayStorage(configuration);
    const otherStorage = await openGatewayStorage(otherConfiguration);
    let store = storage.workspace(workspaceId);
    const otherStore = otherStorage.workspace(otherWorkspaceId);
    await store.createAccount(accountId);
    await store.createAccount(secondAccountId);
    await otherStore.createAccount(accountId);
    let lease = await store.acquire(accountId);
    const secondLease = await store.acquire(secondAccountId);
    const otherLease = await otherStore.acquire(accountId);
    const destination = {
      workspaceId,
      accountId,
      id: randomUUID(),
      url: "https://consumer.invalid/events",
      secret: randomUUID(),
      enabled: true,
    };
    const change = {
      receivingAddress: "100@s.whatsapp.net",
      chatAddress: groupAddress,
      channelMessageId: "scoped-occurrence",
      occurredAt: new Date(nativeTime * 1000).toISOString(),
      change: "JOINED" as const,
    };
    try
    {
      await new SqlWebhookOutbox(store).configure(destination);
      await Promise.all([
        ...Array.from({ length: 4 }, () => store.recordGroupMembership(lease, change)),
        store.recordGroupMembership(secondLease, change),
        otherStore.recordGroupMembership(otherLease, change),
      ]);
      const own = (await new SqlGatewayEventLog(store).after(accountId, 0, 100))
        .filter(event => event.type === "com.digows.whatsapp.group.membership.v1");
      const second = (await new SqlGatewayEventLog(store).after(secondAccountId, 0, 100))
        .filter(event => event.type === "com.digows.whatsapp.group.membership.v1");
      const other = (await new SqlGatewayEventLog(otherStore).after(accountId, 0, 100))
        .filter(event => event.type === "com.digows.whatsapp.group.membership.v1");
      assert.equal(own.length, 1);
      assert.equal(second.length, 1);
      assert.equal(other.length, 1);
      assert.equal(new Set([own[0]!.id, second[0]!.id, other[0]!.id]).size, 3);
      assert.equal((await new SqlWebhookOutbox(store).deliveries(accountId, destination.id)).length, 1);
      const claim = await new SqlWebhookOutbox(store).claim(destination);
      assert.ok(claim);
      assert.deepEqual(JSON.parse(claim.body), own[0]);
      await assert.rejects(otherStore.recordGroupMembership(lease, change), /ownership/);
      await lease.release();
      await secondLease.release();
      await storage.close();
      storage = await openGatewayStorage(configuration);
      store = storage.workspace(workspaceId);
      lease = await store.acquire(accountId);
      await store.recordGroupMembership(lease, change);
      const reopened = (await new SqlGatewayEventLog(store).after(accountId, 0, 100))
        .filter(event => event.type === "com.digows.whatsapp.group.membership.v1");
      assert.deepEqual(reopened, own);
      assert.equal(
        (await new SqlWebhookOutbox(store).deliveries(accountId, destination.id))
          .filter(delivery => delivery.eventId === own[0]!.id).length,
        1,
      );
      await lease.release();
      await assert.rejects(store.recordGroupMembership(lease, change), /ownership/);
    }
    finally
    {
      await lease.release();
      await secondLease.release();
      await otherLease.release();
      await storage.close();
      await otherStorage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
