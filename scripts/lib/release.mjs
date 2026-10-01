import { createHash } from "node:crypto";
import { downloadBuffer, HttpError } from "./http.mjs";

export const ASSET_NAME = "Mistral-OCR.bobplugin";
export const RELEASE_FIELDS = ["version", "desc", "sha256", "url", "minBobVersion", "timestamp"];
export const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function releaseEntry(pending) {
  return Object.fromEntries(RELEASE_FIELDS.map((name) => [name, pending[name]]));
}

export function validatePendingRelease(info, pending, archive) {
  const errors = [];
  if (!pending || pending.identifier !== info.identifier) errors.push("pending identifier must match info.json");
  if (!/^\d+\.\d+\.\d+$/.test(pending?.version ?? "") || pending.version !== info.version) errors.push("pending version must match info.json");
  if (pending?.minBobVersion !== info.minBobVersion) errors.push("pending minBobVersion must match info.json");
  if (pending?.url !== `${info.homepage}/releases/download/v${info.version}/${ASSET_NAME}`) errors.push("pending download URL must match info.json");
  if (typeof pending?.desc !== "string" || !pending.desc.trim()) errors.push("pending description must be non-empty");
  if (!/^[a-f0-9]{64}$/.test(pending?.sha256 ?? "")) errors.push("pending SHA-256 must be a lowercase digest");
  if (!Number.isSafeInteger(pending?.timestamp) || pending.timestamp < 1e12 || pending.timestamp >= 1e13) errors.push("pending timestamp must contain 13 digits");
  if (archive && digest(archive) !== pending?.sha256) errors.push("built archive SHA-256 differs from release-pending.json; run npm run stage:release");
  if (errors.length) throw new Error(errors.join("; "));
}

export function mergePublishedRelease(appcast, pending) {
  if (appcast.identifier !== pending.identifier || !Array.isArray(appcast.versions)) throw new Error("Appcast identifier or versions is invalid");
  const entry = releaseEntry(pending);
  const existing = appcast.versions.find((release) => release.version === pending.version);
  if (existing) {
    if (!RELEASE_FIELDS.every((name) => existing[name] === entry[name])) throw new Error(`Published metadata for ${pending.version} is immutable`);
    return null;
  }
  const versions = [...appcast.versions, entry].sort((a, b) => compareVersions(b.version, a.version));
  for (let index = 1; index < versions.length; index++) {
    if (versions[index].timestamp > versions[index - 1].timestamp) throw new Error("Release timestamps must follow version order");
  }
  return { ...appcast, versions };
}

export function createGitHubApi(repository, token, { fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) throw new Error("GITHUB_REPOSITORY must identify owner/repository");
  if (!token) throw new Error("GH_TOKEN is required");
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "bob-plugin-mistral-ocr-release" };
  const authenticated = (url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["api.github.com", "uploads.github.com"].includes(parsed.hostname)) throw new Error("Untrusted GitHub API endpoint");
    return url;
  };
  return {
    async request(method, path, body) {
      const url = authenticated(path.startsWith("https://") ? path : `${base}${path}`);
      const bytes = await downloadBuffer(url, {
        fetchImpl, method, headers: { ...headers, Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return JSON.parse(bytes.toString("utf8"));
    },
    upload(url, archive) {
      return downloadBuffer(authenticated(url), { fetchImpl, method: "POST", timeoutMs: 90_000,
        headers: { ...headers, "Content-Type": "application/octet-stream" }, body: archive });
    },
    downloadAsset(id) {
      return downloadBuffer(`${base}/releases/assets/${id}`, { fetchImpl, headers: { ...headers, Accept: "application/octet-stream" } });
    },
    downloadPublic(url) {
      const expected = `https://github.com/${repository}/releases/download/`;
      if (!url.startsWith(expected)) throw new Error("Untrusted release download URL");
      return downloadBuffer(url, { fetchImpl });
    },
  };
}

export async function ensurePublishedRelease(api, { tag, commit, pending, archive, notes }) {
  if (tag !== `v${pending.version}`) throw new Error("Tag does not match the pending release");
  if (digest(archive) !== pending.sha256) throw new Error("Archive SHA-256 does not match pending release");
  let release;
  try { release = await api.request("GET", `/releases/tags/${tag}`); }
  catch (error) { if (error.status !== 404) throw error; }
  // The tag endpoint only finds published releases. Authenticated listing is
  // needed to resume a draft left behind by an interrupted upload.
  if (!release) {
    for (let page = 1; page <= 100; page++) {
      const candidates = await api.request("GET", `/releases?per_page=100&page=${page}`);
      const matching = candidates.filter((candidate) => candidate.tag_name === tag);
      if (matching.length > 1) throw new Error("Duplicate releases for this tag are forbidden");
      if (matching.length === 1) { release = matching[0]; break; }
      if (candidates.length < 100) break;
      if (page === 100) throw new Error("Release listing limit reached; refusing to create a duplicate");
    }
  }
  if (!release) {
    release = await api.request("POST", "/releases", {
      tag_name: tag, target_commitish: commit, name: `Mistral OCR ${tag}`, body: notes, draft: true, prerelease: false,
    });
  }
  if (release.prerelease) throw new Error("A prerelease cannot be advertised in the stable appcast");
  if (release.tag_name !== tag) throw new Error("GitHub returned a release for a different tag");
  let assets = (await api.request("GET", `/releases/${release.id}/assets`)).filter((asset) => asset.name === ASSET_NAME);
  if (assets.length > 1) throw new Error("Duplicate plugin assets are forbidden");
  if (!assets.length) {
    if (!release.draft) throw new Error("Published release is missing its immutable plugin asset");
    const url = `${release.upload_url.split("{")[0]}?name=${encodeURIComponent(ASSET_NAME)}`;
    await api.upload(url, archive);
    assets = (await api.request("GET", `/releases/${release.id}/assets`)).filter((asset) => asset.name === ASSET_NAME);
  }
  if (assets.length !== 1 || assets[0].state !== "uploaded") throw new Error("Plugin asset upload is incomplete");
  const uploaded = await api.downloadAsset(assets[0].id);
  if (digest(uploaded) !== pending.sha256) throw new Error("Existing release asset differs; refusing to overwrite it");
  if (release.draft) release = await api.request("PATCH", `/releases/${release.id}`, { draft: false, make_latest: "legacy" });
  if (release.draft) throw new Error("GitHub did not publish the verified draft");
  // The public URL must be usable before the appcast can mention this version.
  const published = await api.downloadPublic(pending.url);
  if (digest(published) !== pending.sha256) throw new Error("Public release asset SHA-256 mismatch");
  return release;
}

export async function publishAppcast(api, pending) {
  // Also verify the public asset on a retry that only updates the feed.
  if (digest(await api.downloadPublic(pending.url)) !== pending.sha256) throw new Error("Cannot advertise an unverified release asset");
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await api.request("GET", "/contents/appcast.json?ref=main");
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") throw new Error("GitHub did not return the appcast file");
    const appcast = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    const merged = mergePublishedRelease(appcast, pending);
    if (!merged) return false;
    try {
      await api.request("PUT", "/contents/appcast.json", {
        message: `Publish appcast for v${pending.version}`,
        content: Buffer.from(JSON.stringify(merged, null, 4) + "\n").toString("base64"), sha: file.sha, branch: "main",
      });
      return true;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409 || attempt === 2) throw error;
    }
  }
}
