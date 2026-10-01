function isEscaped(text, index) {
    var slashCount = 0;
    for (var i = index - 1; i >= 0 && text.charAt(i) === "\\"; i--) slashCount++;
    return slashCount % 2 === 1;
}

function createTextProtector(source) {
    var namespaceStart = "\ue000";
    var namespaceEnd = "\ue001";
    var tokenEnd = "\ue002";
    var namespaceDigitStart = 0xe100;
    var namespaceDigitCount = 7;
    var namespaceLength = namespaceDigitCount + 2;
    var occupiedNamespaces = Object.create(null);

    // 固定 9 个 PUA code unit 的 namespace 不会被后续 Markdown 规则改写。
    // 7 个 base-256 digit 提供 2^56 种候选，多于 JavaScript 字符串可拥有的起始位置。
    // 单遍收集原文已占用的候选，再选第一个空缺，避免把长原文 run 复制进每个 token。
    for (var sourceIndex = 0; sourceIndex + namespaceLength <= source.length; sourceIndex++) {
        if (source.charAt(sourceIndex) !== namespaceStart ||
            source.charAt(sourceIndex + namespaceLength - 1) !== namespaceEnd) {
            continue;
        }

        var isCandidate = true;
        for (var sourceDigit = 0; sourceDigit < namespaceDigitCount; sourceDigit++) {
            var sourceCode = source.charCodeAt(sourceIndex + sourceDigit + 1);
            if (sourceCode < namespaceDigitStart || sourceCode >= namespaceDigitStart + 256) {
                isCandidate = false;
                break;
            }
        }
        if (!isCandidate) continue;

        occupiedNamespaces[source.slice(sourceIndex, sourceIndex + namespaceLength)] = true;
        sourceIndex += namespaceLength - 1;
    }

    function namespaceForIndex(index) {
        var characters = [namespaceStart];
        var remaining = index;
        var digits = [];
        for (var digitIndex = 0; digitIndex < namespaceDigitCount; digitIndex++) {
            digits.push(String.fromCharCode(namespaceDigitStart + remaining % 256));
            remaining = Math.floor(remaining / 256);
        }
        for (var reverseIndex = digits.length - 1; reverseIndex >= 0; reverseIndex--) {
            characters.push(digits[reverseIndex]);
        }
        characters.push(namespaceEnd);
        return characters.join("");
    }

    var namespaceIndex = 0;
    var prefix = namespaceForIndex(namespaceIndex);
    while (occupiedNamespaces[prefix]) {
        namespaceIndex++;
        prefix = namespaceForIndex(namespaceIndex);
    }

    var values = [];
    return {
        protect: function (value) {
            var token = prefix + values.length + tokenEnd;
            values.push({ token: token, value: value });
            return token;
        },
        restore: function (text) {
            function replaceTokens(input, replacements) {
                var parts = [];
                var cursor = 0;

                while (cursor < input.length) {
                    var tokenStart = input.indexOf(prefix, cursor);
                    if (tokenStart === -1) break;

                    var tokenEndIndex = input.indexOf(tokenEnd, tokenStart + prefix.length);
                    if (tokenEndIndex === -1) break;

                    var indexText = input.slice(tokenStart + prefix.length, tokenEndIndex);
                    var valueIndex = /^\d+$/.test(indexText) ? Number(indexText) : -1;
                    var wholeToken = input.slice(tokenStart, tokenEndIndex + tokenEnd.length);
                    if (valueIndex < 0 || valueIndex >= replacements.length || values[valueIndex].token !== wholeToken) {
                        parts.push(input.slice(cursor, tokenStart + prefix.length));
                        cursor = tokenStart + prefix.length;
                        continue;
                    }

                    parts.push(input.slice(cursor, tokenStart));
                    parts.push(replacements[valueIndex]);
                    cursor = tokenEndIndex + tokenEnd.length;
                }

                parts.push(input.slice(cursor));
                return parts.join("");
            }

            // 后创建的保护片段可能包含更早的 token；先各自解析一次，再线性恢复正文。
            var resolvedValues = [];
            for (var i = 0; i < values.length; i++) {
                resolvedValues[i] = replaceTokens(values[i].value, resolvedValues);
            }
            return replaceTokens(text, resolvedValues);
        },
    };
}

function isClosingFence(line, markerCharacter, minimumLength) {
    var match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    return !!match && match[1].charAt(0) === markerCharacter && match[1].length >= minimumLength;
}

