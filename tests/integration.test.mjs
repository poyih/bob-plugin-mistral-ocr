import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { inflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_SOURCE = await readFile(resolve(ROOT, "main.js"), "utf8");
const PLUGIN_INFO = JSON.parse(await readFile(resolve(ROOT, "info.json"), "utf8"));
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function isoBmff(majorBrand, ...compatibleBrands) {
  const size = 16 + compatibleBrands.length * 4;
  const sizeBytes = Buffer.alloc(4);
  sizeBytes.writeUInt32BE(size);
  return Buffer.concat([
    sizeBytes,
    Buffer.from("ftyp"),
    Buffer.from(majorBrand),
    Buffer.alloc(4),
    ...compatibleBrands.map((brand) => Buffer.from(brand)),
  ]);
}

function loadPlugin(options = {}, requestImplementation) {
  const requests = [];
  const context = vm.createContext({
    $option: { apiKey: "test-api-key", ...options },
    $http: {
      request(request) {
        requests.push(request);
        return requestImplementation?.(request);
      },
    },
  });
  new vm.Script(PLUGIN_SOURCE, { filename: "main.js" }).runInContext(context);
  return { context, requests };
}

function queryWithImage(base64 = PNG_BASE64) {
  return {
    detectFrom: "en",
    image: {
      toBase64() {
        return base64;
      },
    },
  };
}

function invokeOcr(plugin, query = queryWithImage()) {
  const completions = [];
  plugin.context.ocr(query, (value) => completions.push(value));
  return completions;
}

function successResponse(markdown) {
  return {
    response: { statusCode: 200 },
    data: { pages: [{ markdown }] },
  };
}

function assertTypedError(completions, type, messagePattern) {
  assert.equal(completions.length, 1, "the public completion callback must run exactly once");
  assert.equal(completions[0]?.error?.type, type);
  assert.match(completions[0]?.error?.message || "", messagePattern);
}

function assertApiError(completions, messagePattern) {
  assertTypedError(completions, "api", messagePattern);
}

test("declares Bob-compatible language codes and avoids RegExp lookbehind", () => {
  const plugin = loadPlugin();
  const languages = Array.from(plugin.context.supportLanguages());
  assert.ok(languages.includes("pt-br"));
  assert.ok(languages.includes("pt-pt"));
  assert.ok(!languages.includes("pt-BR"));
  assert.ok(!languages.includes("pt-PT"));
  assert.equal(PLUGIN_SOURCE.includes("(?<="), false);
  assert.equal(PLUGIN_SOURCE.includes("(?<!"), false);
});

test("offers OCR 4.1 and forwards latest or pinned model IDs unchanged", () => {
  const modelOption = PLUGIN_INFO.options.find((option) => option.identifier === "model");
  assert.ok(modelOption, "info.json must declare the model option");
  assert.equal(modelOption.defaultValue, "mistral-ocr-latest");
  assert.deepEqual(
    modelOption.menuValues.map(({ value }) => value),
    ["mistral-ocr-latest", "mistral-ocr-4-1", "mistral-ocr-4-0", "mistral-ocr-2512"],
  );
  for (const { title, value } of modelOption.menuValues) {
    assert.ok(!title.includes("预览"), `${value} is generally available and must not be labelled as a preview`);
  }

  for (const model of ["mistral-ocr-latest", "mistral-ocr-4-1"]) {
    const plugin = loadPlugin({ model });
    invokeOcr(plugin);
    assert.equal(plugin.requests.length, 1);
    assert.equal(plugin.requests[0].body.model, model);
  }
});

test("rejects insecure remote API URLs before validation or OCR sends credentials", async (t) => {
  const cases = [
    ["http://api.example.test", /HTTPS/],
    ["http://localhost.evil.test", /HTTPS/],
    ["ftp://127.0.0.1", /HTTPS/],
  ];
  for (const [apiUrl, expectedMessage] of cases) {
    await t.test(apiUrl, () => {
      const validationPlugin = loadPlugin({ apiUrl });
      const validationCompletions = [];
      validationPlugin.context.pluginValidate((value) => validationCompletions.push(value));
      assert.equal(validationPlugin.requests.length, 0);
      assert.equal(validationCompletions.length, 1);
      assert.equal(validationCompletions[0]?.result, false);
      assert.equal(validationCompletions[0]?.error?.type, "param");
      assert.match(validationCompletions[0]?.error?.message || "", expectedMessage);

      const ocrPlugin = loadPlugin({ apiUrl });
      const ocrCompletions = invokeOcr(ocrPlugin);
      assert.equal(ocrPlugin.requests.length, 0);
      assertTypedError(ocrCompletions, "param", expectedMessage);
    });
  }
});

test("accepts HTTPS endpoints and explicit HTTP loopback endpoints", async (t) => {
  const cases = [
    ["https://proxy.example.test/gateway///", "https://proxy.example.test/gateway/v1/ocr"],
    ["http://localhost:8080/gateway/", "http://localhost:8080/gateway/v1/ocr"],
    ["http://127.0.0.42:8080", "http://127.0.0.42:8080/v1/ocr"],
    ["http://[::1]:8080", "http://[::1]:8080/v1/ocr"],
  ];

  for (const [apiUrl, expectedRequestUrl] of cases) {
    await t.test(apiUrl, () => {
      const plugin = loadPlugin({ apiUrl, keepMarkdown: "true" });
      const completions = invokeOcr(plugin);
      assert.equal(plugin.requests.length, 1);
      assert.equal(plugin.requests[0].url, expectedRequestUrl);
      assert.match(plugin.requests[0].body.document.image_url, /^data:image\/png;base64,/);
      plugin.requests[0].handler(successResponse("ok"));
      assert.equal(completions.length, 1);
      assert.equal(completions[0]?.result?.texts?.[0]?.text, "ok");
    });
  }
});

test("detects every supported image MIME type from magic bytes", async (t) => {
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  const cases = [
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"],
    ["PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["GIF", Buffer.from("GIF89a"), "image/gif"],
    ["WebP", webp, "image/webp"],
    ["BMP", Buffer.from([0x42, 0x4d]), "image/bmp"],
    ["TIFF", Buffer.from([0x49, 0x49, 0x2a, 0x00]), "image/tiff"],
    ["AVIF", isoBmff("avif"), "image/avif"],
    ["HEIC", isoBmff("heic"), "image/heic"],
    ["HEIX", isoBmff("heix"), "image/heic"],
    ["HEIM", isoBmff("heim"), "image/heic"],
    ["HEIS", isoBmff("heis"), "image/heic"],
    ["MIF1", isoBmff("mif1"), "image/heif"],
    ["brands outside ftyp are ignored", Buffer.concat([isoBmff("mif1"), Buffer.from("avis")]), "image/heif"],
    ["HEIC takes priority over HEIF", isoBmff("mif1", "heic"), "image/heic"],
    ["AVIF takes priority over HEIC", isoBmff("heic", "avif"), "image/avif"],
  ];

  for (const [name, bytes, expectedMime] of cases) {
    await t.test(name, () => {
      const plugin = loadPlugin({ keepMarkdown: "true" });
      const completions = invokeOcr(plugin, queryWithImage(bytes.toString("base64")));
      assert.equal(plugin.requests.length, 1);
      assert.match(plugin.requests[0].body.document.image_url, new RegExp(`^data:${expectedMime};base64,`));
      plugin.requests[0].handler(successResponse("ok"));
      assert.equal(completions.length, 1);
      assert.equal(completions[0]?.result?.texts?.[0]?.text, "ok");
    });
  }
});

test("rejects AVIF, HEIC, and HEIF sequence containers instead of mislabelling them as still images", async (t) => {
  const cases = [
    ["avis", isoBmff("avis")],
    ["avio", isoBmff("avio")],
    ["AVIF still and sequence brands", isoBmff("avif", "avis")],
    ["hevc", isoBmff("hevc")],
    ["hevx", isoBmff("hevx")],
    ["hevm", isoBmff("hevm")],
    ["hevs", isoBmff("hevs")],
    ["msf1", isoBmff("msf1")],
  ];
  for (const [name, bytes] of cases) {
    await t.test(name, () => {
      const plugin = loadPlugin();
      const completions = invokeOcr(plugin, queryWithImage(bytes.toString("base64")));
      assert.equal(plugin.requests.length, 0);
      assertTypedError(completions, "param", /不支持的图片格式/);
    });
  }
});

test("rejects unknown and empty image formats without making a request", async (t) => {
  const cases = [
    ["unknown bytes", Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("base64"), /不支持.*HEIC.*HEIF/],
    ["empty data", "", /图片数据为空/],
    ["invalid base64", "not base64!", /Base64.*无效/],
  ];

  for (const [name, base64, expectedMessage] of cases) {
    await t.test(name, () => {
      const plugin = loadPlugin();
      const completions = invokeOcr(plugin, queryWithImage(base64));
      assert.equal(plugin.requests.length, 0);
      assertTypedError(completions, "param", expectedMessage);
    });
  }
});

test("rejects whitespace and control characters in API keys before building headers", async (t) => {
  const cases = [
    ["embedded CRLF", "abc" + String.fromCharCode(13, 10) + "X-Test: injected"],
    ["embedded space", "abc def"],
    ["embedded tab", "abc" + String.fromCharCode(9) + "def"],
    ["embedded NUL", "abc" + String.fromCharCode(0) + "def"],
    ["embedded SOH", "abc" + String.fromCharCode(1) + "def"],
    ["embedded unit separator", "abc" + String.fromCharCode(31) + "def"],
    ["embedded C1 control", "abc" + String.fromCharCode(128) + "def"],
  ];

  for (const [name, apiKey] of cases) {
    await t.test(name, () => {
      const validationPlugin = loadPlugin({ apiKey });
      const validationCompletions = [];
      validationPlugin.context.pluginValidate((value) => validationCompletions.push(value));
      assert.equal(validationPlugin.requests.length, 0);
      assert.equal(validationCompletions.length, 1);
      assert.equal(validationCompletions[0]?.error?.type, "secretKey");
      assert.match(validationCompletions[0]?.error?.message || "", /格式无效/);

      const ocrPlugin = loadPlugin({ apiKey });
      const ocrCompletions = invokeOcr(ocrPlugin);
      assert.equal(ocrPlugin.requests.length, 0);
      assertTypedError(ocrCompletions, "secretKey", /格式无效/);
    });
  }
});

test("completes transport and synchronous request failures only once", async (t) => {
  await t.test("transport invokes its handler more than once", () => {
    const plugin = loadPlugin();
    const completions = invokeOcr(plugin);
    const response = { error: { message: "offline" } };
    assert.doesNotThrow(() => plugin.requests[0].handler(response));
    assert.doesNotThrow(() => plugin.requests[0].handler(response));
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.error?.type, "network");
  });

  await t.test("request throws synchronously", () => {
    const plugin = loadPlugin({}, () => {
      throw new Error("transport setup failed");
    });
    const completions = [];
    assert.doesNotThrow(() => {
      plugin.context.ocr(queryWithImage(), (value) => completions.push(value));
    });
    assert.equal(completions.length, 1);
    assert.ok(completions[0]?.error);
  });
});

test("redacts the configured API key from diagnostic additions", () => {
  const apiKey = ["runtime", "secret", "value", "only"].join("-");
  const plugin = loadPlugin({ apiKey });
  const completions = invokeOcr(plugin);
  plugin.requests[0].handler({
    error: {
      message: `transport failed for ${apiKey}`,
      authorization: `Bearer ${apiKey}`,
    },
  });

  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.error?.type, "network");
  assert.doesNotMatch(completions[0]?.error?.message || "", new RegExp(apiKey));
  assert.doesNotMatch(completions[0]?.error?.addition || "", new RegExp(apiKey));
  assert.match(completions[0]?.error?.addition || "", /\[REDACTED\]/);

  const httpPlugin = loadPlugin({ apiKey });
  const httpCompletions = invokeOcr(httpPlugin);
  httpPlugin.requests[0].handler({
    response: { statusCode: 400 },
    data: { message: `bad credential ${apiKey}`, detail: apiKey },
  });
  assert.equal(httpCompletions.length, 1);
  assert.doesNotMatch(httpCompletions[0]?.error?.message || "", new RegExp(apiKey));
  assert.doesNotMatch(httpCompletions[0]?.error?.addition || "", new RegExp(apiKey));
});

