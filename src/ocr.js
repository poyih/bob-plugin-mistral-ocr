function ocr(query, completion) {
    var done = completeOnce(completion);

    try {
        var validatedKey = validateApiKey($option.apiKey);
        if (!validatedKey.valid) {
            done({
                error: {
                    type: "secretKey",
                    message: validatedKey.empty ? "请先在插件设置中填写 Mistral AI API Key" : validatedKey.message,
                    troubleshootingLink: MISTRAL_CONSOLE_URL,
                },
            });
            return;
        }
        var apiKey = validatedKey.value;

        var validatedUrl = validateApiBaseUrl($option.apiUrl);
        if (!validatedUrl.valid) {
            done({ error: { type: "param", message: validatedUrl.message } });
            return;
        }

        var keepMarkdown = $option.keepMarkdown === "true";
        var model = resolveOcrModel($option.model);

        if (!query || !query.image || typeof query.image.toBase64 !== "function") {
            done({ error: { type: "param", message: "无法读取待识别图片" } });
            return;
        }

        var base64Image;
        if (typeof query.image.length === "number" && query.image.length > MAX_IMAGE_BYTES) {
            done({ error: { type: "param", message: "图片超过插件的 20 MiB 上传上限，请压缩后重试" } });
            return;
        }
        try {
            base64Image = query.image.toBase64();
        } catch (error) {
            done({ error: { type: "param", message: "无法读取待识别图片: " + getErrorMessage(error, [apiKey]) } });
            return;
        }

        if (typeof base64Image !== "string" || !/\S/.test(base64Image)) {
            done({ error: { type: "param", message: "不支持的图片格式：待识别图片数据为空" } });
            return;
        }

        var imageBytes = base64ByteLength(base64Image);
        if (imageBytes === null) {
            done({ error: { type: "param", message: "不支持的图片格式：图片 Base64 数据无效" } });
            return;
        }
        if (imageBytes > MAX_IMAGE_BYTES) {
            done({ error: { type: "param", message: "图片超过插件的 20 MiB 上传上限，请压缩后重试" } });
            return;
        }

        var mimeType = detectMimeType(base64Image);
        if (!mimeType) {
            done({
                error: {
                    type: "param",
                    message: "不支持的图片格式；请使用 JPEG、PNG、GIF、WebP、BMP、TIFF、AVIF、HEIC 或 HEIF",
                },
            });
            return;
        }

        $http.request({
            method: "POST",
            url: validatedUrl.url + "/v1/ocr",
            header: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + apiKey,
            },
            body: {
                model: model,
                document: {
                    type: "image_url",
                    image_url: "data:" + mimeType + ";base64," + base64Image,
                },
            },
            timeout: 85,
            handler: function (resp) {
                try {
                    if (!resp || resp.error) {
                        done({
                            error: {
                                type: "network",
                                message: "网络请求失败: " + getErrorMessage(resp && resp.error, [apiKey]),
                                addition: safeStringify(resp && resp.error, [apiKey]),
                            },
                        });
                        return;
                    }

                    if (!resp.response || typeof resp.response.statusCode !== "number") {
                        done({ error: { type: "api", message: "响应格式无法解析" } });
                        return;
                    }

                    var statusCode = resp.response.statusCode;
                    if (statusCode !== 200) {
                        var errMsg = "请求失败，状态码: " + statusCode;
                        var errType = "network";
                        if (resp.data && typeof resp.data.message === "string" && resp.data.message) {
                            errMsg = redactSensitiveText(resp.data.message, [apiKey]);
                        }
                        var troubleshootingLink;
                        if (statusCode === 401 || statusCode === 403) {
                            errType = "secretKey";
                            errMsg = "API Key 无效或已过期，请检查设置";
                            troubleshootingLink = MISTRAL_CONSOLE_URL;
                        } else if (statusCode === 429) {
                            errMsg = "请求过于频繁，请稍后再试";
                        } else if (statusCode >= 500) {
                            errMsg = "Mistral 服务器错误，请稍后再试";
                        }
                        done({
                            error: {
                                type: errType,
                                message: errMsg,
                                troubleshootingLink: troubleshootingLink,
                                addition: safeStringify(resp.data, [apiKey]),
                            },
                        });
                        return;
                    }

                    var data = resp.data;
                    if (!data || !Array.isArray(data.pages)) {
                        done({
                            error: {
                                type: "api",
                                message: "响应格式无法解析",
                                addition: safeStringify(data, [apiKey]),
                            },
                        });
                        return;
                    }

                    var texts = [];
                    for (var pageIndex = 0; pageIndex < data.pages.length; pageIndex++) {
                        var page = data.pages[pageIndex];
                        if (!page || typeof page.markdown !== "string") {
                            done({
                                error: {
                                    type: "api",
                                    message: "响应格式无法解析：第 " + (pageIndex + 1) + " 页缺少文本",
                                    addition: safeStringify(page, [apiKey]),
                                },
                            });
                            return;
                        }
                        var markdown = resolvePageTables(page);
                        if (!markdown.trim()) continue;
                        var content = keepMarkdown ? markdown : stripMarkdown(markdown);
                        // Bob 的 OCR 结果以空行触发段落换行；纯文本模式保持已发布行为，将每组换行规范为双换行。
                        if (!keepMarkdown) content = content.replace(/\n+/g, "\n\n");
                        if (!content.trim()) continue;
                        texts.push({ text: content });
                    }

                    if (texts.length === 0) {
                        done({ error: { type: "notFound", message: "未识别到任何文本" } });
                        return;
                    }

                    done({
                        result: {
                            from: query.detectFrom,
                            texts: texts,
                            raw: data,
                        },
                    });
                } catch (error) {
                    done({
                        error: { type: "api", message: "处理 OCR 响应失败: " + getErrorMessage(error, [apiKey]) },
                    });
                }
            },
        });
    } catch (error) {
        done({ error: { type: "network", message: "无法发起 OCR 请求: " + getErrorMessage(error, [apiKey]) } });
    }
}