function protectFencedCode(text, protect, preserveMarkup) {
    var lines = text.split("\n");
    var output = [];
    var codeLines = [];
    var inFence = false;
    var markerCharacter = "";
    var markerLength = 0;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        if (!inFence) {
            var opening = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
            // CommonMark 禁止反引号 fence 的 info string 再含反引号；这种单行内容应交给 code span 解析。
            var invalidBacktickInfo = opening && opening[1].charAt(0) === "`" && opening[2].indexOf("`") !== -1;
            if (!opening || invalidBacktickInfo) {
                output.push(line);
                continue;
            }

            inFence = true;
            markerCharacter = opening[1].charAt(0);
            markerLength = opening[1].length;
            codeLines = preserveMarkup ? [line] : [];
            continue;
        }

        if (isClosingFence(line, markerCharacter, markerLength)) {
            if (preserveMarkup) codeLines.push(line);
            output.push(protect(codeLines.join("\n")));
            inFence = false;
            markerCharacter = "";
            markerLength = 0;
            codeLines = [];
        } else {
            codeLines.push(line);
        }
    }

    // Mistral 偶尔会截断末尾围栏；仍按代码保护剩余内容，避免二次清理破坏 OCR 结果。
    if (inFence) output.push(protect(codeLines.join("\n")));
    return output.join("\n");
}

function protectInlineCode(text, protect, preserveMarkup) {
    var runs = [];
    var precedingSlashes = 0;

    // 先单遍记录所有反引号 run；被反斜杠转义的首个反引号按字面量保留。
    for (var cursor = 0; cursor < text.length;) {
        var character = text.charAt(cursor);
        if (character !== "`") {
            precedingSlashes = character === "\\" ? precedingSlashes + 1 : 0;
            cursor++;
            continue;
        }

        var runLength = 1;
        while (text.charAt(cursor + runLength) === "`") runLength++;
        // 转义只影响正文中的 opener；代码内部的反斜杠不能转义 closing run。
        runs.push({ start: cursor, length: runLength, escaped: precedingSlashes % 2 === 1 });
        cursor += runLength;
        precedingSlashes = 0;
    }

    // 同长度 run 的下一项就是其最早合法闭合符，预配对后无需为每个 opener 重扫后文。
    var closingByOpening = [];
    var nextRunByLength = Object.create(null);
    for (var runIndex = runs.length - 1; runIndex >= 0; runIndex--) {
        var openingLength = runs[runIndex].length - (runs[runIndex].escaped ? 1 : 0);
        if (openingLength > 0) closingByOpening[runIndex] = nextRunByLength["r" + openingLength];
        nextRunByLength["r" + runs[runIndex].length] = runIndex;
    }

    var output = [];
    var outputCursor = 0;
    var currentRunIndex = 0;
    while (currentRunIndex < runs.length) {
        var closingRunIndex = closingByOpening[currentRunIndex];
        if (typeof closingRunIndex !== "number") {
            currentRunIndex++;
            continue;
        }

        var openingRun = runs[currentRunIndex];
        var closingRun = runs[closingRunIndex];
        var openingStart = openingRun.start + (openingRun.escaped ? 1 : 0);
        output.push(text.slice(outputCursor, openingStart));
        output.push(protect(preserveMarkup
            ? text.slice(openingStart, closingRun.start + closingRun.length)
            : text.slice(openingRun.start + openingRun.length, closingRun.start)));
        outputCursor = closingRun.start + closingRun.length;
        currentRunIndex = closingRunIndex + 1;
    }

    output.push(text.slice(outputCursor));
    return output.join("");
}

function protectMathDelimiter(text, opening, closing, protect) {
    var output = [];
    var outputCursor = 0;
    var searchFrom = 0;

    while (searchFrom < text.length) {
        var openingIndex = text.indexOf(opening, searchFrom);
        if (openingIndex === -1) break;

        var closingIndex = text.indexOf(closing, openingIndex + opening.length);
        if (closingIndex === -1) break;

        output.push(text.slice(outputCursor, openingIndex));
        output.push(protect(text.slice(openingIndex, closingIndex + closing.length)));
        outputCursor = closingIndex + closing.length;
        searchFrom = outputCursor;
    }

    output.push(text.slice(outputCursor));
    return output.join("");
}

