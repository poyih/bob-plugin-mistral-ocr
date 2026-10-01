import assert from "node:assert/strict";
import test from "node:test";
import { downloadBuffer, HttpError } from "../scripts/lib/http.mjs";

test("download deadline covers a stalled body after headers arrive", async () => {
  let cancelled = false;
  let aborted = false;
  const fetchImpl = async (_url, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  };
  await assert.rejects(downloadBuffer("https://example.test", { fetchImpl, timeoutMs: 20 }), /timed out/);
  assert.equal(aborted, true);
  assert.equal(cancelled, true);
});

test("downloads reject oversized bodies even without Content-Length", async () => {
  const fetchImpl = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(10));
    controller.enqueue(new Uint8Array(10));
    controller.close();
  } }));
  await assert.rejects(downloadBuffer("https://example.test", { fetchImpl, maxBytes: 15 }), /exceeds/);
});

test("downloads return complete bytes and expose HTTP status without response secrets", async () => {
  const buffer = await downloadBuffer("https://example.test", { fetchImpl: async () => new Response("complete") });
  assert.equal(buffer.toString(), "complete");
  await assert.rejects(downloadBuffer("https://example.test", { fetchImpl: async () => new Response("private diagnostic", { status: 403 }) }),
    error => error instanceof HttpError && error.status === 403 && error.message === "HTTP 403");
});
