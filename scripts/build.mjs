import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
for (const project of ["packages/contracts", "runtime", "packages/chat-adapter"])
{
  await rm(new URL(`${project}/dist/`, root), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)),
    "-p",
    `${project}/tsconfig.build.json`,
  ], { cwd: fileURLToPath(root), stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
