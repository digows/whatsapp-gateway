import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readReleaseVersion, writeConsumerChecksums } from "./release.mjs";

const execute = promisify(execFile);
const temporaryRoot = process.env["TMPDIR"];
if (!temporaryRoot) throw new Error("Explicit owned temporary root required");

async function createFixture()
{
  const root = await mkdtemp(join(temporaryRoot, "gateway-release-"));
  for (const directory of [".", "runtime", "packages/contracts", "packages/chat-adapter"])
  {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "package.json"), JSON.stringify({ version: "2.0.0" }));
  }
  return root;
}

async function packFixture(root, name, overrides = {})
{
  const staging = await mkdtemp(join(root, "package-staging-"));
  await mkdir(join(staging, "package/dist"), { recursive: true });
  await writeFile(join(staging, "package/dist/index.js"), "export {};\n");
  await writeFile(join(staging, "package/dist/index.d.ts"), "export {};\n");
  const manifest = {
    name,
    version: "2.0.0",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    dependencies: { "@digows/whatsapp-gateway-contracts": "2.0.0" },
    ...overrides,
  };
  await writeFile(join(staging, "package/package.json"), JSON.stringify(manifest));
  const filename = `${name.replace("@", "").replace("/", "-")}-2.0.0.tgz`;
  await execute("tar", ["-czf", join(root, filename), "-C", staging, "package"]);
}

test("release metadata requires synchronized stable versions and exact tag", async () =>
{
  const root = await createFixture();
  try
  {
    assert.equal(await readReleaseVersion(root, "v2.0.0"), "2.0.0");
    await assert.rejects(readReleaseVersion(root, "v2.0.1"), /tag must match/);
    await assert.rejects(readReleaseVersion(root, "2.0.0"), /tag must match/);
    await writeFile(join(root, "runtime/package.json"), JSON.stringify({ version: "2.0.1" }));
    await assert.rejects(readReleaseVersion(root), /version mismatch/);
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "02.0.0" }));
    await assert.rejects(readReleaseVersion(root), /stable SemVer/);
  }
  finally
  {
    await rm(root, { recursive: true, force: true });
  }
});

test("release archives validate packaged versions, compiled exports and exact contracts dependency", async () =>
{
  const root = await createFixture();
  const contracts = "@digows/whatsapp-gateway-contracts";
  const adapter = "@digows/chat-adapter-whatsapp-gateway";
  try
  {
    await packFixture(root, contracts);
    await assert.rejects(writeConsumerChecksums(root, root), /exactly the versioned/);
    await packFixture(root, adapter);
    await writeConsumerChecksums(root, root);
    const checksums = await readFile(join(root, "SHA256SUMS"), "utf8");
    assert.equal(checksums.trim().split("\n").length, 2);
    await execute("shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: root });
    await packFixture(root, adapter, { dependencies: { [contracts]: "workspace:*" } });
    await assert.rejects(writeConsumerChecksums(root, root), /exact released contracts version/);
    await packFixture(root, adapter, { version: "0.0.0" });
    await assert.rejects(writeConsumerChecksums(root, root), /manifest does not match/);
    await packFixture(root, adapter, {
      exports: { ".": { types: "./dist/missing.d.ts", default: "./src/index.ts" } },
    });
    await assert.rejects(writeConsumerChecksums(root, root), /compiled release files/);
  }
  finally
  {
    await rm(root, { recursive: true, force: true });
  }
});
