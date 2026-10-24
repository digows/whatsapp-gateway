import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = [".", "runtime", "packages/contracts", "packages/chat-adapter"];
const consumerPackages = [
  { directory: "packages/contracts", name: "@digows/whatsapp-gateway-contracts" },
  { directory: "packages/chat-adapter", name: "@digows/chat-adapter-whatsapp-gateway" },
];

export async function readReleaseVersion(root, tag = "")
{
  const manifests = await Promise.all(
    packageDirectories.map(async directory =>
      JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"))
    ),
  );
  const version = manifests[0].version;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
  {
    throw new Error("A stable SemVer release version is required");
  }
  for (const [index, manifest] of manifests.entries())
  {
    if (manifest.version !== version)
    {
      throw new Error(`Release version mismatch in ${packageDirectories[index]}/package.json`);
    }
  }
  if (tag !== "" && tag !== `v${version}`) throw new Error("Release tag must match v<manifest version>");
  return version;
}

export async function writeConsumerChecksums(root, directory)
{
  const version = await readReleaseVersion(root);
  const expectedArchives = consumerPackages.map(consumerPackage =>
    `${consumerPackage.name.replace("@", "").replace("/", "-")}-${version}.tgz`
  ).sort();
  const archives = (await readdir(directory)).filter(filename => filename.endsWith(".tgz")).sort();
  if (JSON.stringify(archives) !== JSON.stringify(expectedArchives))
  {
    throw new Error("Consumer archives must contain exactly the versioned contracts and Adapter packages");
  }
  const checksums = [];
  for (const consumerPackage of consumerPackages)
  {
    const filename = `${consumerPackage.name.replace("@", "").replace("/", "-")}-${version}.tgz`;
    const archive = join(directory, filename);
    const { stdout: manifestText } = await execute("tar", ["-xOf", archive, "package/package.json"]);
    const manifest = JSON.parse(manifestText);
    if (manifest.name !== consumerPackage.name || manifest.version !== version)
    {
      throw new Error("Packed consumer manifest does not match the release");
    }
    if (consumerPackage.directory === "packages/chat-adapter")
    {
      if (manifest.dependencies?.[consumerPackages[0].name] !== version)
      {
        throw new Error("Packed Adapter must depend on the exact released contracts version");
      }
    }
    const { stdout: entryText } = await execute("tar", ["-tzf", archive]);
    const entries = new Set(entryText.trim().split("\n"));
    for (const conditions of Object.values(manifest.exports ?? {}))
    {
      for (const condition of ["types", "default"])
      {
        const target = conditions[condition];
        if (
          typeof target !== "string" || !target.startsWith("./dist/")
          || !entries.has(`package/${target.slice(2)}`)
        )
        {
          throw new Error("Packed consumer exports must resolve to compiled release files");
        }
      }
    }
    if (!manifest.exports || Object.keys(manifest.exports).length === 0)
    {
      throw new Error("Packed consumer exports are missing");
    }
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
    checksums.push(`${digest}  ${filename}`);
  }
  await writeFile(join(directory, "SHA256SUMS"), checksums.join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  const [command, argument = ""] = process.argv.slice(2);
  if (command === "check") console.log(await readReleaseVersion(repository, argument));
  else if (command === "artifacts" && argument) await writeConsumerChecksums(repository, resolve(argument));
  else throw new Error("Usage: node scripts/release.mjs check [v<version>] | artifacts <directory>");
}
