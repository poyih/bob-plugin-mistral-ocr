import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ASSET_NAME, digest, validatePendingRelease } from "./lib/release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const script of ["build-source.mjs", "build-plugin.mjs"]) {
  const result = spawnSync(process.execPath, [`scripts/${script}`], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const info = JSON.parse(await readFile(new URL("../info.json", import.meta.url), "utf8"));
let previous;
try { previous = JSON.parse(await readFile(new URL("../release-pending.json", import.meta.url), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const desc = process.argv[2] || (previous?.version === info.version ? previous.desc : "");
if (!desc) throw new Error('Provide release notes: npm run stage:release -- "Description"');
const archive = await readFile(new URL("../dist/Mistral-OCR.bobplugin", import.meta.url));
const pending = { identifier: info.identifier, version: info.version, desc,
  sha256: digest(archive), url: `${info.homepage}/releases/download/v${info.version}/${ASSET_NAME}`,
  minBobVersion: info.minBobVersion, timestamp: previous?.version === info.version ? previous.timestamp : Date.now() };
validatePendingRelease(info, pending, archive);
await writeFile(new URL("../release-pending.json", import.meta.url), JSON.stringify(pending, null, 4) + "\n");
console.log(`Staged v${info.version}; the published appcast was not modified.`);