test("plugin validation rejects malformed HTTP 200 bodies and completes once", async (t) => {
  const cases = [
    ["HTML login page", "<html>login</html>"],
    ["object without model data array", {}],
    ["wrong model data type", { data: {} }],
  ];

  for (const [name, data] of cases) {
    await t.test(name, () => {
      const plugin = loadPlugin();
      const completions = [];
      plugin.context.pluginValidate((value) => completions.push(value));
      assert.equal(plugin.requests.length, 1);
      const response = { response: { statusCode: 200 }, data };
      assert.doesNotThrow(() => plugin.requests[0].handler(response));
      assert.doesNotThrow(() => plugin.requests[0].handler(response));
      assert.equal(completions.length, 1);
      assert.equal(completions[0]?.result, false);
      assert.equal(completions[0]?.error?.type, "api");
      assert.match(completions[0]?.error?.message || "", /验证响应格式无法解析/);
    });
  }
});

test("maps abnormal HTTP statuses to Bob network errors", async (t) => {
  for (const statusCode of [400, 408, 429, 500, 503]) {
    await t.test(String(statusCode), () => {
      const validationPlugin = loadPlugin();
      const validationCompletions = [];
      validationPlugin.context.pluginValidate((value) => validationCompletions.push(value));
      validationPlugin.requests[0].handler({ response: { statusCode }, data: {} });
      assert.equal(validationCompletions.length, 1);
      assert.equal(validationCompletions[0]?.error?.type, "network");

      const ocrPlugin = loadPlugin();
      const ocrCompletions = invokeOcr(ocrPlugin);
      ocrPlugin.requests[0].handler({ response: { statusCode }, data: {} });
      assertTypedError(ocrCompletions, "network", /请求失败|请求过于频繁|服务器错误/);
    });
  }
});

