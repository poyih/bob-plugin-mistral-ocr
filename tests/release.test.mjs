import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../scripts/lib/http.mjs";
import { digest, ensurePublishedRelease, mergePublishedRelease, publishAppcast, releaseEntry, validatePendingRelease } from "../scripts/lib/release.mjs";

const archive = Buffer.from("deterministic plugin archive fixture");
const info = { identifier: "plugin", version: "2.0.0", minBobVersion: "1.8.0", homepage: "https://github.com/test/plugin" };
const pending = { ...info, desc: "Fix OCR content", sha256: digest(archive), timestamp: 1_790_776_800_000,
  url: "https://github.com/test/plugin/releases/download/v2.0.0/Mistral-OCR.bobplugin" };
const tag = "v2.0.0";

function fakeGitHub({ draft, badAsset = false, missingAsset = false, conflict = false } = {}) {
  const events = [];
  let release = draft === undefined ? null : { id: 1, tag_name: tag, draft, prerelease: false, upload_url: "https://uploads.github.com/repos/test/plugin/releases/1/assets{?name}" };
  let assets = release && !missingAsset ? [{ id: 2, name: "Mistral-OCR.bobplugin", state: "uploaded" }] : [];
  let appcast = { identifier: "plugin", versions: [{ ...releaseEntry(pending), version: "1.0.0", timestamp: pending.timestamp - 1000 }] };
  let assetBytes = badAsset ? Buffer.from("different archive") : archive;
  const api = {
    async request(method, path, body) {
      events.push(`${method} ${path}`);
      if (method === "GET" && path.startsWith("/releases/tags/")) {
        if (!release || release.draft) throw new HttpError(404);
        return { ...release };
      }
      if (method === "GET" && path.startsWith("/releases?")) return release ? [{ ...release }] : [];
      if (method === "POST" && path === "/releases") {
        assert.equal(body.draft, true);
        release = { ...body, id: 1, upload_url: "https://uploads.github.com/repos/test/plugin/releases/1/assets{?name}" };
        return { ...release };
      }
      if (method === "GET" && path === "/releases/1/assets") return assets;
      if (method === "PATCH" && path === "/releases/1") {
        assert.ok(events.includes("download draft asset"), "verify uploaded bytes before publishing");
        assert.equal(body.make_latest, "legacy", "retrying an older draft must not force it to become latest");
        release = { ...release, ...body };
        return { ...release };
      }
      if (method === "GET" && path.startsWith("/contents/appcast.json")) return { type: "file", encoding: "base64", sha: "current-sha", content: Buffer.from(JSON.stringify(appcast)).toString("base64") };
      if (method === "PUT" && path === "/contents/appcast.json") {
        assert.equal(release.draft, false);
        assert.ok(events.includes("download public asset"), "verify public download before changing the feed");
        if (conflict) { conflict = false; throw new HttpError(409); }
        appcast = JSON.parse(Buffer.from(body.content, "base64").toString());
        return {};
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    async upload(_url, bytes) {
      events.push("upload draft asset");
      assetBytes = bytes;
      assets = [{ id: 2, name: "Mistral-OCR.bobplugin", state: "uploaded" }];
    },
    async downloadAsset() { events.push("download draft asset"); return assetBytes; },
    async downloadPublic() { events.push("download public asset"); assert.equal(release.draft, false); return assetBytes; },
  };
  return { api, events, getAppcast: () => appcast };
}

test("release publishes verified draft bytes before advertising the update and safely reruns", async () => {
  const { api, events, getAppcast } = fakeGitHub();
  const options = { tag, commit: "commit", pending, archive, notes: "notes" };
  await ensurePublishedRelease(api, options);
  assert.equal(await publishAppcast(api, pending), true);
  assert.equal(getAppcast().versions[0].version, "2.0.0");
  await ensurePublishedRelease(api, options);
  assert.equal(await publishAppcast(api, pending), false);
  assert.equal(events.filter(event => event === "POST /releases").length, 1);
  assert.equal(events.filter(event => event === "upload draft asset").length, 1);
  assert.equal(events.filter(event => event === "PUT /contents/appcast.json").length, 1);
});

test("interrupted drafts resume without creating duplicate releases or replacing assets", async () => {
  const { api, events } = fakeGitHub({ draft: true });
  await ensurePublishedRelease(api, { tag, commit: "commit", pending, archive, notes: "notes" });
  assert.ok(events.some(event => event.startsWith("GET /releases?")));
  assert.ok(!events.includes("POST /releases"));
  assert.ok(!events.includes("upload draft asset"));
});

test("mismatched immutable assets and missing published assets stop before appcast writes", async () => {
  for (const options of [{ draft: false, badAsset: true }, { draft: false, missingAsset: true }, { draft: true, badAsset: true }]) {
    const { api, events } = fakeGitHub(options);
    await assert.rejects(ensurePublishedRelease(api, { tag, commit: "commit", pending, archive, notes: "notes" }), /differs|missing/);
    assert.ok(!events.some(event => event.startsWith("PATCH") || event.startsWith("PUT")));
    assert.ok(!events.includes("upload draft asset"));
  }
});

test("feed update retries optimistic concurrency conflicts", async () => {
  const { api, events } = fakeGitHub({ draft: false, conflict: true });
  assert.equal(await publishAppcast(api, pending), true);
  assert.equal(events.filter(event => event.startsWith("GET /contents/")).length, 2);
});

test("feed merging preserves newer releases and forbids rewriting published metadata", () => {
  const newer = { ...releaseEntry(pending), version: "3.0.0", timestamp: pending.timestamp + 1000 };
  const feed = { identifier: pending.identifier, versions: [newer] };
  const merged = mergePublishedRelease(feed, pending);
  assert.equal(merged.versions[0].version, "3.0.0");
  assert.equal(merged.versions[1].version, "2.0.0");
  assert.throws(() => mergePublishedRelease(merged, { ...pending, sha256: digest(Buffer.from("changed")) }), /immutable/);
  assert.throws(() => mergePublishedRelease({ ...feed, identifier: "another-plugin" }, pending), /identifier/);
  assert.throws(() => validatePendingRelease(info, { ...pending, version: "2.1.0" }, archive), /version/);
});