function protectInlineDollarMath(text, protect) {
    var output = [];
    var outputCursor = 0;
    var openingIndex = -1;
    var precedingSlashes = 0;

    for (var index = 0; index < text.length; index++) {
        var character = text.charAt(index);
        var escaped = precedingSlashes % 2 === 1;

        if (character === "\n") {
            openingIndex = -1;
        } else if (character === "$" && !escaped) {
            if (openingIndex < 0) {
                openingIndex = index;
            } else if (index === openingIndex + 1) {
                // `$$` 不是非空行内公式；第二个 `$` 可作为下一候选 opener。
                openingIndex = index;
            } else {
                output.push(text.slice(outputCursor, openingIndex));
                output.push(protect(text.slice(openingIndex, index + 1)));
                outputCursor = index + 1;
                openingIndex = -1;
            }
        }

        // 转义 `$` 只作为公式内容跳过，不能让仍有效的 opener 丢失。
        if (character === "\\") {
            precedingSlashes++;
        } else {
            precedingSlashes = 0;
        }
    }

    output.push(text.slice(outputCursor));
    return output.join("");
}

function protectMath(text, protect) {
    text = protectMathDelimiter(text, "\\[", "\\]", protect);
    text = protectMathDelimiter(text, "\\(", "\\)", protect);
    text = protectMathDelimiter(text, "$$", "$$", protect);
    return protectInlineDollarMath(text, protect);
}