test("turns malformed success responses into one API error", async (t) => {
  const malformedResponses = [
    ["HTML body", { response: { statusCode: 200 }, data: "<html>login</html>" }],
    ["missing pages", { response: { statusCode: 200 }, data: {} }],
    ["missing response metadata", { data: { pages: [] } }],
    ["non-string markdown", { response: { statusCode: 200 }, data: { pages: [{ markdown: {} }] } }],
  ];

  for (const [name, response] of malformedResponses) {
    await t.test(name, () => {
      const plugin = loadPlugin();
      const completions = invokeOcr(plugin);
      assert.doesNotThrow(() => plugin.requests[0].handler(response));
      assert.doesNotThrow(() => plugin.requests[0].handler(response));
      assertApiError(completions, /响应格式无法解析/);
    });
  }
});

test("reports an error when Markdown conversion leaves no text", () => {
  const plugin = loadPlugin({ keepMarkdown: "false" });
  const completions = invokeOcr(plugin);
  plugin.requests[0].handler(successResponse("---\n![img-0.jpeg](img-0.jpeg)\n[tbl-3.html](tbl-3.html)"));
  assertTypedError(completions, "notFound", /未识别到任何文本/);
});

test("Markdown link cleanup remains linear for many unmatched brackets", () => {
  const plugin = loadPlugin();
  const input = "[".repeat(20_000);
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), input);
  assert.ok(Date.now() - startedAt < 1_000, "20k unmatched brackets should not trigger quadratic parsing");
});

