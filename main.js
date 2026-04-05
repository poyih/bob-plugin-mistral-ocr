var items = [
    ['auto', 'auto'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hant', 'zh-Hant'],
    ['en', 'en'],
    ['ja', 'ja'],
    ['ko', 'ko'],
    ['fr', 'fr'],
    ['de', 'de'],
    ['es', 'es'],
    ['it', 'it'],
    ['pt', 'pt'],
    ['ru', 'ru'],
    ['ar', 'ar'],
    ['nl', 'nl'],
    ['pl', 'pl'],
    ['th', 'th'],
    ['vi', 'vi'],
    ['tr', 'tr'],
];

var langMap = new Map(items);
var langMapReverse = new Map(items.map(([standardLang, lang]) => [lang, standardLang]));

function supportLanguages() {
    return items.map(([standardLang, lang]) => standardLang);
}

// 去除 Markdown 格式，转为纯文本
function stripMarkdown(text) {
    return text
        // 移除图片 ![alt](url)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        // 移除链接 [text](url) -> text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // 移除标题标记 ###
        .replace(/^#{1,6}\s+/gm, '')
        // 移除粗体/斜体 ***text*** **text** *text*
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        // 移除删除线 ~~text~~
        .replace(/~~([^~]+)~~/g, '$1')
        // 移除行内代码 `code`
        .replace(/`([^`]+)`/g, '$1')
        // 移除水平线 --- *** ___
        .replace(/^[\s]*([-*_]){3,}[\s]*$/gm, '')
        // 移除无序列表标记
        .replace(/^[\s]*[-*+]\s+/gm, '')
        // 移除有序列表标记
        .replace(/^[\s]*\d+\.\s+/gm, '')
        // 移除引用标记
        .replace(/^>\s+/gm, '')
        // 简化表格：移除分隔行，将 | 转为空格
        .replace(/^\|?[\s]*[-:]+[-|\s:]*\|?$/gm, '')
        .replace(/\|/g, ' ')
        // 清理多余空白
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function ocr(query, completion) {
    var apiKey = $option.apiKey;
    if (!apiKey) {
        completion({
            error: {
                type: "secretKey",
                message: "请先在插件设置中填写 Mistral AI API Key",
            },
        });
        return;
    }

    var apiUrl = ($option.apiUrl || "https://api.mistral.ai").replace(/\/+$/, '');
    var keepMarkdown = $option.keepMarkdown === "true";
    var base64Image = query.image.toBase64();

    $http.request({
        method: "POST",
        url: apiUrl + "/v1/ocr",
        header: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + apiKey,
        },
        body: {
            model: "mistral-ocr-latest",
            document: {
                type: "image_url",
                image_url: "data:image/png;base64," + base64Image,
            },
        },
        timeout: 30,
        handler: function (resp) {
            if (resp.error) {
                completion({
                    error: {
                        type: "network",
                        message: "网络请求失败: " + (resp.error.message || "未知错误"),
                        addition: JSON.stringify(resp.error),
                    },
                });
                return;
            }

            var statusCode = resp.response.statusCode;
            if (statusCode !== 200) {
                var errMsg = "请求失败，状态码: " + statusCode;
                var errType = "api";
                if (resp.data && resp.data.message) {
                    errMsg = resp.data.message;
                }
                if (statusCode === 401 || statusCode === 403) {
                    errType = "secretKey";
                    errMsg = "API Key 无效或已过期，请检查设置";
                } else if (statusCode === 429) {
                    errMsg = "请求过于频繁，请稍后再试";
                } else if (statusCode >= 500) {
                    errMsg = "Mistral 服务器错误，请稍后再试";
                }
                completion({
                    error: {
                        type: errType,
                        message: errMsg,
                        addition: JSON.stringify(resp.data),
                    },
                });
                return;
            }

            var data = resp.data;
            var texts = [];

            (data.pages || []).forEach(function (page) {
                if (!page.markdown || !page.markdown.trim()) return;

                var content = keepMarkdown ? page.markdown : stripMarkdown(page.markdown);
                var paragraphs = content
                    .split(/\n\n+/)
                    .map(function (p) { return p.trim(); })
                    .filter(function (p) { return p.length > 0; });

                paragraphs.forEach(function (p) {
                    texts.push({ text: p });
                });
            });

            if (texts.length === 0) {
                completion({
                    error: {
                        type: "api",
                        message: "未识别到任何文本",
                    },
                });
                return;
            }

            completion({
                result: {
                    from: query.detectFrom,
                    texts: texts,
                    raw: data,
                },
            });
        },
    });
}
