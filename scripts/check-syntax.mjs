import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
async function filesIn(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? filesIn(`${directory}/${entry.name}`)
    : [/\.(?:m?js)$/.test(entry.name) ? `${directory}/${entry.name}` : null].filter(Boolean)));
  return groups.flat();
}
const files = ["main.js", ...(await Promise.all(["src", "scripts", "tests"].map(filesIn))).flat()].sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checks passed (${files.length} JavaScript files).`);