test("escaped image and link syntax remains literal", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown("\\![literal](url)"), "![literal](url)");
  assert.equal(plugin.context.stripMarkdown("\\[literal](url)"), "[literal](url)");
});

test("Markdown links handle quoted titles, angle destinations, and nested destination parentheses", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown('[double](https://e.test "a ) title")'), "double");
  assert.equal(plugin.context.stripMarkdown("[single](https://e.test 'a ) title')"), "single");
  assert.equal(plugin.context.stripMarkdown('[angle](<https://e.test/a_(b)> "a ) title")'), "angle");
  assert.equal(plugin.context.stripMarkdown("[nested](https://e.test/a_(b))"), "nested");
  assert.equal(plugin.context.stripMarkdown('prose (a "b ) c")'), 'prose (a "b ) c")');
});

test("linked images reduce to alt text and generated placeholders require a matching target basename", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown("[![alt](image.png)](https://e.test)"), "alt");
  assert.equal(plugin.context.stripMarkdown("[![img-0.jpeg](img-0.jpeg)](https://e.test)"), "");
  assert.equal(plugin.context.stripMarkdown("![img-1.png](https://e.test/photo.png)"), "img-1.png");
  assert.equal(plugin.context.stripMarkdown("[tbl-1.html](https://e.test/report)"), "tbl-1.html");
  assert.equal(plugin.context.stripMarkdown("![different](https://e.test/img-2.png)"), "different");
  assert.equal(plugin.context.stripMarkdown("[different](https://e.test/tbl-2.html)"), "different");
});

test("protected inline code restoration remains linear for many spans", () => {
  const plugin = loadPlugin();
  const input = Array(5_000).fill("`x_i=a*b*c`").join(" ");
  const expected = Array(5_000).fill("x_i=a*b*c").join(" ");
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), expected);
  assert.ok(Date.now() - startedAt < 1_000, "5k protected spans should not trigger quadratic restoration");
});

