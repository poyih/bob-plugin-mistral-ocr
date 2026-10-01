// Opt-in macOS smoke test using Bob's documented scripting API.
// Run: osascript -l JavaScript scripts/smoke-bob.js tests/fixtures/ocr-sample.png
// Bob uses its existing OCR service settings; this script never reads API keys.
function run(argv) {
    if (argv.length !== 1) throw new Error("Pass the public OCR fixture path.");
    ObjC.import("Foundation");
    var data = $.NSData.dataWithContentsOfFile(argv[0]);
    if (data.isNil()) throw new Error("Cannot read the OCR fixture.");
    if (Number(data.length) > 20 * 1024 * 1024) throw new Error("Fixture exceeds the upload limit.");
    var encoded = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    var app = Application("com.hezongyidev.Bob");
    app.request(JSON.stringify({
        path: "ocr",
        body: { action: "ocrImage", imageBase64: encoded },
    }));
    return "OCR fixture submitted to Bob; verify the result in its OCR window.";
}
