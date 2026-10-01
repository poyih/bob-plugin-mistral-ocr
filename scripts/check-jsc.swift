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
]
for (input, expected) in samples {
    let output = context.objectForKeyedSubscript("stripMarkdown")?.call(withArguments: [input])?.toString()
    guard output == expected else { fatalError("JavaScriptCore Markdown regression failed") }
}
let image = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/ocr-sample.png"))
let mime = context.objectForKeyedSubscript("detectMimeType")?.call(withArguments: [image.base64EncodedString()])?.toString()
guard mime == "image/png" else { fatalError("JavaScriptCore MIME regression failed") }
if let failure { fatalError("JavaScriptCore regression failed: \(failure)") }
print("JavaScriptCore smoke checks passed (6 text regressions and a complete PNG).")
