import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { composePluginSource } from "./lib/plugin-source.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = new URL("../main.js", import.meta.url);
const source = await composePluginSource(root);
if (process.argv[2] === "--check") {
  if (await readFile(path, "utf8") !== source) {
    throw new Error("main.js is stale; run npm run build:source before committing.");
  }
  console.log("Generated plugin source matches src/*.js.");
} else if (process.argv.length === 2) {
  await writeFile(path, source);
  console.log("Generated main.js from source modules.");
} else {
  throw new Error("Usage: node scripts/build-source.mjs [--check]");
}
