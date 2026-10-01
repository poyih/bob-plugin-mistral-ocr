function completeOnce(completion) {
    var completed = false;
    return function (value) {
        if (completed) return;
        completed = true;
        completion(value);
    };
}

function redactSensitiveText(value, sensitiveValues) {
    var text = typeof value === "string" ? value : String(value);
    for (var i = 0; Array.isArray(sensitiveValues) && i < sensitiveValues.length; i++) {
        var sensitiveValue = sensitiveValues[i];
        if (typeof sensitiveValue === "string" && sensitiveValue) {
            text = text.split(sensitiveValue).join("[REDACTED]");
        }
    }
    return text;
}

function safeStringify(value, sensitiveValues) {
    var serialized;
    try {
        serialized = JSON.stringify(value);
    } catch (error) {
        return "无法序列化附加信息";
    }

    return redactSensitiveText(serialized, sensitiveValues);
}

function getErrorMessage(error, sensitiveValues) {
    var message = error && typeof error.message === "string" && error.message ? error.message : "未知错误";
    return redactSensitiveText(message, sensitiveValues);
}

function validateApiKey(value) {
    var apiKey = value == null ? "" : String(value).replace(/^\s+|\s+$/g, "");
    if (!apiKey) return { valid: false, empty: true, message: "API Key 不能为空" };

    // API Key 会直接进入 Authorization 请求头；拒绝内部空白和控制字符，避免请求头注入或歧义解析。
    if (/[\s\u0000-\u001f\u007f-\u009f]/.test(apiKey)) {
        return { valid: false, empty: false, message: "API Key 格式无效，不能包含空白或控制字符" };
    }

    return { valid: true, value: apiKey };
}

function isLoopbackHost(host) {
    host = host.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

    var ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!ipv4 || Number(ipv4[1]) !== 127) return false;
    for (var i = 1; i <= 4; i++) {
        if (Number(ipv4[i]) > 255) return false;
    }
    return true;
}

// 自定义远程端点会接收 API Key 和完整截图，因此只允许 HTTPS；本机回环地址可使用 HTTP 调试。
function validateApiBaseUrl(value) {
    var apiUrl = value ? String(value).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") : "https://api.mistral.ai";
    if (!apiUrl || /[\u0000-\u0020\\]/.test(apiUrl)) {
        return { valid: false, message: "API 地址格式无效" };
    }

    var parsed = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(apiUrl);
    if (!parsed || parsed[2].indexOf("@") !== -1) {
        return { valid: false, message: "API 地址仅允许 HTTPS（本机回环地址可使用 HTTP），且不能包含查询参数、片段或用户信息" };
    }

    var scheme = parsed[1].toLowerCase();
    var authority = parsed[2];
    var host = "";
    var port = "";

    if (authority.charAt(0) === "[") {
        var bracketEnd = authority.indexOf("]");
        if (bracketEnd === -1 || !/^[0-9a-f:.]+$/i.test(authority.slice(1, bracketEnd))) {
            return { valid: false, message: "API 地址中的 IPv6 主机无效" };
        }
        host = authority.slice(1, bracketEnd);
        var bracketSuffix = authority.slice(bracketEnd + 1);
        if (bracketSuffix) {
            if (!/^:\d+$/.test(bracketSuffix)) return { valid: false, message: "API 地址端口无效" };
            port = bracketSuffix.slice(1);
        }
    } else {
        if (authority.indexOf(":") !== authority.lastIndexOf(":")) {
            return { valid: false, message: "IPv6 API 地址必须使用方括号" };
        }
        var colonIndex = authority.lastIndexOf(":");
        if (colonIndex !== -1) {
            host = authority.slice(0, colonIndex);
            port = authority.slice(colonIndex + 1);
            if (!/^\d+$/.test(port)) return { valid: false, message: "API 地址端口无效" };
        } else {
            host = authority;
        }
        if (!/^[a-z0-9.-]+$/i.test(host)) return { valid: false, message: "API 地址主机无效" };
    }

    if (!host || (port && (Number(port) < 1 || Number(port) > 65535))) {
        return { valid: false, message: "API 地址主机或端口无效" };
    }
    if (scheme === "http" && !isLoopbackHost(host)) {
        return { valid: false, message: "远程 API 地址仅允许 HTTPS；仅 localhost 或回环地址可使用 HTTP" };
    }

    return { valid: true, url: apiUrl.replace(/\/+$/, "") };
}

function modelIsAvailable(models, selectedModel) {
    return models.some(function (model) {
        return model && typeof model.id === "string" &&
            (model.id === selectedModel || (Array.isArray(model.aliases) && model.aliases.indexOf(selectedModel) !== -1));
    });
}

function pluginValidate(completion) {
    var done = completeOnce(completion);

    try {
        var validatedKey = validateApiKey($option.apiKey);
        if (!validatedKey.valid) {
            done({
                result: false,
                error: {
                    type: "secretKey",
                    message: validatedKey.empty ? "请先填写 Mistral AI API Key" : validatedKey.message,
                    troubleshootingLink: MISTRAL_CONSOLE_URL,
                },
            });
            return;
        }
        var apiKey = validatedKey.value;

        var validatedUrl = validateApiBaseUrl($option.apiUrl);
        if (!validatedUrl.valid) {
            done({ result: false, error: { type: "param", message: validatedUrl.message } });
            return;
        }

        $http.request({
            method: "GET",
            url: validatedUrl.url + "/v1/models",
            header: {
                Authorization: "Bearer " + apiKey,
            },
            timeout: 10,
            handler: function (resp) {
                try {
                    if (!resp || resp.error) {
                        done({
                            result: false,
                            error: {
                                type: "network",
                                message: "网络请求失败: " + getErrorMessage(resp && resp.error, [apiKey]),
                            },
                        });
                        return;
                    }

                    if (!resp.response || typeof resp.response.statusCode !== "number") {
                        done({ result: false, error: { type: "api", message: "验证响应格式无法解析" } });
                        return;
                    }

                    var statusCode = resp.response.statusCode;
                    if (statusCode === 401 || statusCode === 403) {
                        done({
                            result: false,
                            error: {
                                type: "secretKey",
                                message: "API Key 无效或已过期",
                                troubleshootingLink: MISTRAL_CONSOLE_URL,
                            },
                        });
                        return;
                    }

                    if (statusCode !== 200) {
                        done({
                            result: false,
                            error: {
                                type: "network",
                                message: "验证失败，状态码: " + statusCode,
                            },
                        });
                        return;
                    }

                    // 防止代理登录页等任意 HTTP 200 被误判为有效 Mistral API。
                    if (!resp.data || !Array.isArray(resp.data.data)) {
                        done({ result: false, error: { type: "api", message: "验证响应格式无法解析" } });
                        return;
                    }

                    var model = resolveOcrModel($option.model);
                    if (!modelIsAvailable(resp.data.data, model)) {
                        done({ result: false, error: {
                            type: "api",
                            message: "API Key 验证成功，但当前端点未提供所选 OCR 模型：" + model,
                        } });
                        return;
                    }
                    done({ result: true });
                } catch (error) {
                    done({
                        result: false,
                        error: { type: "api", message: "处理验证响应失败: " + getErrorMessage(error, [apiKey]) },
                    });
                }
            },
        });
    } catch (error) {
        done({
            result: false,
            error: { type: "network", message: "无法发起验证请求: " + getErrorMessage(error, [apiKey]) },
        });
    }
}
