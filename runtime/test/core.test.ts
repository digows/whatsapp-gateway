import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SendOperation } from "../src/domain/send-operation.ts";

const operationScope = { workspaceId: randomUUID(), accountId: randomUUID() };

test("dispatch uncertainty cannot be reset into a second send", () =>
{
  const operation = new SendOperation("key", "digest", ["native-1"], operationScope);
  assert.equal(operation.state, "PENDING");
  operation.dispatch(0);
  operation.unknown();
  assert.equal(operation.state, "UNKNOWN");
  assert.throws(() => operation.dispatch(0), /UNKNOWN/);
});

test("multipart progress preserves the accepted prefix", () =>
{
  const operation = new SendOperation("album", "digest", ["parent", "child"], operationScope);
  operation.dispatch(0);
  operation.accept(0);
  operation.dispatch(1);
  operation.unknown();
  assert.equal(operation.acceptedParts, 1);
  assert.deepEqual(operation.nativeIds, ["parent", "child"]);
  assert.throws(() => operation.accept(1), /UNKNOWN/);
});

import { AccountPacing } from "../src/domain/pacing.ts";
test("account pacing enforces both the rolling window and first-day quota", () =>
{
  const now = Date.UTC(2026, 9, 23);
  const policy = {
    minimumDelayMs: 1500,
    maximumDelayMs: 5000,
    dailyMaximum: 1500,
    sendRateLimit: 2,
    sendRatePeriodMs: 60000,
    firstDayLimit: 3,
    growthFactor: 1.6,
    warmUpDays: 7,
    inactivityMs: 168 * 3600000,
  };
  let record = {
    nextSendAt: now,
    startedAt: now,
    lastActiveAt: now,
    dailyDate: "2026-10-23",
    dailyCount: 0,
    recentTimes: [] as readonly number[],
  };
  record = new AccountPacing(record, policy).reserve(now, 0);
  record = new AccountPacing(record, policy).reserve(now, 0);
  record = new AccountPacing(record, policy).reserve(now, 0);
  assert.equal(record.recentTimes.at(-1), now + 60000);
  assert.throws(() => new AccountPacing(record, policy).reserve(now), /Daily send limit/);
});