function isAsciiHtmlLetter(character) {
    var code = character.charCodeAt(0);
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiHtmlNameCharacter(character) {
    var code = character.charCodeAt(0);
    return isAsciiHtmlLetter(character) || (code >= 48 && code <= 57) || character === "-";
}

// 从指定的 `<` 开始解析一个单行 HTML 标签。失败时返回已扫描到的位置，避免再次回扫同一片段。
function parseHtmlTagAt(text, start) {
    var cursor = start + 1;
    var isClosing = false;

    if (text.charAt(cursor) === "/") {
        isClosing = true;
        cursor++;
    }

    if (!isAsciiHtmlLetter(text.charAt(cursor))) {
        return { tag: null, nextIndex: Math.min(start + 1, text.length) };
    }

    var nameStart = cursor;
    cursor++;
    while (cursor < text.length && isAsciiHtmlNameCharacter(text.charAt(cursor))) cursor++;
    var nameEnd = cursor;

    var boundary = text.charAt(cursor);
    if (boundary && boundary !== ">" && boundary !== "/" && boundary !== " " && boundary !== "\t") {
        if (boundary === "<" || boundary === "\n" || boundary === "\r") {
            return { tag: null, nextIndex: cursor };
        }
        return { tag: null, nextIndex: Math.min(cursor + 1, text.length) };
    }

    var quote = "";
    for (; cursor < text.length; cursor++) {
        var character = text.charAt(cursor);

        // OCR 中的标签应在单行闭合；遇到下一候选或换行即判定当前标签损坏。
        if (character === "\n" || character === "\r") {
            return { tag: null, nextIndex: cursor };
        }

        if (quote) {
            if (character === quote) quote = "";
            continue;
        }

        if (character === "<") return { tag: null, nextIndex: cursor };

        if (character === "\"" || character === "'") {
            quote = character;
            continue;
        }

        if (character === ">") {
            var beforeClose = cursor - 1;
            while (beforeClose > nameStart && (text.charAt(beforeClose) === " " || text.charAt(beforeClose) === "\t")) {
                beforeClose--;
            }
            return {
                tag: {
                    start: start,
                    end: cursor + 1,
                    name: text.slice(nameStart, nameEnd).toLowerCase(),
                    isClosing: isClosing,
                    isSelfClosing: text.charAt(beforeClose) === "/",
                },
                nextIndex: cursor + 1,
            };
        }
    }

    return { tag: null, nextIndex: text.length };
}

function scanHtmlTags(text, visitor) {
    var cursor = 0;
    while (cursor < text.length) {
        var tagStart = text.indexOf("<", cursor);
        if (tagStart === -1) return;
        if (isEscaped(text, tagStart)) {
            cursor = tagStart + 1;
            continue;
        }

        var parsed = parseHtmlTagAt(text, tagStart);
        if (parsed.tag) {
            visitor(parsed.tag);
            cursor = parsed.tag.end;
        } else {
            cursor = parsed.nextIndex > tagStart ? parsed.nextIndex : tagStart + 1;
        }
    }
}

function isHtmlWhitespaceOnly(text, start, end) {
    for (var i = start; i < end; i++) {
        var character = text.charAt(i);
        if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") return false;
    }
    return true;
}

function isVerbatimHtmlTag(name) {
    return name === "pre" || name === "code" || name === "math";
}

function protectHtmlVerbatim(text, protect, preserveMarkup) {
    var tags = [];
    scanHtmlTags(text, function (tag) {
        tags.push(tag);
    });

    var openingStack = [];
    var latestOpeningByName = { pre: -1, code: -1, math: -1 };
    var closingByOpening = [];
    for (var tagIndex = 0; tagIndex < tags.length; tagIndex++) {
        var tag = tags[tagIndex];
        if (!isVerbatimHtmlTag(tag.name)) continue;

        if (!tag.isClosing && !tag.isSelfClosing) {
            openingStack.push({
                tagIndex: tagIndex,
                name: tag.name,
                previousSameType: latestOpeningByName[tag.name],
            });
            latestOpeningByName[tag.name] = openingStack.length - 1;
            continue;
        }
        if (!tag.isClosing) continue;

        var matchingStackIndex = latestOpeningByName[tag.name];
        if (matchingStackIndex < 0) continue;

        var matchingOpeningIndex = openingStack[matchingStackIndex].tagIndex;
        closingByOpening[matchingOpeningIndex] = tagIndex;

        // 每个 opener 最多出栈一次；错配 closing 只做 O(1) 查询，整体保持线性。
        while (openingStack.length > matchingStackIndex) {
            var discardedOpening = openingStack.pop();
            latestOpeningByName[discardedOpening.name] = discardedOpening.previousSameType;
        }
    }

    var output = [];
    var outputCursor = 0;
    var currentTagIndex = 0;
    while (currentTagIndex < tags.length) {
        var closingIndex = closingByOpening[currentTagIndex];
        if (typeof closingIndex !== "number") {
            currentTagIndex++;
            continue;
        }

        var openingTag = tags[currentTagIndex];
        var closingTag = tags[closingIndex];
        var contentStart = openingTag.end;
        var contentEnd = closingTag.start;

        // 与既有行为一致：<pre><code>…</code></pre> 的两层外壳都不进入纯文本结果。
        if (openingTag.name === "pre" && currentTagIndex + 1 < closingIndex) {
            var codeOpeningIndex = currentTagIndex + 1;
            var codeOpeningTag = tags[codeOpeningIndex];
            var codeClosingIndex = closingByOpening[codeOpeningIndex];
            if (codeOpeningTag.name === "code" && !codeOpeningTag.isClosing &&
                typeof codeClosingIndex === "number" && codeClosingIndex < closingIndex &&
                isHtmlWhitespaceOnly(text, openingTag.end, codeOpeningTag.start) &&
                isHtmlWhitespaceOnly(text, tags[codeClosingIndex].end, closingTag.start)) {
                contentStart = codeOpeningTag.end;
                contentEnd = tags[codeClosingIndex].start;
            }
        }

        output.push(text.slice(outputCursor, openingTag.start));
        output.push(protect(preserveMarkup ? text.slice(openingTag.start, closingTag.end) : text.slice(contentStart, contentEnd)));
        outputCursor = closingTag.end;
        currentTagIndex = closingIndex + 1;
    }

    output.push(text.slice(outputCursor));
    return output.join("");
}

var HTML_CELL_TAGS = { td: true, th: true };
var HTML_BLOCK_TAGS = {
    p: true,
    div: true,
    section: true,
    article: true,
    header: true,
    footer: true,
    main: true,
    aside: true,
    nav: true,
    h1: true,
    h2: true,
    h3: true,
    h4: true,
    h5: true,
    h6: true,
    ul: true,
    ol: true,
    li: true,
    blockquote: true,
    table: true,
    thead: true,
    tbody: true,
    tfoot: true,
    caption: true,
};
var HTML_INLINE_TAGS = {
    span: true,
    strong: true,
    em: true,
    b: true,
    i: true,
    u: true,
    s: true,
    del: true,
    ins: true,
    mark: true,
    small: true,
    sub: true,
    sup: true,
    a: true,
};
var HTML_VOID_TAGS = { img: true, hr: true, input: true, meta: true, link: true };

function getKnownHtmlReplacement(tag) {
    if (!tag.isClosing && tag.name === "br") return "\n";
    if (HTML_CELL_TAGS[tag.name] === true) return "\t";
    if (tag.name === "tr") return "\n";
    if (HTML_BLOCK_TAGS[tag.name] === true) return "\n";
    if (HTML_INLINE_TAGS[tag.name] === true) return "";
    if (!tag.isClosing && HTML_VOID_TAGS[tag.name] === true) return "";
    return null;
}

function replaceKnownHtmlTags(text) {
    var output = [];
    var outputCursor = 0;
    scanHtmlTags(text, function (tag) {
        var replacement = getKnownHtmlReplacement(tag);
        if (replacement === null) return;
        output.push(text.slice(outputCursor, tag.start));
        output.push(replacement);
        outputCursor = tag.end;
    });
    output.push(text.slice(outputCursor));
    return output.join("");
}

function getLinkDestination(target) {
    target = target.replace(/^[ \t]+|[ \t]+$/g, "");
    if (target.charAt(0) === "<") {
        var angleEnd = target.indexOf(">");
        if (angleEnd !== -1) return target.slice(1, angleEnd);
    }

    var destination = "";
    for (var i = 0; i < target.length && !/\s/.test(target.charAt(i)); i++) {
        destination += target.charAt(i);
    }
    return destination;
}

function getAssetBasename(target) {
    var destination = getLinkDestination(target).replace(/\\([()])/g, "$1");
    destination = destination.split("#")[0].split("?")[0];
    var slashIndex = Math.max(destination.lastIndexOf("/"), destination.lastIndexOf("\\"));
    return destination.slice(slashIndex + 1).toLowerCase();
}

function isMistralImagePlaceholder(label, target) {
    var basename = getAssetBasename(target);
    var normalizedLabel = label.replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase();
    var generatedImage = /^(?:img|image)-\d+\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)$/i;
    return generatedImage.test(basename) && (!normalizedLabel || normalizedLabel === basename);
}

