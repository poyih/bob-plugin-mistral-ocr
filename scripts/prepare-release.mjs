#!/usr/bin/env node

// Prepares a GitHub release for a version tag. It verifies that the tag,
// info.json, release-pending.json and the freshly built archive all
// describe the same version, download URL and SHA-256, then writes the
// release notes for that version.
//
// Usage: node scripts/prepare-release.mjs vX.Y.Z <notes-output-path>

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePendingRelease } from "./lib/release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_NAME = "Mistral-OCR.bobplugin";
const ARCHIVE = resolve(ROOT, "dist", ASSET_NAME);

const [tag, notesPath] = process.argv.slice(2);
const versionMatch = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? "");
if (!versionMatch || !notesPath) {
    console.error("Usage: node scripts/prepare-release.mjs vX.Y.Z <notes-output-path>");
    process.exit(2);
}
const version = versionMatch[1];

const info = JSON.parse(await readFile(resolve(ROOT, "info.json"), "utf8"));
const pending = JSON.parse(await readFile(resolve(ROOT, "release-pending.json"), "utf8"));

let archive;
try {
    archive = await readFile(ARCHIVE);
} catch (error) {
    console.error(`ERROR cannot read ${ARCHIVE}; run \`npm run build\` first (${error.message})`);
    process.exit(1);
}
const sha256 = createHash("sha256").update(archive).digest("hex");

validatePendingRelease(info, pending, archive);
const release = pending;
const expectedUrl = `${info.homepage}/releases/download/${tag}/${ASSET_NAME}`;
const errors = [];

if (info.version !== version) {
    errors.push(`info.json version ${JSON.stringify(info.version)} does not match tag ${tag}`);
}
if (!release) {
    errors.push("release-pending.json must describe the next release");
} else {
    if (release.version !== version) {
        errors.push(`pending release is ${JSON.stringify(release.version)}, not ${version}`);
    }
    if (release.sha256 !== sha256) {
        errors.push(`built ${ASSET_NAME} SHA-256 ${sha256} does not match release-pending.json (${release.sha256})`);
    }
    if (release.url !== expectedUrl) {
        errors.push(`pending url must equal ${expectedUrl}`);
    }
    if (typeof release.desc !== "string" || release.desc.trim().length === 0) {
        errors.push("appcast.json desc must be a non-empty string");
    }
}

if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR ${error}`);
    console.error(`Release preparation failed with ${errors.length} error(s).`);
    process.exit(1);
}

const bullets = release.desc.split(/[；;]/).map((item) => item.trim()).filter(Boolean);
const notes = [
    "## 更新内容",
    "",
    ...bullets.map((item) => `- ${item}`),
    "",
    "## 验证",
    "",
    `- 由 GitHub Actions 从标签 ${tag} 确定性构建，插件包与待发布元数据记录的 SHA-256 一致。`,
    `- SHA-256：\`${sha256}\``,
    ""
].join("\n");

await writeFile(notesPath, notes);
console.log(`Verified ${tag}: ${ASSET_NAME} SHA-256 ${sha256} matches release-pending.json; release notes written to ${notesPath}`);
