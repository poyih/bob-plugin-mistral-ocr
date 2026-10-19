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

test("ordered-list numbers are visible text and stay in plain text", () => {
  for (const [input, expected] of [
    ["1. 下列说法正确的是\n2. 第二题", "1. 下列说法正确的是\n2. 第二题"],
    ["## 2. Methods\n\n2.1 Data", "2. Methods\n\n2.1 Data"],
    ["3) 选项 A", "3) 选项 A"],
    ["2026. 10. 19 会议纪要", "2026. 10. 19 会议纪要"],
    ["**1.** 总则", "1. 总则"],
    ["  10. indented", "10. indented"],
    ["- 无序项\n* 另一项", "无序项\n另一项"],
  ]) assert.equal(context.stripMarkdown(input), expected, input);
});

test("double asterisks next to CJK punctuation are removed while single asterisks stay conservative", () => {
  for (const [input, expected] of [
    ["**注意：**请按时提交", "注意：请按时提交"],
    ["请看**“重点”**部分", "请看“重点”部分"],
    ["**（一）**基本情况", "（一）基本情况"],
    ["**注意…**请", "注意…请"],
    ["**한국어：**설명", "한국어：설명"],
    ["\u{20bb7}**“野”**家", "\u{20bb7}“野”家"],
    ["**Note:** be careful", "Note: be careful"],
    ["a**“b”**c", "a**“b”**c"],
    ["姓名*：张三 电话*：123", "姓名*：张三 电话*：123"],
    ["价格*：100元，数量*：5", "价格*：100元，数量*：5"],
  ]) assert.equal(context.stripMarkdown(input), expected, input);
});

test("line breaks inside table cells keep each row on one line", () => {
  for (const [input, expected] of [
    ["| Name<br>(EN) | Amount |\n| --- | --- |\n| ALICE | 100 |", "Name (EN) Amount\nALICE 100"],
    ["| Name | Amount |\n| --- | --- |\n| A<br/>B | 100 |", "Name Amount\nA B 100"],
    ["| 金额<br />（元） | 数量 |\n| --- | --- |\n| 1 | 2 |", "金额 （元） 数量\n1 2"],
    ["<table><tr><th>Name<br>(EN)</th><th>B</th></tr><tr><td>1<br>2</td><td>3</td></tr></table>", "Name (EN) B\n\n1 2 3"],
    ["A<br>B\n| x | y |", "A\nB\n| x | y |"],
    ["`a<br>b` | c |\n| - | - |", "a<br>b c"],
  ]) assert.equal(context.stripMarkdown(input), expected, input);
});

test("table cell line breaks stay linear across many rows", () => {
  const input = "| a<br>b | c |\n| - | - |\n" + "| x<br>y | z |\n".repeat(20_000);
  const expected = "a b c\n" + Array(20_000).fill("x y z").join("\n");
  const startedAt = performance.now();
  assert.equal(context.stripMarkdown(input), expected);
  assert.ok(performance.now() - startedAt < 1_000, "cell line breaks must not rescan the table for each row");
});
