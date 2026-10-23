import { SelectionContentSchema } from "@digows/whatsapp-gateway-contracts";
import type { WAMessage } from "baileys";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pino from "pino";
import {
  BaileysInboundContent,
  type InboundContentContext,
} from "../src/infrastructure/baileys/baileys-inbound-content.ts";
import { BaileysTypingActivity } from "../src/infrastructure/baileys/baileys-typing-activity.ts";
interface SelectionFixture
{
  readonly replyMessageId: string;
  readonly wireType: string;
  readonly selectedIdentifier: string;
  readonly targetMessageId: string;
  readonly response: Record<string, unknown>;
}
interface FixtureArchive
{
  readonly fixtures: readonly SelectionFixture[];
}
test("twelve captured button/list/native-flow callbacks preserve actual IDs, origins and captured indices", async () =>
{
  const archive: FixtureArchive = JSON.parse(
    await readFile(new URL("./fixtures/native-response-fixtures.json", import.meta.url), "utf8"),
  );
  assert.equal(archive.fixtures.length, 12);
  for (const fixture of archive.fixtures)
  {
    const message: WAMessage = {
      key: { id: fixture.replyMessageId, remoteJid: "200@s.whatsapp.net" },
      message: { [fixture.wireType]: fixture.response },
      messageTimestamp: 1234,
    };
    const context: InboundContentContext = {
      workspaceId: randomUUID(),
      accountId: randomUUID(),
      message,
      receivingAddress: "100@s.whatsapp.net",
      address: async value =>
      {
        if (!value)
        {
          throw new Error("Missing native identity");
        }
        return value;
      },
      cachedMessage: () => undefined,
    };
    const selected = SelectionContentSchema.parse(await new BaileysInboundContent(context).normalize());
    assert.equal(selected.optionId, fixture.selectedIdentifier);
    assert.equal(selected.originatingChannelMessageId, fixture.targetMessageId);
  }
});
test("typing heartbeat expires and cannot remain composing indefinitely", async () =>
{
  const signals: string[] = [];
  const activity = new BaileysTypingActivity(
    {
      sendPresenceUpdate: async state =>
      {
        signals.push(state);
      },
    },
    "200@s.whatsapp.net",
    {
      minimumDelayMs: 0,
      maximumDelayMs: 0,
      presenceTimeoutMs: 20,
      heartbeatTtlMs: 30,
      minimumHeartbeatIntervalMs: 3,
      maximumHeartbeatIntervalMs: 5,
    },
    pino({ level: "silent" }),
    () =>
    {},
  );
  await activity.start(30);
  await activity.heartbeat();
  assert.equal(signals.at(-1), "paused");
  const count = signals.length;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(signals.length, count);
  await activity.stop();
});
