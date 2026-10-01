import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const info = JSON.parse(await readFile(new URL("../info.json", import.meta.url), "utf8"));
const checks = [
  ["scripts/build-source.mjs", "--check"], ["scripts/check-syntax.mjs"],
  ["scripts/check-secrets.mjs"], ["scripts/validate-release-metadata.mjs"],
  ["--test"], ["scripts/build-plugin.mjs"],
  ["scripts/build-plugin.mjs", "--check"],
  ["scripts/prepare-release.mjs", `v${info.version}`, "dist/release-notes.md"],
];
for (const args of checks) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
