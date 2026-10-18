import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { composePluginSource } from "../scripts/lib/plugin-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({});
new vm.Script(await composePluginSource(ROOT), { filename: "plugin-source.js" }).runInContext(context);

test("link and table trimming removes only boundary spaces and tabs", () => {
  assert.equal(context.stripMarkdown("before ![ \timg-0.png\t ]( \timg-0.png\t ) after"), "before after");
  assert.equal(context.stripMarkdown("before [ \ttbl-0.html\t ]( \ttbl-0.html\t ) after"), "before after");
  assert.equal(
    context.stripMarkdown("before ![\u00a0img-0.png\u00a0](img-0.png) after"),
    "before \u00a0img-0.png\u00a0 after",
  );
  assert.equal(context.stripMarkdown("before [\ntbl-0.html\n](tbl-0.html) after"), "before\ntbl-0.html\nafter");
  assert.equal(
    context.stripMarkdown("before\n| \tA\t | \u00a0B\u00a0 |\n| - | - |\n| \tC\t | D |\nafter"),
    "before\nA \u00a0B\u00a0\nC D\nafter",
  );
  assert.equal(context.getLinkDestination(" \t<https://example.test/a b>\t "), "https://example.test/a b");
});

test("table headers and cells with long internal spaces stay linear", () => {
  const padding = " \t".repeat(30_000);
  const input = `| a${padding}b | c${padding}d |\n| - | - |\n| e${padding}f | g${padding}h |`;
  const startedAt = performance.now();
  assert.equal(context.stripMarkdown(input), "a b c d\ne f g h");
  assert.ok(performance.now() - startedAt < 1_000, "internal whitespace must not trigger quadratic boundary trimming");
});

test("link labels and destinations with long internal spaces stay linear", () => {
  const padding = " \t".repeat(50_000);
  const input = `[a${padding}b](https://example.test/a${padding}b) ![c${padding}d](img-0.png)`;
  const startedAt = performance.now();
  assert.equal(context.stripMarkdown(input), "a b c d");
  assert.ok(performance.now() - startedAt < 1_000, "link trimming must not rescan each internal space");
});

test("strikethrough respects odd and even backslashes at either delimiter", () => {
  for (const [input, expected] of [
    [String.raw`\~~literal~~`, "~~literal~~"],
    [String.raw`~~literal\~~`, "~~literal~~"],
    [String.raw`\\~~deleted~~`, String.raw`\deleted`],
    [String.raw`~~deleted\\~~`, "deleted\\"],
    [String.raw`\\\~~literal~~`, String.raw`\~~literal~~`],
    [String.raw`~~literal\\\~~`, String.raw`~~literal\~~`],
    [String.raw`~~a\~b~~`, "a~b"],
    [String.raw`\~~~deleted~~`, "~deleted"],
    [String.raw`~~deleted\~~~`, "deleted~"],
    [String.raw`~~a\~~ b~~`, "~~a~~ b~~"],
  ]) assert.equal(context.stripMarkdown(input), expected, input);
});

test("strikethrough keeps existing nonempty, single-line, and tilde-run behavior", () => {
  for (const [input, expected] of [
    ["before ~~deleted~~ after", "before deleted after"],
    ["~~first~~ ~~second~~", "first second"],
    ["~~a~~~~b~~", "ab"],
    ["before ~~~deleted~~~ after", "before ~deleted~ after"],
    ["before ~~~~deleted~~~~ after", "before ~~deleted~~ after"],
    ["before ~~~~ after", "before ~~~~ after"],
    ["~~a~b~~", "~~a~b~~"],
    ["~~a\nb~~", "~~a\nb~~"],
    ["~~unclosed", "~~unclosed"],
    ["`~~literal~~` $~~formula~~$", "~~literal~~ $~~formula~~$"],
  ]) assert.equal(context.stripMarkdown(input), expected, input);
});

test("strikethrough handles many escaped and unmatched candidates in linear time", () => {
  const input = "before " + String.raw`\~~literal\~~ `.repeat(40_000) + "after";
  const expected = "before " + "~~literal~~ ".repeat(40_000) + "after";
  const startedAt = performance.now();
  assert.equal(context.stripMarkdown(input), expected);
  assert.ok(performance.now() - startedAt < 1_000, "escaped candidates must not rescan the remaining text");
});