function isMistralTablePlaceholder(label, target) {
    var basename = getAssetBasename(target);
    var normalizedLabel = label.replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase();
    var generatedTable = /^(?:tbl|table)-\d+\.(?:html?|md)$/i;
    return generatedTable.test(basename) && (!normalizedLabel || normalizedLabel === basename);
}

function replaceMarkdownLinks(text, options) {
    options = options || {};
    // 先在线性时间内建立括号配对索引，避免大量未闭合 `[` 让逐候选扫描退化为 O(n²)。
    var squareMatches = [];
    var squareOpenings = [];
    var roundMatches = [];
    var squareStack = [];
    var escapedPositions = [];
    var precedingSlashes = 0;
    var linkTarget = null;

    for (var index = 0; index < text.length; index++) {
        var character = text.charAt(index);
        var escaped = precedingSlashes % 2 === 1;
        escapedPositions[index] = escaped;

        if (!escaped) {
            if (character === "[") {
                squareStack.push(index);
            } else if (character === "]" && squareStack.length > 0) {
                var squareOpening = squareStack.pop();
                squareMatches[squareOpening] = index;
                squareOpenings[index] = squareOpening;
            }

            if (linkTarget) {
                if (linkTarget.quote) {
                    if (character === linkTarget.quote) linkTarget.quote = "";
                } else if (linkTarget.angleDestination) {
                    if (character === ">") {
                        linkTarget.angleDestination = false;
                        linkTarget.sawDestination = true;
                    }
                } else if (character === " " || character === "\t" || character === "\n") {
                    if (linkTarget.depth === 1 && linkTarget.sawDestination) {
                        linkTarget.afterDestinationWhitespace = true;
                    }
                } else if (linkTarget.depth === 1 && !linkTarget.sawDestination && character === "<") {
                    linkTarget.angleDestination = true;
                } else if (linkTarget.depth === 1 &&
                    (character === "\"" || character === "'") &&
                    (!linkTarget.sawDestination || linkTarget.afterDestinationWhitespace)) {
                    linkTarget.quote = character;
                } else if (character === "(") {
                    linkTarget.depth++;
                    linkTarget.sawDestination = true;
                    linkTarget.afterDestinationWhitespace = false;
                } else if (character === ")") {
                    linkTarget.depth--;
                    if (linkTarget.depth === 0) {
                        roundMatches[linkTarget.start] = index;
                        linkTarget = null;
                    }
                } else {
                    linkTarget.sawDestination = true;
                    linkTarget.afterDestinationWhitespace = false;
                }
            } else if (character === "(" &&
                typeof squareOpenings[index - 1] === "number") {
                // 只对真正跟在配对 `]` 后的 Markdown target 启用引号/尖括号语义，
                // 普通正文中的括号仍按字面处理。target 内的每个字符最多访问一次。
                linkTarget = {
                    start: index,
                    depth: 1,
                    quote: "",
                    angleDestination: false,
                    sawDestination: false,
                    afterDestinationWhitespace: false,
                };
            }
        }

        precedingSlashes = character === "\\" ? precedingSlashes + 1 : 0;
    }

    var output = "";
    var lastIndex = 0;
    var cursor = 0;

    while (cursor < text.length) {
        if (text.charAt(cursor) === "!" && escapedPositions[cursor] && text.charAt(cursor + 1) === "[") {
            // \![alt](url) 是字面量而不是图片；跳过整个结构，避免下一轮把 `[` 当普通链接。
            var literalLabelEnd = squareMatches[cursor + 1];
            var literalTargetStart = literalLabelEnd + 1;
            var literalTargetEnd = typeof literalLabelEnd === "number" && text.charAt(literalTargetStart) === "("
                ? roundMatches[literalTargetStart]
                : undefined;
            cursor = typeof literalTargetEnd === "number" ? literalTargetEnd + 1 : cursor + 2;
            continue;
        }

        var isImage = text.charAt(cursor) === "!" && !escapedPositions[cursor] && text.charAt(cursor + 1) === "[";
        var bracketIndex = isImage ? cursor + 1 : cursor;
        if (text.charAt(bracketIndex) !== "[" || escapedPositions[bracketIndex]) {
            cursor++;
            continue;
        }

        var labelEnd = squareMatches[bracketIndex];
        var targetStart = labelEnd + 1;
        if (typeof labelEnd !== "number" || text.charAt(targetStart) !== "(") {
            cursor++;
            continue;
        }

        var targetEnd = roundMatches[targetStart];
        if (typeof targetEnd !== "number") {
            cursor++;
            continue;
        }

        var label = text.slice(bracketIndex + 1, labelEnd);
        var target = text.slice(targetStart + 1, targetEnd);
        var replacement;
        var table = !isImage && isMistralTablePlaceholder(label, target) && options.tables
            ? options.tables[getAssetBasename(target)] : null;
        if (table) {
            table.used = true;
            replacement = table.content;
        } else if (options.keepLinks) {
            replacement = text.slice(cursor, targetEnd + 1);
        } else if (isImage) {
            replacement = isMistralImagePlaceholder(label, target) ? "" : label;
        } else {
            // `[![alt](image.png)](url)` 的可见文本是内层图片的 alt；外层链接本身
            // 不应让图片 Markdown 残留。仅识别“恰好一层图片”的 label，避免递归解析。
            var imageMarker = bracketIndex + 1;
            var imageBracket = imageMarker + 1;
            var imageLabelEnd = text.charAt(imageMarker) === "!" && !escapedPositions[imageMarker] &&
                text.charAt(imageBracket) === "[" ? squareMatches[imageBracket] : undefined;
            var imageTargetStart = typeof imageLabelEnd === "number" ? imageLabelEnd + 1 : -1;
            var imageTargetEnd = imageTargetStart >= 0 && text.charAt(imageTargetStart) === "("
                ? roundMatches[imageTargetStart]
                : undefined;

            if (typeof imageTargetEnd === "number" && imageTargetEnd === labelEnd - 1) {
                var imageLabel = text.slice(imageBracket + 1, imageLabelEnd);
                var imageTarget = text.slice(imageTargetStart + 1, imageTargetEnd);
                replacement = isMistralImagePlaceholder(imageLabel, imageTarget) ? "" : imageLabel;
            } else {
                replacement = isMistralTablePlaceholder(label, target) ? "" : label;
            }
        }

        output += text.slice(lastIndex, cursor) + replacement;
        cursor = targetEnd + 1;
        lastIndex = cursor;
    }

    return output + text.slice(lastIndex);
}

