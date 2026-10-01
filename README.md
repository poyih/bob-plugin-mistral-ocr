# Mistral OCR - Bob 文本识别插件

基于 [Mistral AI OCR](https://docs.mistral.ai/studio-api/document-processing/basic_ocr) 的 [Bob](https://bobtranslate.com/) 文本识别（OCR）插件。

## 功能

- 调用 Mistral OCR API 识别图片中的文字
- 可选择 OCR 模型版本：最新版、OCR 4.1（26.07）、OCR 4（26.06）、OCR 3（25.12）
- 支持多语言识别（中文简繁、粤语、文言文、英、日、韩、葡（葡/巴）等 30+ 种语言）
- 支持表格、公式等复杂排版识别
- 可选保留 Markdown 格式或输出纯文本
- 支持安全的自定义 API 地址（远程代理必须使用 HTTPS，本机回环调试可使用 HTTP）
- 内置 API Key 验证按钮，验证失败时直达控制台排障链接
- 验证按钮同时检查所选 OCR 模型是否可用（支持模型别名和退役模型回退）
- 图片原始数据上限为 20 MiB，超限图片会在上传前拒绝

## 安装

1. 前往 [Releases](https://github.com/poyih/bob-plugin-mistral-ocr/releases) 下载最新的 `Mistral-OCR.bobplugin` 文件
2. 双击安装到 Bob

## 配置

1. 前往 [Mistral AI Console](https://console.mistral.ai/api-keys) 获取 API Key
2. 在 Bob 偏好设置 → 插件 → Mistral OCR 中填入 API Key

| 选项 | 说明 |
|------|------|
| API Key | Mistral AI API Key（必填） |
| 自定义 API 地址 | 可留空，默认为 `https://api.mistral.ai`；远程地址必须使用 HTTPS，仅 `localhost` / 回环地址可使用 HTTP |
| OCR 模型 | 选择模型版本，默认跟随官方最新版 `mistral-ocr-latest` |
| 保留 Markdown 格式 | 默认输出纯文本；开启后保留 Markdown，并将独立返回的表格回填到对应位置 |

## 模型版本

| 名称 | 模型 ID | 说明 |
|------|---------|------|
| 最新版（推荐） | `mistral-ocr-latest` | 始终指向 Mistral 官方最新 OCR 模型（当前为 OCR 4.1） |
| [OCR 4.1](https://docs.mistral.ai/models/ocr-4-1) | `mistral-ocr-4-1` | 2026.07 发布，2026.08 转为正式版，新增区块级置信度评分 |
| OCR 4 | `mistral-ocr-4-0` | 2026.06 发布，支持 170 种语言、边界框、块分类与置信度评分 |
| OCR 3 | `mistral-ocr-2512` | 2025.12 发布，复杂表格 / 手写 / 扫描件识别显著提升 |

> 已退役模型（`mistral-ocr-2505`、`mistral-ocr-2503`）已从选项中移除；若你之前选过旧版，插件会自动回退到最新版。

> OCR 4.1 已于 2026.08 结束公开预览并转为正式版；如需固定使用此前版本，可在设置中选择 OCR 4（`mistral-ocr-4-0`）或 OCR 3（`mistral-ocr-2512`）。

## 从 0.4.0 或更早版本迁移

v0.5.0 将插件标识符从 `com.poyih.bob-plugin-mistral-ocr` 改为 `bob-plugin-mistral-ocr`。Bob 要求 appcast 标识符与已安装插件完全一致，因此一个静态 appcast 无法同时为两个标识符提供自动升级；v0.5.0 及之后的用户不受影响。

如果你仍在使用 v0.4.0 或更早版本，请先确保自己仍可取得 API Key，再在 Bob 中卸载旧插件并从 [Releases](https://github.com/poyih/bob-plugin-mistral-ocr/releases) 手动安装最新版，最后重新填写设置。直接并行安装可能会留下两个独立插件。

## 发布流程

插件包由 [`scripts/build-plugin.mjs`](scripts/build-plugin.mjs) 确定性构建：同一份 `info.json` 和 `main.js` 在任何环境都会得到字节一致的 `Mistral-OCR.bobplugin`，因此 appcast 中的 SHA-256 可以在发布前就写入。

`release-pending.json` 保存待发布版本；在线 `appcast.json` 仅列出已验证且公开可下载的版本。开发时不要提前向 appcast 加入新版本。

1. **更新版本。** 修改 `info.json` 的 `version`，运行 `npm run stage:release -- "更新说明"`。这会生成源码、构建插件包，并将版本、下载地址、SHA-256、最低 Bob 版本和时间戳写入待发布文件。修改源码后再次运行 `npm run stage:release`，刷新校验值并保留已有说明和时间戳。
2. **本地检查。** 运行 `npm run ci`，检查生成源码、JavaScript 语法、凭据、发布元数据、回归测试和确定性插件包，并验证待发布的 SHA-256。日常 CI 使用同样的离线检查，无需下载尚未发布的资产。
3. **合并到 `main`。** 提交 `src/`、生成的 `main.js`、版本和待发布元数据；在线 appcast 保持现有已发布版本。
4. **发布。** 推送标签 `vX.Y.Z`，或在 GitHub Actions 页面手动运行 **Release** 工作流并填入标签名。已有标签会被检出用于重试；新标签从所选的 `main` 提交创建。

Release 工作流（[`.github/workflows/release.yml`](.github/workflows/release.yml)）会依次：

- 运行全部仓库检查并确定性构建插件包；
- 校验标签、`info.json`、待发布条目与产物的版本、下载地址和 SHA-256 一致；
- 确认标签是新的或已指向当前提交，且该提交在 `main` 上；
- 创建或恢复草稿 Release，上传插件，并下载校验草稿资产；
- 公开 Release 后校验公开下载地址；
- 最后通过 GitHub Contents API 将该版本加入 `main/appcast.json`，保留其他已发布版本；
- 对所有已发布资产和标签执行深度校验。

工作流串行处理发布。重跑会复用已存在的草稿或公开资产；校验值不一致时立即停止，绝不覆盖已发布包。上传、公开下载校验或 appcast 更新失败后，可重跑同一标签；若 appcast 已一致则不再提交。历史版本采用旧流程的标签不适用于此重试机制。

Release 工作流需要 `contents: write` 权限以更新 appcast。若 `main` 的分支保护禁止工作流直接提交，需允许该发布流程的 appcast 更新，或将已验证的待发布条目通过 PR 合并；资产已经发布时，重跑不会重新上传或覆盖它。

远端资产核验独立于日常 CI，可手动运行 **Release integrity audit** 工作流。下载超时覆盖完整响应体，并限制单个资产下载大小为 10 MiB。

## 开发和测试

开发源码位于 `src/config.js`、`src/image.js`、`src/markdown.js`、`src/api.js` 和 `src/ocr.js`；`src/html-entities.js` 提供 HTML 字符实体映射。`main.js` 由 `npm run build:source` 确定性生成，请在模块中修改代码后重新生成。插件包仍只含 `info.json` 和 `main.js`，无需 Node.js 依赖即可在 Bob 中运行。

```bash
npm run build:source
npm test
npm run stage:release
npm run ci
```

macOS 上可额外运行 `npm run test:jsc`，通过系统 JavaScriptCore 加载完整插件并执行关键文本和图片回归；需要 Xcode Command Line Tools 中的 Swift。

测试覆盖转义、代码、中文强调、实体、独立表格、宽表格性能、所选模型、上传限制、完整 PNG/JPEG 图片、下载超时和发布中断重试。`tests/fixtures/ocr-sample.png` 与 `.jpg` 是只含示例文字和表格的完整测试图，不含个人资料。

真实 API 测试需自行提供环境变量，执行 `npm run test:live`；它只上传上述 PNG，一次运行发起一次 OCR 请求，可能产生费用。不要将真实 API Key 写入脚本、测试或仓库。该脚本不输出密钥、图片数据或原始响应。

Bob 实机回归：安装 `dist/Mistral-OCR.bobplugin`，在服务中验证所选模型；将测试图拖入 OCR 窗口，检查中文、`ALICE 100`、`BOB 200`、路径与表格。以 Bob 实际表现为准，Node 模拟测试不能代替 JavaScriptCore 和界面验证。

macOS 上也可通过 Bob 官方 AppleScript 接口运行 `npm run test:bob`。该命令提交公开测试图，不读取密钥；命令返回表示已提交，识别是否成功仍需在 Bob 的 OCR 窗口核对。系统首次请求自动化权限时由使用者确认。

独立 OCR 窗口使用「偏好设置 → OCR → 服务」的设置；「翻译 → 服务 → 文本识别」是另一组配置。API Key、模型和验证结果应在实际使用的那一组服务中检查。

## 发布完整性

`appcast.json` 只记录当前标识符下确实存在且可下载的 Release 资产，版本号不连续是正常的。历史发布包以 appcast 中固定的 SHA-256 为准；已经发布的资产和 Git tag 不做追溯改写。已知的旧标识符版本、未实际发布的版本号以及历史 tag/发布包差异记录在 [`release-provenance.json`](release-provenance.json)。

提交发布元数据前可运行：

```bash
node scripts/validate-release-metadata.mjs
```

在具有完整 Git tags、`unzip` 和网络连接的环境中，可进一步核验所有 Release 下载、SHA-256、包内元数据及 tag 差异：

```bash
node scripts/validate-release-metadata.mjs --check-assets --check-tags
```

## 支持语言

中文简体、中文繁体、粤语、文言文、英语、日语、韩语、法语、德语、西班牙语、意大利语、葡萄牙语、葡萄牙语（巴西）、葡萄牙语（葡萄牙）、俄语、阿拉伯语、荷兰语、波兰语、泰语、越南语、土耳其语、印尼语、印地语、希伯来语、希腊语、乌克兰语、捷克语、瑞典语、丹麦语、芬兰语、挪威语、罗马尼亚语、匈牙利语

## 感谢

- [Bob](https://bobtranslate.com/) - macOS 翻译和 OCR 软件
- [Mistral AI](https://mistral.ai/) - OCR 能力提供方