test("protector prefix selection remains linear for adversarial private-use runs", () => {
  const plugin = loadPlugin();
  const input = "\ue000" + "\ue001".repeat(100_000);
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), input);
  assert.ok(Date.now() - startedAt < 1_000, "100KB sentinel-like input should not grow the prefix quadratically");
});

test("protector uses a short unused namespace and restores nested tokens exactly", () => {
  const plugin = loadPlugin();
  const occupiedNamespace = "\ue000" + "\ue100".repeat(7) + "\ue001";
  const sourceTokenStyle = occupiedNamespace + "0\ue002";
  const protector = plugin.context.createTextProtector("source " + sourceTokenStyle);
  const innerToken = protector.protect("x_i=a*b*c");
  const outerToken = protector.protect("before " + innerToken + " after");

  assert.equal(innerToken.startsWith(occupiedNamespace), false, "an occupied source namespace must be skipped");
  assert.equal(
    protector.restore(sourceTokenStyle + " | " + outerToken + " | " + innerToken),
    sourceTokenStyle + " | before x_i=a*b*c after | x_i=a*b*c",
  );
  assert.equal(plugin.context.stripMarkdown(sourceTokenStyle + " `x_i=a*b*c`"), sourceTokenStyle + " x_i=a*b*c");
});

test("short protector tokens remain linear for a long PUA run combined with many spans", () => {
  const plugin = loadPlugin();
  const privateUseRun = "\ue000" + "\ue001".repeat(20_000);
  const spans = Array(4_000).fill("`x`").join(" ");
  const expectedSpans = Array(4_000).fill("x").join(" ");
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(privateUseRun + " " + spans), privateUseRun + " " + expectedSpans);
  assert.ok(Date.now() - startedAt < 1_000, "protected spans must not copy a source-sized namespace into every token");
});

test("inline-code delimiter matching remains linear for decreasing unmatched runs", () => {
  let input = "a";
  for (let runLength = 800; runLength >= 1; runLength--) {
    input += "`".repeat(runLength);
    if (runLength > 1) input += "x";
  }

  const plugin = loadPlugin();
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), input);
  assert.ok(Date.now() - startedAt < 1_000, "~321KB unmatched backtick runs should stay linear");
  assert.equal(plugin.context.stripMarkdown("``a ` b``"), "a ` b");
});

test("single-line triple-backtick code spans are not mistaken for fences", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown("```inline```"), "inline");
  assert.equal(plugin.context.stripMarkdown("```js\nconst x_i = a*b*c;"), "const x_i = a*b*c;");
});

test("math delimiter matching remains linear and preserves escaped-dollar semantics", () => {
  const plugin = loadPlugin();
  const unmatched = "\\[\\(".repeat(75_000);
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(unmatched), "[(".repeat(75_000));
  assert.ok(Date.now() - startedAt < 1_000, "300KB unmatched math openers should stay linear");

  const formulas = "\\[x_i\\] \\(y_j\\) $$a*b$$ $c_d$ \\$literal$ $open\\$";
  assert.equal(plugin.context.stripMarkdown(formulas), formulas);

  const escapedCandidate = "$a \\$ *x* end$";
  assert.equal(plugin.context.stripMarkdown(escapedCandidate), escapedCandidate);

  const manyEscapedCandidates = "$a " + "\\$".repeat(100_000) + " *x* end$";
  const escapedStartedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(manyEscapedCandidates), manyEscapedCandidates);
  assert.ok(Date.now() - escapedStartedAt < 1_000, "escaped closing candidates should be skipped in one pass");
});

test("HTML tag scanning remains linear for a large malformed tag stream", () => {
  const plugin = loadPlugin();
  const input = "<span ".repeat(34_000);
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), input.trim());
  assert.ok(Date.now() - startedAt < 1_000, "200KB malformed HTML should not trigger quadratic scanning");
});

test("verbatim HTML pairing remains linear for a large mismatched tag sequence", () => {
  const plugin = loadPlugin();
  const input = "<pre>".repeat(20_000) + "</code>".repeat(20_000);
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), input);
  assert.ok(Date.now() - startedAt < 1_000, "mismatched pre/code tags should not rescan the opening stack");
});

