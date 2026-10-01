var items = [
    ['auto', 'auto'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hant', 'zh-Hant'],
    ['yue', 'yue'],
    ['wyw', 'wyw'],
    ['en', 'en'],
    ['ja', 'ja'],
    ['ko', 'ko'],
    ['fr', 'fr'],
    ['de', 'de'],
    ['es', 'es'],
    ['it', 'it'],
    ['pt', 'pt'],
    ['pt-br', 'pt-br'],
    ['pt-pt', 'pt-pt'],
    ['ru', 'ru'],
    ['ar', 'ar'],
    ['nl', 'nl'],
    ['pl', 'pl'],
    ['th', 'th'],
    ['vi', 'vi'],
    ['tr', 'tr'],
    ['id', 'id'],
    ['hi', 'hi'],
    ['he', 'he'],
    ['el', 'el'],
    ['uk', 'uk'],
    ['cs', 'cs'],
    ['sv', 'sv'],
    ['da', 'da'],
    ['fi', 'fi'],
    ['no', 'no'],
    ['ro', 'ro'],
    ['hu', 'hu'],
];

// Mistral OCR 控制台（用于 API Key 排障链接）
var MISTRAL_CONSOLE_URL = "https://console.mistral.ai/api-keys";

// 插件的上传上限；Base64 的额外体积不计入原始图片大小。
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var RETIRED_MODELS = ["mistral-ocr-2503", "mistral-ocr-2505"];

function resolveOcrModel(value) {
    var model = value || "mistral-ocr-latest";
    return RETIRED_MODELS.indexOf(model) === -1 ? model : "mistral-ocr-latest";
}

function supportLanguages() {
    return items.map(([standardLang, lang]) => standardLang);
}

// 延长 Bob 调用插件的等待时间，避免大图 / 多页文档在默认 60s 内未返回被中断
function pluginTimeoutInterval() {
    return 90;
}

// 从 base64 开头解码少量字节。避免完整解码大图，只用于检查魔术字节。
