# Bob 实机验证记录

验证日期：2026-10-01（Australia/Brisbane）。

| 项目 | 结果 |
| --- | --- |
| Bob | 1.21.0，build 260 |
| 插件 | Mistral OCR 1.5.2 |
| 已安装源码 | 与工作区 `main.js` 的 SHA-256 一致 |
| API 端点 | `https://api.mistral.ai` |
| 模型设置 | `mistral-ocr-latest` |
| 结果模式 | 纯文本 |
| 独立 OCR 配置验证 | 成功 |
| 图片识别调用 | 两次：首次鉴权失败，第二次成功 |
| 测试图片 | `tests/fixtures/ocr-sample.png`，仅包含示例文字和表格 |
| 实际输出检查 | 标题、中文、两行表格数据、路径、比较符、乘号和段落换行全部通过 |

通过 Bob 官方 AppleScript 接口提交图片，再从 Bob 的独立 OCR 窗口读取并检查结果。只显示结果窗口的 `showWindow` 调用不产生额外识别请求。记录不包含密钥、配置中的秘密值或原始网络诊断。

实际识别文本：

```text
OCR REGRESSION TEST

中文识别测试

NAME AMOUNT

ALICE 100

BOB 200

C:\ | x < 5 | 2*3*4
```

工作区及已安装 `main.js` 的 SHA-256：

```text
a6a8bade34181b1b9045b26220b80e19ebd2a6b39249903bdfe89bab3853c193
```

最终 `dist/Mistral-OCR.bobplugin` 的 SHA-256：

```text
b0c0bbce509418347789981e879238a68b77cddbdd894161fa323fa47bc9a525
```

本地回归另已通过 110 项 Node 测试、JavaScriptCore 的六项文本检查和完整 PNG 检查，以及源码一致性、语法、凭据扫描、发布元数据和确定性插件包校验。

独立 OCR 使用「偏好设置 → OCR → 服务」中的配置。不要用「翻译 → 服务 → 文本识别」中的验证成功代替这一组的验证。