test("HTML scanner respects quoted angle brackets and nested pre/code wrappers", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown('<span title="1 < 2 and 3 > 0">value</span>'), "value");
  assert.equal(
    plugin.context.stripMarkdown('<pre title="1 < 2 and 3 > 0">\n<code class="language-c">x_i=a*b*c</code>\n</pre>'),
    "x_i=a*b*c",
  );
  assert.equal(plugin.context.stripMarkdown("<typename T> 5 < x > 2 <header-file>"), "<typename T> 5 < x > 2 <header-file>");
});

test("Markdown table detection remains linear across repeated separators", () => {
  const plugin = loadPlugin();
  const input = "a|b\n---|---\n".repeat(10_000);
  const expected = Array(10_000).fill("a b").join("\n");
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), expected);
  assert.ok(Date.now() - startedAt < 1_000, "repeated table separators should not rescan the remaining rows");
});

test("malformed table-separator candidates remain linear", () => {
  const plugin = loadPlugin();
  const input = " ".repeat(160_000) + "x";
  const startedAt = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), "x");
  assert.ok(Date.now() - startedAt < 1_000, "long whitespace prefixes must not trigger separator backtracking");
});

test("standalone outer pipes stay literal while confirmed one-column tables are simplified", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown("|x|"), "|x|");
  assert.equal(plugin.context.stripMarkdown("| grep foo"), "| grep foo");
  assert.equal(plugin.context.stripMarkdown("value |"), "value |");
  assert.equal(plugin.context.stripMarkdown("---|---\n| grep foo"), "---|---\n| grep foo");
  assert.equal(plugin.context.stripMarkdown("| header |\n| --- |\n| value |"), "header\nvalue");
});

test("plain-text OCR removes formatting without corrupting code, math, or comparisons", () => {
  const markdown = [
    "# Heading",
    "A<br>B",
    "",
    "`x_i = a*b*c` and 2*3*4",
    "5 < x > 2",
    "\\*literal\\*",
    "![img-0.jpeg](img-0.jpeg)",
    "[tbl-3.html](tbl-3.html)",
    "```cpp",
    "template <typename T>",
    "int value_i = a*b*c;",
    "```",
    "$x_i * y_j$",
  ].join("\n");
  const plugin = loadPlugin({ keepMarkdown: "false" });
  const completions = invokeOcr(plugin);
  plugin.requests[0].handler(successResponse(markdown));

  assert.equal(completions.length, 1);
  assert.ok(completions[0]?.result);
  const text = completions[0].result.texts[0].text;
  assert.ok(text.includes("Heading"));
  assert.match(text, /A\n+B/);
  assert.ok(text.includes("x_i = a*b*c"));
  assert.ok(text.includes("2*3*4"));
  assert.ok(text.includes("5 < x > 2"));
  assert.ok(text.includes("*literal*"));
  assert.ok(text.includes("template <typename T>"));
  assert.ok(text.includes("int value_i = a*b*c;"));
  assert.ok(text.includes("$x_i * y_j$"));
  assert.doesNotMatch(text, /img-0\.jpeg|tbl-3\.html/);
});

test("plain-text OCR handles verbatim HTML, custom angle text, and pipe tables", () => {
  const markdown = [
    "<pre><code>x_i=a*b*c</code></pre>",
    "<span title=\"a > b\">quoted</span>",
    "<header-file>",
    "__init__",
    "a | b",
    "--- | ---",
    "c | d",
    "e | f",
    "",
    "| single |",
    "| --- |",
    "| value |",
  ].join("\n");
  const plugin = loadPlugin({ keepMarkdown: "false" });
  const completions = invokeOcr(plugin);
  plugin.requests[0].handler(successResponse(markdown));

  assert.equal(completions.length, 1);
  const text = completions[0]?.result?.texts?.[0]?.text || "";
  assert.ok(text.includes("x_i=a*b*c"));
  assert.doesNotMatch(text, /<\/?(?:pre|code)>/i);
  assert.ok(text.includes("quoted"));
  assert.doesNotMatch(text, /b\">/);
  assert.ok(text.includes("<header-file>"));
  assert.ok(text.includes("__init__"));
  assert.doesNotMatch(text, /\|/);
  assert.doesNotMatch(text, /^---$/m);
  for (const cell of ["a", "b", "c", "d", "e", "f", "single", "value"]) {
    assert.match(text, new RegExp(`(?:^|\\s)${cell}(?:$|\\s)`));
  }
});

test("plain-text OCR turns each newline group into exactly one blank line", () => {
  const plugin = loadPlugin({ keepMarkdown: "false" });
  const completions = invokeOcr(plugin);
  plugin.requests[0].handler(successResponse("alpha\nbeta\n\n\ngamma"));
  assert.equal(completions[0]?.result?.texts?.[0]?.text, "alpha\n\nbeta\n\ngamma");
});

test("Markdown OCR preserves the service response exactly", () => {
  const markdown = "# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x_i = a*b*c;\n```";
  const plugin = loadPlugin({ keepMarkdown: "true" });
  const completions = invokeOcr(plugin);
  plugin.requests[0].handler(successResponse(markdown));

  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.result?.from, "en");
  assert.equal(completions[0]?.result?.texts?.[0]?.text, markdown);
  assert.equal(completions[0]?.result?.raw?.pages?.[0]?.markdown, markdown);
});

