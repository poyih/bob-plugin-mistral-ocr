// Opt-in live API smoke test using only the public test fixture. No key, image
// bytes, response body, or raw request diagnostics are written to the terminal.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fetchBuffer } from "./lib/http.mjs";

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) throw new Error("Set MISTRAL_API_KEY in the environment to run the live OCR smoke test.");
const image = await readFile(new URL("../tests/fixtures/ocr-sample.png", import.meta.url));
const source = await readFile(new URL("../main.js", import.meta.url), "utf8");
const context = vm.createContext({
  $option: { apiKey, apiUrl: process.env.MISTRAL_API_URL || "", model: process.env.MISTRAL_OCR_MODEL || "mistral-ocr-latest" },
  $http: { request(request) {
    fetchBuffer(request.url, { method: request.method, headers: request.header, body: request.body ? JSON.stringify(request.body) : undefined,
      timeoutMs: request.timeout * 1000, maxBytes: 10 * 1024 * 1024 })
      .then(({ response, buffer }) => request.handler({ response: { statusCode: response.status }, data: JSON.parse(buffer.toString()) }))
      .catch(() => request.handler({ error: { message: "Live HTTP request failed" } }));
  } },
});
new vm.Script(source).runInContext(context);
const result = await new Promise(resolve => context.ocr({ detectFrom: "en", image: { length: image.length, toBase64: () => image.toString("base64") } }, resolve));
if (!result.result) throw new Error(`Live OCR smoke test failed (${result.error?.type ?? "unknown"}); check Bob or your API configuration.`);
const text = result.result.texts.map(({ text }) => text).join("\n");
for (const expected of ["OCR", "ALICE", "100", "BOB", "200"]) if (!text.includes(expected)) throw new Error(`Expected fixture text was not recognized: ${expected}`);
console.log(`Live OCR smoke test passed (${result.result.texts.length} page(s), ${text.length} characters).`);
