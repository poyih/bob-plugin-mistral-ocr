import Foundation
import JavaScriptCore

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let source = try String(contentsOf: root.appendingPathComponent("main.js"), encoding: .utf8)
let context = JSContext()!
var failure: String?
context.exceptionHandler = { _, exception in failure = exception?.toString() ?? "JavaScriptCore error" }
context.evaluateScript(source)
if let failure { fatalError("Cannot load plugin in JavaScriptCore: \(failure)") }
let samples = [
    ("`C:\\`", "C:\\"),
    ("\\<br/>", "<br/>"),
    ("这是**重点**，请注意。", "这是重点，请注意。"),
    ("**a *b* c**", "a b c"),
    ("&lt;br/&gt; &#20013;&#x6587;", "<br/> 中文"),
    ("| A | B |\n| :--: | :-: |\n| 1 | 2 |", "A B\n1 2"),
    ("\\~~literal~~", "~~literal~~"),
    ("~~literal\\~~", "~~literal~~"),
    ("~~removed~~", "removed"),
    ("1. 第一题\n2. 第二题", "1. 第一题\n2. 第二题"),
    ("**注意：**请按时提交", "注意：请按时提交"),
    ("| 金额<br>（元） | 数量 |\n| --- | --- |\n| 1 | 2 |", "金额 （元） 数量\n1 2"),
]
for (input, expected) in samples {
    let output = context.objectForKeyedSubscript("stripMarkdown")?.call(withArguments: [input])?.toString()
    guard output == expected else { fatalError("JavaScriptCore Markdown regression failed") }
}
let paddedTable = "a|" + String(repeating: " ", count: 40_000) + "x\n---|---"
let startedAt = Date()
let tableOutput = context.objectForKeyedSubscript("stripMarkdown")?.call(withArguments: [paddedTable])?.toString()
let tableDuration = Date().timeIntervalSince(startedAt)
guard tableOutput == "a x" else { fatalError("JavaScriptCore padded-table regression failed") }
guard tableDuration < 2 else { fatalError("JavaScriptCore padded-table processing exceeded 2 seconds") }
let image = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/ocr-sample.png"))
let mime = context.objectForKeyedSubscript("detectMimeType")?.call(withArguments: [image.base64EncodedString()])?.toString()
guard mime == "image/png" else { fatalError("JavaScriptCore MIME regression failed") }
// The final compatible brand starts beyond the old 64-byte scan limit.
var longFtyp = Data([0, 0, 0, 68])
longFtyp.append(Data("ftypmif1".utf8))
longFtyp.append(Data(repeating: 0, count: 4))
longFtyp.append(Data(String(repeating: "zzzz", count: 12).utf8))
longFtyp.append(Data("avif".utf8))
let avifMime = context.objectForKeyedSubscript("detectMimeType")?.call(withArguments: [longFtyp.base64EncodedString()])?.toString()
guard avifMime == "image/avif" else { fatalError("JavaScriptCore long-ftyp AVIF regression failed") }
longFtyp.replaceSubrange(64..<68, with: Data("avis".utf8))
let sequenceMime = context.objectForKeyedSubscript("detectMimeType")?.call(withArguments: [longFtyp.base64EncodedString()])
guard sequenceMime?.isNull == true else { fatalError("JavaScriptCore long-ftyp sequence regression failed") }
if let failure { fatalError("JavaScriptCore regression failed: \(failure)") }
print("JavaScriptCore checks passed (\(samples.count) text regressions, a complete PNG, and 2 long-ftyp regressions; padded table: \(Int(tableDuration * 1000)) ms).")