test("plain text preserves backslashes in code and escaped HTML literals", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown('`C:\\`'), 'C:\\');
  assert.equal(plugin.context.stripMarkdown('`foo\\`bar`'), 'foo\\bar`');
  assert.equal(plugin.context.stripMarkdown('\\<br/> and \\<code>x\\</code>'), '<br/> and <code>x</code>');
  assert.equal(plugin.context.stripMarkdown('\\`literal`'), '`literal`');
});

test("plain text handles Chinese and nested emphasis while preserving multiplication", () => {
  const plugin = loadPlugin();
  for (const [input, expected] of [
    ['这是**重点**，请注意。', '这是重点，请注意。'],
    ['**中文**。', '中文。'],
    ['**a *b* c**', 'a b c'],
    ['这是*重点*。', '这是重点。'],
    ['***重要***', '重要'],
    ['2*3*4 and a*b*c', '2*3*4 and a*b*c'],
    ['\\*literal\\*', '*literal*'],
    ['* unmatched', 'unmatched'],
  ]) assert.equal(plugin.context.stripMarkdown(input), expected);
});

test("HTML entities decode after markup removal without changing code, math, or escaped entities", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown('<td>A &amp; B</td><td>x &lt; 5</td>'), 'A & B x < 5');
  assert.equal(plugin.context.stripMarkdown('&lt;br/&gt; &#20013;&#x6587; &eacute; &#x1f600; &unknown;'), '<br/> 中文 é 😀 &unknown;');
  assert.equal(plugin.context.stripMarkdown('`&amp;` $x &lt; y$ \\&amp;'), '&amp; $x &lt; y$ &amp;');
});

test("short table separator cells are recognized and wide tables stay linear", () => {
  const plugin = loadPlugin();
  assert.equal(plugin.context.stripMarkdown('| A | B |\n| :--: | :-: |\n| 1 | 2 |'), 'A B\n1 2');
  assert.equal(plugin.context.stripMarkdown('| A | B |\n| - |\n| 1 |'), '| A | B |\n| - |\n| 1 |');
  const row = '| ' + 'cell | '.repeat(16_000);
  const input = row + '\n| ' + '- | '.repeat(16_000) + '\n' + row;
  const start = Date.now();
  assert.equal(plugin.context.stripMarkdown(input), [Array(16_000).fill('cell').join(' '), Array(16_000).fill('cell').join(' ')].join('\n'));
  assert.ok(Date.now() - start < 1_000, 'wide tables must not repeatedly rescan the accumulated output');
});

test("OCR resolves independent tables in reading order and preserves the raw response", async (t) => {
  for (const keepMarkdown of ['false', 'true']) await t.test(keepMarkdown, () => {
    const plugin = loadPlugin({ keepMarkdown });
    const completions = invokeOcr(plugin);
    const markdown = 'Before\n\n[tbl-0.html](tbl-0.html)\n\nAfter';
    const table = '<table><tr><td>Alice</td><td>100</td></tr></table>';
    const data = { pages: [{ markdown, tables: [{ id: 'tbl-0.html', format: 'html', content: table }] }] };
    plugin.requests[0].handler({ response: { statusCode: 200 }, data });
    const result = completions[0].result;
    assert.match(result.texts[0].text, /Before[\s\S]*Alice[\s\S]*100[\s\S]*After/);
    assert.doesNotMatch(result.texts[0].text, /tbl-0/);
    assert.equal(result.raw.pages[0].markdown, markdown);
    if (keepMarkdown === 'true') assert.ok(result.texts[0].text.includes(table));
  });
});