function isMarkdownTableWhitespace(character) {
    var code = character.charCodeAt(0);
    return code === 9 || code === 11 || code === 12 || code === 32 || code === 160;
}

function isMarkdownTableSeparator(line) {
    var cursor = 0;
    while (cursor < line.length && isMarkdownTableWhitespace(line.charAt(cursor))) cursor++;
    if (line.charAt(cursor) === "|") cursor++;

    while (cursor < line.length) {
        while (cursor < line.length && isMarkdownTableWhitespace(line.charAt(cursor))) cursor++;
        if (line.charAt(cursor) === ":") cursor++;

        var dashStart = cursor;
        while (line.charAt(cursor) === "-") cursor++;
        if (cursor === dashStart) return false;
        if (line.charAt(cursor) === ":") cursor++;
        while (cursor < line.length && isMarkdownTableWhitespace(line.charAt(cursor))) cursor++;

        if (cursor === line.length) return true;
        if (line.charAt(cursor) !== "|") return false;
        cursor++;

        var afterPipe = cursor;
        while (cursor < line.length && isMarkdownTableWhitespace(line.charAt(cursor))) cursor++;
        if (cursor === line.length) return true;
        if (cursor === afterPipe && line.charAt(cursor) === "|") return false;
    }

    return false;
}

function simplifyMarkdownTables(text) {
    var lines = text.split("\n");
    var tableRows = [];
    var removedRows = [];

    function hasUnescapedPipe(line) {
        for (var pipeIndex = 0; pipeIndex < line.length; pipeIndex++) {
            if (line.charAt(pipeIndex) === "|" && !isEscaped(line, pipeIndex)) return true;
        }
        return false;
    }

    function cellCount(line) {
        line = line.replace(/^[ \t]+|[ \t]+$/g, "");
        var start = line.charAt(0) === "|" ? 1 : 0;
        var end = line.length;
        if (end > start && line.charAt(end - 1) === "|" && !isEscaped(line, end - 1)) end--;
        var count = 1;
        for (var index = start; index < end; index++) {
            if (line.charAt(index) === "|" && !isEscaped(line, index)) count++;
        }
        return count;
    }

    function simplifyTableRow(line) {
        line = line.replace(/^[ \t]+|[ \t]+$/g, "");
        if (line.charAt(0) === "|") line = line.slice(1);
        if (line.charAt(line.length - 1) === "|" && !isEscaped(line, line.length - 1)) line = line.slice(0, -1);

        var cells = [];
        var cellStart = 0;
        for (var characterIndex = 0; characterIndex < line.length; characterIndex++) {
            if (line.charAt(characterIndex) === "|" && !isEscaped(line, characterIndex)) {
                cells.push(line.slice(cellStart, characterIndex).replace(/^[ \t]+|[ \t]+$/g, ""));
                cellStart = characterIndex + 1;
            }
        }
        cells.push(line.slice(cellStart).replace(/^[ \t]+|[ \t]+$/g, ""));
        return cells.join("\t");
    }

    var insideTableBlock = false;
    for (var i = 0; i < lines.length; i++) {
        if (isMarkdownTableSeparator(lines[i])) {
            // 分隔行只有紧跟含未转义管道的表头时才有表格语义；孤立的 `---|---`
            // 及其后普通管道文本都必须原样保留。
            if (i > 0 && hasUnescapedPipe(lines[i - 1]) && cellCount(lines[i - 1]) === cellCount(lines[i])) {
                removedRows[i] = true;
                tableRows[i - 1] = true;
                insideTableBlock = true;
            } else {
                insideTableBlock = false;
            }
            continue;
        }

        if (!insideTableBlock) continue;
        if (lines[i].replace(/[ \t]/g, "") && hasUnescapedPipe(lines[i])) {
            tableRows[i] = true;
        } else {
            insideTableBlock = false;
        }
    }

    var output = [];
    for (var row = 0; row < lines.length; row++) {
        if (removedRows[row]) continue;
        if (tableRows[row]) {
            var trimmed = lines[row].replace(/^[ \t]+|[ \t]+$/g, "");
            lines[row] = simplifyTableRow(trimmed);
        }
        output.push(lines[row]);
    }

    return output.join("\n");
}

