import assert from "node:assert/strict";
import test from "node:test";
import { verifyRedisServerVersion } from "../src/infrastructure/redis/transport.ts";

test("Redis Streams accepts the 8.x range from its required 8.2 features", () =>
{
  for (const version of ["8.2.0", "8.2.10", "8.9.1", "8.10.2"])
  {
    assert.doesNotThrow(() => verifyRedisServerVersion(`# Server\r\nredis_version:${version}\r\n`));
  }
});

test("Redis Streams rejects older, unqualified major and malformed server versions", () =>
{
  for (const version of ["7.4.0", "8.0.0", "8.1.9", "9.0.0", "8.2", "8.2.0-extra", "invalid"])
  {
    assert.throws(
      () => verifyRedisServerVersion(`redis_version:${version}\n`),
      /Redis Streams requires Redis 8\.2 or later within 8\.x/,
    );
  }
  assert.throws(() => verifyRedisServerVersion("# Server\n"), /Redis Streams requires Redis/);
  assert.throws(
    () => verifyRedisServerVersion("prefix_redis_version:8.10.2\n"),
    /Redis Streams requires Redis/,
  );
});