test("table-only pages, Markdown tables, and literal placeholder references keep their content", () => {
  const plugin = loadPlugin();
  const completions = invokeOcr(plugin);
  plugin.requests[0].handler({ response: { statusCode: 200 }, data: { pages: [
    { markdown: '', tables: [{ id: 'tbl-0.md', content: '| Name |\n| - |\n| Alice |' }] },
    { markdown: '`[tbl-1.html](tbl-1.html)`\n\n[tbl-1.html](tbl-1.html)', tables: [{ id: 'tbl-1.html', content: '<td>Bob</td>' }] },
  ] } });
  assert.equal(completions[0].result.texts[0].text, 'Name\n\nAlice');
  assert.match(completions[0].result.texts[1].text, /\[tbl-1\.html\]\(tbl-1\.html\)[\s\S]*Bob/);
});

test("model validation checks exact IDs, aliases, and retired-model fallback", () => {
  for (const [model, models, expected] of [
    ['mistral-ocr-4-1', [{ id: 'mistral-ocr-4-1' }], true],
    ['mistral-ocr-latest', [{ id: 'ocr-backend', aliases: ['mistral-ocr-latest'] }], true],
    ['mistral-ocr-2503', [{ id: 'mistral-ocr-latest' }], true],
    ['mistral-ocr-4-1', [{ id: 'mistral-ocr-2512' }], false],
    ['mistral-ocr-latest', [], false],
  ]) {
    const plugin = loadPlugin({ model });
    const completions = [];
    plugin.context.pluginValidate(value => completions.push(value));
    plugin.requests[0].handler({ response: { statusCode: 200 }, data: { data: models } });
    assert.equal(completions.length, 1);
    assert.equal(completions[0].result, expected);
    if (!expected) assert.match(completions[0].error.message, /未提供所选 OCR 模型/);
  }
});

test("oversized images are rejected before encoding or making an HTTP request", () => {
  const plugin = loadPlugin();
  const completions = invokeOcr(plugin, { image: { length: 20 * 1024 * 1024 + 1, toBase64() { throw new Error('must not encode'); } } });
  assertTypedError(completions, 'param', /20 MiB/);
  assert.equal(plugin.requests.length, 0);
  assert.equal(plugin.context.base64ByteLength('iVBORw0KGgo='), 8);
  assert.equal(plugin.context.base64ByteLength('iVBORw0KGgo'), 8);
  assert.equal(plugin.context.base64ByteLength('iVBORw0KGgo=!'), null);
});

test("complete PNG and JPEG fixtures are submitted byte-for-byte with correct MIME types", async (t) => {
  for (const [name, mime] of [['ocr-sample.png', 'image/png'], ['ocr-sample.jpg', 'image/jpeg']]) await t.test(name, async () => {
    const bytes = await readFile(resolve(ROOT, 'tests/fixtures', name));
    assert.ok(bytes.length > 1000, 'fixture must be a complete image, not just magic bytes');
    if (name.endsWith('.png')) {
      assert.equal(bytes.readUInt32BE(16), 1000);
      assert.equal(bytes.readUInt32BE(20), 520);
      const chunks = [];
      let cursor = 8;
      while (cursor < bytes.length) {
        const length = bytes.readUInt32BE(cursor);
        const type = bytes.subarray(cursor + 4, cursor + 8).toString('ascii');
        if (type === 'IDAT') chunks.push(bytes.subarray(cursor + 8, cursor + 8 + length));
        cursor += 12 + length;
      }
      assert.equal(inflateSync(Buffer.concat(chunks)).length, 520 * (1000 * 3 + 1));
      assert.equal(bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii'), 'IEND');
    } else assert.equal(bytes.subarray(bytes.length - 2).toString('hex'), 'ffd9');
    const plugin = loadPlugin();
    const completions = invokeOcr(plugin, queryWithImage(bytes.toString('base64')));
    const prefix = `data:${mime};base64,`;
    assert.ok(plugin.requests[0].body.document.image_url.startsWith(prefix));
    assert.ok(Buffer.from(plugin.requests[0].body.document.image_url.slice(prefix.length), 'base64').equals(bytes));
    plugin.requests[0].handler(successResponse('**中文识别测试**。\n\nALICE 100\nBOB 200\n\n`C:\\`'));
    assert.equal(completions[0].result.texts[0].text, '中文识别测试。\n\nALICE 100\n\nBOB 200\n\nC:\\');
  });
});