function isMarkdownPunctuation(character) {
    return !!character && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~\u2000-\u206f\u3001-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/.test(character);
}

// 单遍配对 asterisk run，支持中文及嵌套强调；保留 ASCII 标识符之间的乘号。
function stripEmphasis(text) {
    var openings = [];
    var removed = [];
    var precedingSlashes = 0;
    for (var cursor = 0; cursor < text.length;) {
        var character = text.charAt(cursor);
        if (character !== "*") {
            precedingSlashes = character === "\\" ? precedingSlashes + 1 : 0;
            cursor++;
            continue;
        }
        var length = 1;
        while (text.charAt(cursor + length) === "*") length++;
        var escaped = precedingSlashes % 2 === 1;
        var start = cursor + (escaped ? 1 : 0);
        var remaining = length - (escaped ? 1 : 0);
        var before = text.charAt(start - 1);
        var after = text.charAt(cursor + length);
        var beforeWhitespace = !before || /\s/.test(before);
        var afterWhitespace = !after || /\s/.test(after);
        var beforePunctuation = isMarkdownPunctuation(before);
        var afterPunctuation = isMarkdownPunctuation(after);
        var canOpen = !afterWhitespace && (!afterPunctuation || beforeWhitespace || beforePunctuation);
        var canClose = !beforeWhitespace && (!beforePunctuation || afterWhitespace || afterPunctuation);
        if (remaining === 1 && /[A-Za-z0-9_]/.test(before) && /[A-Za-z0-9_]/.test(after)) {
            canOpen = false;
            canClose = false;
        }
        var consumed = 0;
        while (canClose && remaining > 0 && openings.length > 0) {
            var opening = openings[openings.length - 1];
            var count = Math.min(opening.remaining, remaining);
            for (var offset = 0; offset < count; offset++) {
                removed[opening.start + opening.remaining - count + offset] = true;
                removed[start + consumed + offset] = true;
            }
            opening.remaining -= count;
            remaining -= count;
            consumed += count;
            if (opening.remaining === 0) openings.pop();
        }
        if (canOpen && remaining > 0) openings.push({ start: start + consumed, remaining: remaining });
        cursor += length;
        precedingSlashes = 0;
    }
    var output = [];
    var segmentStart = 0;
    for (var index = 0; index < text.length; index++) {
        if (!removed[index]) continue;
        output.push(text.slice(segmentStart, index));
        segmentStart = index + 1;
    }
    output.push(text.slice(segmentStart));
    return output.join("");
}

