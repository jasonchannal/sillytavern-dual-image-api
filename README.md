# SillyTavern Dual Image API

这是一个 SillyTavern 双模式生图插件原型。

当前版本已经包含：

- 前端扩展设置面板。
- SFW / NSFW 两套独立 API 配置。
- SFW / NSFW 两套独立 API Key 服务端保存。
- 本地提示词规则判断，自动选择 SFW 或 NSFW。
- `/dualimg` 和 `/di` 斜杠命令。
- 扩展菜单里的 Dual Image 按钮。
- OpenAI-compatible 生图接口。
- Generic JSON 生图接口。
- 图片生成后保存并插入当前聊天。
- 聊天图片保存前会转成压缩 JPEG，可设置质量和最大边长。
- AI 回复生成时一并输出隐藏生图提示词，插件解析后自动生成配图。
- 自动配图会先写入占位符，生图完成后用图片链接替换占位符，不额外发送一条图片消息。
- 生图失败后可按设置自动重试。
- SFW 模式会自动把提示词整理成更安全、更聚焦的生图提示词；NSFW 模式保持提示词直出。
- 服务端插件健康检查和配置检查。

## 安装方式

这个仓库根目录已经按 SillyTavern 扩展管理器要求放置了 `manifest.json`、`index.js`、`settings.html` 和 `style.css`。

因此前端扩展可以直接在 SillyTavern 的扩展安装窗口里输入 GitHub 仓库地址安装。

需要同时安装前端扩展和服务端插件。

### 1. 安装前端扩展

推荐方式：

```text
SillyTavern -> Extensions -> Install extension -> 输入本仓库 GitHub 地址
```

手动方式：

把本仓库复制到 SillyTavern 的扩展目录，并建议命名为：

```text
public/scripts/extensions/dual-image-api
```

只要 SillyTavern 能在目录根部发现 `manifest.json` 即可。

### 2. 安装服务端插件

服务端插件仍需要放到 SillyTavern 的 `plugins` 目录。推荐直接把同一个 GitHub 仓库克隆到：

```text
plugins/dual-image-api
```

这个仓库根目录的 `package.json` 已经指向 `server-plugin/index.mjs`，所以作为服务端插件加载时也能被 SillyTavern 识别。

### 3. 启用 SillyTavern 服务端插件

在 SillyTavern 的 `config.yaml` 中确认：

```yaml
enableServerPlugins: true
```

然后重启 SillyTavern。

## 使用方式

1. 打开 SillyTavern 扩展设置。
2. 找到 `Dual Image API`。
3. 点击“检查服务端插件”，确认服务端插件已连接。
4. 分别填写 SFW 和 NSFW API 配置。
5. 分别保存 SFW 和 NSFW API Key。
6. 如需使用 NSFW 自动路由，打开“允许 NSFW 模式”。
7. 使用扩展菜单里的 `Dual Image` 按钮，或使用命令：

```text
/dualimg mode=auto a cinematic portrait
```

也可以手动指定模式：

```text
/dualimg mode=sfw a landscape concept art
/dualimg mode=nsfw adult character illustration
```

### 对话自动配图

插件设置里打开“AI 回复时一并生成配图提示词”后，每次 AI 回复会自动执行：

1. 在本次 AI 回复生成前插入一段隐藏要求，让 AI 在回复末尾附带图片提示词标记。
2. AI 回复中会先出现“正在生成配图...”占位符。
3. AI 回复完成后，插件读取并移除隐藏标记，不把提示词留在可见聊天内容里。
4. 按提示词内容自动选择 SFW 或 NSFW 图片 API。
5. 图片生成后，插件把占位符替换成 `user/images/...` 图片链接。

“失败重试次数”可以控制生图失败后的自动重试次数，设为 `0` 表示不重试。

自动配图提示词会尽量只保留可见画面信息，并要求不要只生成用户单人画面。SFW 模式还会追加非露骨、全穿着、适合外部审核的约束。

“JPEG 质量”和“最大边长”控制聊天图片体积。默认质量 `82`、最大边长 `1024`；最大边长设为 `0` 表示不缩放，只转 JPEG。

这个功能默认关闭。开启后不会额外消耗一次聊天 API，但每次成功配图都会消耗生图 API 额度。

## API 类型

### OpenAI-compatible

默认请求：

```json
{
  "model": "你的模型名",
  "prompt": "最终提示词",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

默认支持这些返回路径：

- `data.0.b64_json`
- `data.0.url`
- `image`
- `images.0`
- `images.0.url`
- `output.0`
- `result.image`

如果你的 API 返回字段不同，可以在“结果字段”中填写点路径，例如：

```text
data.0.url
```

### Generic JSON

用于接入非 OpenAI-compatible API。

可配置：

- 请求方法。
- Headers JSON。
- Body 模板。
- 结果字段。
- 密钥 Header。
- 密钥前缀。

Body 模板支持变量：

- `{{prompt}}`
- `{{rawPrompt}}`
- `{{negativePrompt}}`
- `{{model}}`
- `{{width}}`
- `{{height}}`
- `{{steps}}`
- `{{cfg}}`

## 自动模式判断

当前版本使用本地关键词评分：

- 普通提示词默认走 SFW。
- 成人向关键词达到阈值后走 NSFW。
- 命中 SFW 关键词会降低 NSFW 分数。
- 不确定时默认走 SFW。
- `mode=sfw` / `mode=nsfw` 可以手动覆盖。

安全边界：

- 如果提示词同时包含成人信号和未成年人信号，会直接拦截。
- 如果提示词同时包含成人信号和非自愿/强迫信号，会直接拦截。
- NSFW 模式默认关闭，需要用户主动开启。

## 当前限制

- 还没有做异步任务型 API 轮询。
- 还没有做图生图、参考图、ControlNet 或 ComfyUI 工作流。
- Generic JSON 只处理 JSON 返回，不处理 ZIP 或多阶段任务。
- 自动判断是本地规则，不可能 100% 准确，建议保留结果中的模式显示。
- 服务端插件必须启用，否则密钥和第三方 API 调用无法正常工作。

## 开发验证

已做的基础检查：

```text
node --check extension/index.js
node --check server-plugin/index.mjs
```

下一步应在真实 SillyTavern 环境中验证：

- 扩展是否出现在设置中。
- 服务端插件健康检查是否通过。
- SFW 配置是否能生成图片。
- NSFW 配置是否能生成图片。
- `/dualimg mode=auto ...` 是否能正确插入聊天图片。
