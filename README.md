# pi-opencode-native

让 [pi](https://github.com/Codeks/pi)（AI 编码助手 CLI）通过原生通道调用 **OpenCode Zen 免费模型**（`deepseek-v4-flash-free` 等 7 个），解决第三方客户端直接调用时遭遇的 **429 FreeUsageLimitError** 限流问题。

## 问题背景

OpenCode Zen 的免费模型由上游 "Console" 推理提供商托管，其**按 `User-Agent` 头**决定是否放行免费容量：

- 请求带 `User-Agent: opencode/...` → 放行（200）
- 请求带 `curl`、`OpenAI/JS` 等非 opencode UA → 拒绝（429 `FreeUsageLimitError`）

pi 内置的 opencode provider 不使用 opencode UA，因此直接调用免费模型必然 429。本扩展注册了一个**自包含的 provider**（`opencode-fix`），用原生头（`User-Agent: opencode/1.15.5` + `x-opencode-client` + `x-opencode-session/request` ULID ID）发起请求，同时把 pi 内部消息格式正确转换为 OpenAI 兼容格式（`developer`→`system`、thinking 块剔除、tool 消息转 `role: "tool"` 等）。

**零外部依赖**：不 import pi-ai（pi 是单文件 bun 打包，磁盘上无法解析该模块），自带 SSE 解析与事件流。

## 安装

### 方式一：本地文件

```bash
pi install /path/to/pi-opencode-native-ext.mjs
```

### 方式二：GitHub

```bash
pi install git:github.com/<owner>/pi-opencode-native
# 或
pi install https://github.com/<owner>/pi-opencode-native
```

### 方式三：npm（若已发布）

```bash
pi install npm:pi-opencode-native
```

## 配置

### 1. API key

key 解析优先级（从高到低）：

1. **环境变量 `OPENCODE_API_KEY`**（推荐，不把 key 写进配置文件）
2. `~/.pi/agent/auth.json` 中 `opencode-fix.key`（**非** `public` 的值）
3. 兜底匿名 `public`

```bash
# 方式 A：环境变量（推荐，账号 key）
export OPENCODE_API_KEY=sk-xxx

# 方式 B：auth.json（public = 匿名）
cat ~/.pi/agent/auth.json
# { "opencode-fix": { "type": "api_key", "key": "public" } }
```

> ⚠️ auth.json 中 `key: "public"` 是匿名占位，会被忽略（走兜底）；要指定账号 key 请用环境变量或把 `public` 换成真实 key。
>
> ⚠️ **不要删除 auth.json 中的 `opencode-fix` 条目**——pi 在找不到该 provider 的 key 时会直接跳过这个扩展（failover 到内置 provider），导致扩展完全不生效。

### 2. 默认 provider（可选，推荐）

`~/.pi/agent/settings.json`：

```json
{
  "defaultProvider": "opencode-fix",
  "defaultModel": "deepseek-v4-flash-free"
}
```

## 使用

```bash
# 一次性问答
pi -p "Reply with exactly OK"

# 交互式
pi

# 指定模型
pi --model opencode-fix/hy3-free
```

### 可用免费模型

| 模型 ID | 说明 |
|---|---|
| `deepseek-v4-flash-free` | 日常编码首选，快 |
| `big-pickle` | 匿名 stealth 模型（社区确认底层≈DeepSeek V4 Flash） |
| `hy3-free` | 复杂/终端类任务 |
| `laguna-s-2.1-free` | 长时程 agent 编码 |
| `mimo-v2.5-free` | 多模态 |
| `nemotron-3-ultra-free` | 超长上下文（1M） |
| `nemotron-3.5-lightning-free` | 高速执行 |

TUI 内 **Ctrl+P** 循环切换模型。

## 额外供应商：SenseNova（商汤日日新）

本扩展同时注册了 **`sensenova`** provider，接入[商汤日日新平台](https://platform.sensenova.cn/)的 OpenAI 兼容网关（`https://token.sensenova.cn/v1`），免费公测套餐可用（每模型 1,500 次调用 / 5 小时）。

### 配置

```bash
# 在 https://platform.sensenova.cn/console/keys 申请 key
export SENSENOVA_API_KEY=sk-xxx
```

auth.json 中预置 `sensenova` 占位条目（`key: "public"`），同 `opencode-fix` 一样**不要删除**——pi 找不到该 provider 的 key 时会直接跳过扩展。

### 可用模型

（数据源：[平台文档](https://platform.sensenova.cn/docs)，`GET /v1/models` 权威返回；全部 `pricing=0` 免费，`businesses: tokenplan + metered`）

| 模型 ID | 说明 | 上下文 | 限额 |
|---|---|---|---|
| `sensenova-6.7-flash-lite` | 轻量多模态智能体（文本+图像） | 256K | 1,500 次 / 5h |
| `sensenova-6.8-flash-lite` | 新一代轻量多模态智能体（文本+图像） | 256K | 1,500 次 / 5h |
| `deepseek-v4-flash` | DeepSeek 高性能对话（thinking/非 thinking、工具调用） | 1M | 150 次 / 5h |
| `glm-5.2` | 智谱旗舰长程任务模型（1M 上下文，可完成端到端开发管线） | 1M | 免费套餐可用 |

> `sensenova-u1-fast` 为**图像生成专用**（`output_modalities: image`，走 `/v1/images/generations`），与 chat completions 不兼容，未注册。

### 使用

```bash
pi -p --provider sensenova --model sensenova/sensenova-6.7-flash-lite "你好"
pi --provider sensenova --model sensenova/deepseek-v4-flash
```

### SenseNova 特有的坑（已内置处理）

网关 schema 比 OpenAI 更严，**官方参数表未列出的字段一律拒收**（报错被替换成无信息量的 `Errors in message queue response`）。扩展内置 `cleanBody` 已处理：合并多条 `system` 消息、删除 `assistant.content: null`；`max_tokens` 上限 65,536（模型注册即设好）、上下文 256K。

注意：`sensenova-u1-fast` 是**图像生成专用**模型（走 `/v1/images/generations`），与 chat completions 不兼容，本扩展不支持。

## 注意事项

1. **模型歧义**：若机器上也配置了 pi 内置 `opencode` provider 且带 key，裸 `--model deepseek-v4-flash-free` 会报 "ambiguous across providers"。解决：显式 `--provider opencode-fix`，或删除内置 opencode 的 key，或将 defaultProvider 设为 `opencode-fix`。
2. **限流是共享的**：匿名 `public` key 的免费额度是全 Zen 用户共享的（社区实测约 200 请求/天兜底，官方未公布固定配额），到达后返回 429 `FreeUsageLimitError`，需等待重置。人越多额度越紧张。
3. **UA 门可能变化**：本扩展写死 `User-Agent: opencode/1.15.5`。OpenCode 官方若调整版本号或免费门控策略，免费通道可能失效，需同步更新本文件中的 `OPENCODE_STATIC_HEADERS`。
4. **数据条款**：免费模型的免费期内，**提交的数据可能被用于改进模型**（官方隐私声明明确例外）。切勿发送敏感/机密内容。`nemotron-*` 为 NVIDIA 试用端点，禁止提交个人或机密数据，会话会被记录。
5. **免费是限时的**：官方措辞为 "available for a limited time"，模型可能随时下架、改名或转为付费，不适合作为生产依赖。
6. **单文件可审计**：整个扩展就是一个 `.mjs` 文件，使用前建议通读确认无异常行为。
7. **代理会导致 500**：Zen API 请求**不能走 HTTP 代理**（实测经 v2rayN/Clash 等代理转发返回 500 Internal server error，直连正常）。若系统全局代理已开启（Windows WinINET），node/bun 的 fetch 默认不读系统代理所以不受影响，但请勿为此扩展显式设置 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量指向代理。

## License

MIT