function decodeHtmlEntities(text) {
    return text.replace(/&(?:#([0-9]{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,31}));/gi, function (match, decimal, hexadecimal, name, index) {
        if (isEscaped(text, index)) return match;
        if (name) return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, name) ? HTML_ENTITIES[name] : match;
        var code = parseInt(decimal || hexadecimal, decimal ? 10 : 16);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
        if (code <= 0xffff) return String.fromCharCode(code);
        code -= 0x10000;
        return String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    });
}

// 先还原独立表格；代码片段和转义链接中的占位文本仍按原文保留。
function resolvePageTables(page) {
    if (!Array.isArray(page.tables) || page.tables.length === 0) return page.markdown;
    var tables = Object.create(null);
    var orderedTables = [];
    for (var index = 0; index < page.tables.length; index++) {
        var table = page.tables[index];
        if (!table || typeof table.id !== "string" || typeof table.content !== "string") {
            throw new Error("表格响应缺少 id 或 content");
        }
        var id = getAssetBasename(table.id);
        if (tables[id]) throw new Error("表格响应包含重复 id");
        tables[id] = { content: table.content, used: false };
        orderedTables.push(tables[id]);
    }
    var protector = createTextProtector(page.markdown);
    var markdown = protectFencedCode(page.markdown, protector.protect, true);
    markdown = protectHtmlVerbatim(markdown, protector.protect, true);
    markdown = protectInlineCode(markdown, protector.protect, true);
    markdown = protectMath(markdown, protector.protect);
    markdown = protector.restore(replaceMarkdownLinks(markdown, { keepLinks: true, tables: tables }));
    for (var tableIndex = 0; tableIndex < orderedTables.length; tableIndex++) {
        if (!orderedTables[tableIndex].used && orderedTables[tableIndex].content.trim()) {
            markdown += (markdown ? "\n\n" : "") + orderedTables[tableIndex].content;
        }
    }
    return markdown;
}

// 去除 Markdown 格式，转为纯文本。代码和公式先占位保护，避免清理规则破坏其内容。
function stripMarkdown(text) {
    if (typeof text !== "string") return "";

    text = text.replace(/\r\n?/g, "\n");
    var protector = createTextProtector(text);
    var protect = protector.protect;

    text = protectFencedCode(text, protect);
    text = protectHtmlVerbatim(text, protect);
    text = protectInlineCode(text, protect);
    text = protectMath(text, protect);
    text = replaceMarkdownLinks(text);
    text = replaceKnownHtmlTags(text);

    text = stripEmphasis(text)
        // 标题与强调。边界通过捕获组判断，不使用旧版 JavaScriptCore 不支持的 lookbehind。
        .replace(/^#{1,6}[ \t]+/gm, "")
        // 下划线也常见于代码标识符（如 __init__、x_i）；宁可保留格式符，也不删除 OCR 原文字符。
        .replace(/~~([^~\n]+)~~/g, "$1")
        // 水平线、列表和引用。
        .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
        .replace(/^[ \t]*[-*+][ \t]+/gm, "")
        .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
        .replace(/^[ \t]*>[ \t]?/gm, "");

    text = decodeHtmlEntities(simplifyMarkdownTables(text))
        // 表格处理完成后再恢复转义，避免把单元格里的 \| 误判成列分隔符。
        .replace(/\\([\\`*_[\]{}()#+.!<>|~\-&])/g, "$1")
        .replace(/[ \t]+/g, " ")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return protector.restore(text);
}
