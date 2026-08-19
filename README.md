# pi-opencode-native

让 [pi](https://github.com/Codeks/pi)（AI 编码助手 CLI）通过原生通道调用 **OpenCode Zen 免费模型**（`deepseek-v4-flash-free` 等 7 个），解决第三方客户端直接调用时遭遇的 **429 FreeUsageLimitError** 限流问题。

## 问题背景

OpenCode Zen 的免费模型由上游 "Console" 推理提供商托管，其**按 `User-Agent` 头**决定是否放行免费容量：

- 请求带 `User-Agent: opencode/...` → 放行（200）
- 请求带 `curl`、`OpenAI/JS` 等非 opencode UA → 拒绝（429 `FreeUsageLimitError`）

pi 内置的 opencode provider 不使用 opencode UA，因此直接调用免费模型必然 429。本扩展注册了一个**自包含的 provider**（`opencode-fix`），用原生头（`User-Agent: opencode/1.15.5` + `x-opencode-client` + `x-opencode-session/request` ULID ID）发起请求，同时把 pi 内部消息格式正确转换为 OpenAI 兼容格式（`developer`→`system`、thinking 块转回 assistant 消息的 `reasoning_content`、tool 消息转 `role: "tool"` 等）。

**零外部依赖**：不 import pi-ai（pi 是单文件 bun 打包，磁盘上无法解析该模块），自带 SSE 解析与事件流。

## 安装

### 方式一：本地文件

```bash
pi install /path/to/pi-opencode-native-ext.mjs
```

### 方式二：GitHub（推荐）

仓库已公开：<https://github.com/pgciq/pi-opencode-native>

```bash
pi install git:github.com/pgciq/pi-opencode-native
# 或
pi install https://github.com/pgciq/pi-opencode-native
```

> 扩展始终优先以 `pi-opencode-native-ext.mjs` 为入口文件（仓库根目录），`pi install` 会自动识别；若需指定分支可追加 `#master`。

### 方式三：npm（已发布）

包已发布到 npm：<https://www.npmjs.com/package/pi-opencode-native>

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

## 额外供应商

除 Zen 免费模型外，本扩展还注册了 **5 个第三方免费/低成本供应商**。所有 provider 的 key 解析优先级一致：环境变量 → auth.json 中非 `public` 的 key → 匿名占位（`key: "public"` 会被忽略）。auth.json 中相应条目**不要删除**——pi 找不到该 provider 的 key 时会直接跳过扩展。

### SenseNova（商汤日日新）

接入[商汤日日新平台](https://platform.sensenova.cn/)的 OpenAI 兼容网关（`https://token.sensenova.cn/v1`），免费公测套餐可用（每模型 1,500 次调用 / 5 小时）。

#### 配置

```bash
# 在 https://platform.sensenova.cn/console/keys 申请 key
export SENSENOVA_API_KEY=sk-xxx
```

#### 可用模型

（数据源：[平台文档](https://platform.sensenova.cn/docs)，`GET /v1/models` 权威返回；全部 `pricing=0` 免费，`businesses: tokenplan + metered`）

| 模型 ID | 说明 | 上下文 | 限额 |
|---|---|---|---|
| `sensenova-6.7-flash-lite` | 轻量多模态智能体（文本+图像） | 256K | 1,500 次 / 5h |
| `sensenova-6.8-flash-lite` | 新一代轻量多模态智能体（文本+图像） | 256K | 1,500 次 / 5h |
| `deepseek-v4-flash` | DeepSeek 高性能对话（thinking/非 thinking、工具调用） | 1M | 150 次 / 5h |
| `glm-5.2` | 智谱旗舰长程任务模型（1M 上下文，可完成端到端开发管线） | 1M | 免费套餐可用 |

> `sensenova-u1-fast` 为**图像生成专用**（`output_modalities: image`，走 `/v1/images/generations`），与 chat completions 不兼容，未注册。

#### 使用

```bash
pi -p --provider sensenova --model sensenova/sensenova-6.7-flash-lite "你好"
pi --provider sensenova --model sensenova/deepseek-v4-flash
```

#### SenseNova 特有的坑（已内置处理）

网关 schema 比 OpenAI 更严，**官方参数表未列出的字段一律拒收**（报错被替换成无信息量的 `Errors in message queue response`）。扩展内置 `cleanBody` 已处理：合并多条 `system` 消息、删除 `assistant.content: null`；`max_tokens` 上限 65,536（模型注册即设好）、上下文 256K。

### 硅基流动 (SiliconFlow)

国内直连，编码模型强。Nex-N2-Pro（397B MoE，SWE-Bench 80.8）**完全免费**。

```bash
# 在 https://cloud.siliconflow.cn 注册实名，获取 key
export SILICONFLOW_API_KEY=sk-xxx

# 使用
pi -p --provider siliconflow --model siliconflow/nex-agi/Nex-N2-Pro "你好"
```

| 模型 ID | 说明 | 上下文 | 限额 |
|---|---|---|---|
| `nex-agi/Nex-N2-Pro` | Nex-N2-Pro (397B MoE，编码≈GPT-5.5，文本+图像) | 256K | 免费 |
| `Qwen/Qwen3-8B` | Qwen3-8B 通用对话 | 256K | 免费 |

### 魔塔社区 (ModelScope)

阿里达摩院旗下，一个 Key 同时兼容 OpenAI + Anthropic 双协议，每日 2000 次免费调用。

```bash
# 在 https://modelscope.cn 注册，绑定阿里云账号+实名，获取 SDK Token
export MODELSCOPE_API_KEY=ms-xxx

# 使用
pi -p --provider modelscope --model modelscope/Qwen/Qwen3-Coder-30B-A3B-Instruct "你好"
```

| 模型 ID | 说明 | 上下文 | 限额 |
|---|---|---|---|
| `Qwen/Qwen3-Coder-30B-A3B-Instruct` | Qwen3 Coder 30B（实测可用） | 128K | 2000 次/天 |
| `deepseek-ai/DeepSeek-V4-Pro` | DeepSeek V4 Pro 强推理（存在，**需在控制台开通该模型额度**，否则 429） | 1M | 开通后 2000 次/天 |

> 实测发现 ModelScope 免费额度是**按模型**的：新账号默认只有部分模型可用（如 Qwen3-Coder-30B），其余返回 `UnknownError` 或 429 `insufficient_quota`，需在 [ModelScope 控制台](https://modelscope.cn) 逐个开通。可用模型以 `GET /v1/models` 为准（本扩展只注册了实测过的模型）。

### NVIDIA NIM

NVIDIA 官方推理平台，无需信用卡，40 RPM，无每日总量上限。

```bash
# 在 https://build.nvidia.com 注册获取 key
export NVIDIA_NIM_API_KEY=nvapi-xxx

# 使用
pi -p --provider nvidia --model nvidia/openai/gpt-oss-120b "你好"
```

| 模型 ID | 说明 | 上下文 | 限额 |
|---|---|---|---|
| `openai/gpt-oss-120b` | OpenAI 开源权重模型 | 128K | 无每日上限 |

> 更多模型可通过 `GET /v1/models` 查询（需有效 key），模型更新频繁，以官网为准。

### Cloudflare Workers AI

Cloudflare 官方托管推理平台，走 **OpenAI 兼容端点**（`https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`）。免费套餐每天 **10,000 Neurons**（UTC 0 点重置），在此额度内大部分模型免费调用。

#### 配置

```bash
# 在 https://dash.cloudflare.com 获取 Account ID，创建 API Token（Workers AI 权限）
export CLOUDFLARE_ACCOUNT_ID=your-32-character-account-id
export CLOUDFLARE_API_KEY=your-api-token
```

#### 可用模型

（数据源：官方定价页 + `GET /accounts/{id}/ai/models/search`；仅注册免费额度内可用的模型）

| 模型 ID | 说明 | 上下文 |
|---|---|---|
| `@cf/openai/gpt-oss-120b` | OpenAI 开源旗舰（编码/数学强） | 128K |
| `@cf/openai/gpt-oss-20b` | 低延迟版 | 128K |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 最强 Llama 3.3 | 128K |
| `@cf/qwen/qwen3-30b-a3b-fp8` | Qwen3 MoE 高效 | 128K |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | 代码专用 | 128K |
| `@cf/google/gemma-4-26b-a4b-it` | Google 多模态（文本+图像） | 128K |
| `@cf/zai-org/glm-4.7-flash` | 131K 上下文 | 131K |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | DeepSeek 推理 | 64K |

> ⚠️ **付费模型未注册**：`deepseek-v4-flash-0731`、`deepseek-v4-pro-0813`、`glm-5.2`、`kimi-k2.6`、`kimi-k2.7-code` 需 Workers Paid 账单或 AI Gateway 预付额度，免费额度调用会失败，本扩展（及 opencode blacklist）已排除。

#### 使用

```bash
pi -p --provider cloudflare --model cloudflare/@cf/openai/gpt-oss-120b "你好"
```

#### Cloudflare 特有的坑（已内置处理）

- URL 路径内嵌账户 ID，`streamCloudflare` 在请求时从 `CLOUDFLARE_ACCOUNT_ID` 动态拼装；该变量缺失时立即报错而非静默失败。
- 响应含 `reasoning_content`（思考）字段，扩展的标准 `processDelta` 已按 thinking 块处理并回传历史（与 DeepSeek V4 一致）。
- 免费额度按 Neurons 计费（非 token），模型越强越费：70B 模型 ~0.29¢/K 输入、~2.25¢/K 输出；10K neurons 每天约能跑几十次轻量问答。

#### 实测兼容性（2026-08，`/ai/v1/chat/completions` 端点）

| 模型 | 纯对话 | 工具调用 (tool_calls) | 多轮历史回传 |
|---|---|---|---|
| `@cf/zai-org/glm-4.7-flash` | ✅ | ✅ 标准格式 | ✅ **agent 工作流首选** |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | ✅ | ⚠️ 以 `<tools>` XML 文本嵌入，**不走标准 tool_calls** | ⚠️ 仅适合纯对话/代码问答 |
| `@cf/openai/gpt-oss-120b` | ✅ | ✅ 第一轮正常 | ❌ 回传历史报 400 schema 错误（CF 端已知限制） |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | ✅ | 未全测（24K 上下文，注意 max_tokens 已按实测收紧） | — |
| `@cf/qwen/qwen3-30b-a3b-fp8` | ✅ | 未全测（32K 上下文，已按实测收紧） | — |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | ✅ | 未全测（80K 上下文） | — |

> 各模型实际上下文以本次实测为准：`llama-3.3-70b` = 24K、`qwen3-30b-a3b`/`qwen2.5-coder-32b` = 32K、`deepseek-r1-distill-qwen-32b` = 80K、其余 ≥131K。模型注册的 `contextWindow`/`maxTokens` 已按实测值收紧，避免 CF 端 400 超限错误。

### 如何选择

5 个额外供应商全部免费模型统一对比（基准数据截至 2026-08，来源：官方技术报告 + 独立评测）：

| 供应商 | 模型 | 规模 | 上下文 | 能力定位 | 实测 |
|---|---|---|---|---|---|
| 硅基流动 | `nex-agi/Nex-N2-Pro` | 397B MoE (17B 激活) | 256K | 🏆 旗舰编码/agent：SWE-Bench Pro 58.8（微超 GPT-5.5）、Terminal-Bench 2.1 75.3（超 Opus 4.7）、SWE Verified 80.8；中文友好（基座 Qwen3.5）；最难真实任务（DeepSWE 33.6）仍有差距 | ✅ |
| 硅基流动 | `Qwen/Qwen3-8B` | 8B dense | 256K | 轻量通用，响应快 | ✅ |
| 魔塔社区 | `Qwen/Qwen3-Coder-30B-A3B-Instruct` | 30B MoE (3B 激活) | 128K | 中端编码向：SWE-bench Lite 49.7%（88 百分位）；**唯一开箱即用**的 ModelScope 模型 | ✅ |
| 魔塔社区 | `deepseek-ai/DeepSeek-V4-Pro` | 1.6T MoE (49B 激活) | **1M** | 顶级推理 + **1M 超长上下文**（整仓库/长文档分析独一档）+ 中文世界知识第一（Chinese-SimpleQA 84.4，仅次 Gemini-3.1-Pro）；抽象推理偏弱（ARC-AGI-2 46%） | ❌ 需开通 |
| NVIDIA | `openai/gpt-oss-120b` | 117B MoE (5.1B 激活) | 128K | 数学/工具调用强（AIME 95.8、Codeforces 2463，接近 o4-mini）；**中文致命伤**（C-Eval 42% vs MMLU 90%） | ✅ |
| SenseNova | `glm-5.2` | — | 1M | 智谱旗舰长程任务：1M 上下文端到端开发管线 | ✅ |
| SenseNova | `deepseek-v4-flash` | — | 1M | DeepSeek 高性能对话（thinking/非 thinking、工具调用） | ✅ |
| SenseNova | `sensenova-6.8-flash-lite` | — | 256K | 新一代轻量多模态（文本+图像） | ✅ |
| SenseNova | `sensenova-6.7-flash-lite` | — | 256K | 轻量多模态智能体（文本+图像） | ✅ |
| Cloudflare | `@cf/zai-org/glm-4.7-flash` | — | 131K | 131K 上下文，**工具调用/agent 完整兼容**（CF 端实测最佳） | ✅ |
| Cloudflare | `@cf/openai/gpt-oss-120b` | 117B MoE (5.1B 激活) | 128K | 编码/数学强，但**多轮工具历史回传不兼容**（单轮可用） | ⚠️ |
| Cloudflare | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 70B | 24K（实测） | 最强 Llama 3.3，上下文小 | ✅ |
| Cloudflare | `@cf/qwen/qwen2.5-coder-32b-instruct` | 32B | 32K（实测） | 代码专用，工具调用为 XML 文本（非标准） | ⚠️ |
| Cloudflare | `@cf/google/gemma-4-26b-a4b-it` | 26B MoE (4B 激活) | 128K | 多模态（文本+图像） | ✅ |

**场景选择矩阵：**

| 场景 | 选它 |
|---|---|
| 日常编码 / agent 开发（默认主力） | **硅基 Nex-N2-Pro**（免费 + 综合最强） |
| 超长上下文 / 长程开发管线 | SenseNova `glm-5.2`（开箱即用）或魔塔 `DeepSeek-V4-Pro`（需开通额度） |
| 中文任务 | Nex-N2-Pro 或 DeepSeek-V4-Pro（**勿用 GPT-OSS-120B**） |
| 多模态（文本+图像） | SenseNova `sensenova-6.8-flash-lite` 或 Cloudflare `gemma-4-26b` |
| 英文数学、结构化输出 | **NVIDIA GPT-OSS-120B** |
| 海外网络兜底 / agent 工作流 | **Cloudflare `glm-4.7-flash`**（额度独立，工具调用完整兼容） |
| 限流兜底、轻量快速 | ModelScope Qwen3-Coder-30B / 硅基 Qwen3-8B |

**推荐组合**：主力 `siliconflow/nex-agi/Nex-N2-Pro` + 兜底 `modelscope/Qwen/Qwen3-Coder-30B-A3B-Instruct`（额度独立，主力限流时顶上）；长上下文/多模态需求切 SenseNova，特殊场景按需切换。

⚠️ 各平台免费额度均注明 "limited time"，模型可能随时下架/改名/转付费（NVIDIA 实测已下架 3 个模型），且免费期会话数据可能被用于改进模型，**勿发敏感内容、勿当生产依赖**。

## opencode 原生集成

上述 `sensenova` provider 也可通过 [opencode 自定义 provider](https://opencode.ai/docs/providers) 直接配置，**无需本扩展**。opencode 原生集成走 `@ai-sdk/openai-compatible`，不依赖自定义 streamSimple，但也不含扩展内置的 `cleanBody` 消息清洗（合并 system 消息、删 `content: null`）。

### Cloudflare Workers AI（内置 provider，零配置）

opencode **原生内置** `cloudflare-workers-ai` provider，只需设置环境变量（与 pi 扩展共用）：

```bash
export CLOUDFLARE_ACCOUNT_ID=your-32-character-account-id
export CLOUDFLARE_API_KEY=your-api-token
```

TUI 内 `/models` 即可看到 `cloudflare-workers-ai/@cf/...` 全部免费模型。为避免误用付费额度，建议在配置中 blacklist 付费模型（本仓库 README 上方配置示例已含）：

```json
{
  "provider": {
    "cloudflare-workers-ai": {
      "blacklist": [
        "@cf/deepseek-ai/deepseek-v4-flash-0731",
        "@cf/deepseek-ai/deepseek-v4-pro-0813",
        "@cf/zai-org/glm-5.2",
        "@cf/moonshotai/kimi-k2.6",
        "@cf/moonshotai/kimi-k2.7-code"
      ]
    }
  }
}
```

```bash
# CLI
opencode run -m cloudflare-workers-ai/@cf/openai/gpt-oss-120b "你好"
opencode run -m cloudflare-workers-ai/@cf/qwen/qwen2.5-coder-32b-instruct "你好"
```

### 配置

`~/.config/opencode/opencode.json`（全局）或 `opencode.json`（项目级）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "sensenova": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "SenseNova (商汤日日新)",
      "options": {
        "baseURL": "https://token.sensenova.cn/v1",
        "apiKey": "{env:SENSENOVA_API_KEY}"
      },
      "models": {
        "sensenova-6.7-flash-lite": {
          "name": "SenseNova 6.7 Flash-Lite",
          "limit": { "context": 262144, "output": 65536 },
          "reasoning": true,
          "attachment": true,
          "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        },
        "sensenova-6.8-flash-lite": {
          "name": "SenseNova 6.8 Flash-Lite",
          "limit": { "context": 262144, "output": 65536 },
          "reasoning": true,
          "attachment": true,
          "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        },
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash (via SenseNova)",
          "limit": { "context": 1048576, "output": 65536 },
          "reasoning": true,
          "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        },
        "glm-5.2": {
          "name": "GLM-5.2 (via SenseNova)",
          "limit": { "context": 1048576, "output": 131072 },
          "reasoning": true,
          "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        }
      }
    },
    "siliconflow": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "硅基流动 (SiliconFlow)",
      "options": {
        "baseURL": "https://api.siliconflow.cn/v1",
        "apiKey": "{env:SILICONFLOW_API_KEY}"
      },
      "models": {
        "nex-agi/Nex-N2-Pro": {
          "name": "Nex-N2-Pro (397B MoE, 免费)",
          "limit": { "context": 262144, "output": 65536 },
          "reasoning": true, "tool_call": true, "attachment": true,
          "cost": { "input": 0, "output": 0 }
        },
        "Qwen/Qwen3-8B": {
          "name": "Qwen3-8B (免费)",
          "limit": { "context": 262144, "output": 65536 },
          "reasoning": true, "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        }
      }
    },
    "modelscope": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "魔塔社区 (ModelScope)",
      "options": {
        "baseURL": "https://api-inference.modelscope.cn/v1",
        "apiKey": "{env:MODELSCOPE_API_KEY}"
      },
      "models": {
        "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
          "name": "Qwen3-Coder-30B",
          "limit": { "context": 131072, "output": 65536 },
          "reasoning": true, "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        },
        "deepseek-ai/DeepSeek-V4-Pro": {
          "name": "DeepSeek V4 Pro (需在控制台开通额度)",
          "limit": { "context": 1048576, "output": 65536 },
          "reasoning": true, "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        }
      }
    },
    "nvidia": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA NIM",
      "options": {
        "baseURL": "https://integrate.api.nvidia.com/v1",
        "apiKey": "{env:NVIDIA_NIM_API_KEY}"
      },
      "models": {
        "openai/gpt-oss-120b": {
          "name": "GPT-OSS 120B",
          "limit": { "context": 131072, "output": 65536 },
          "reasoning": true, "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        }
      }
    }
  }
}
```

### 使用

```bash
# CLI
opencode run -m sensenova/sensenova-6.7-flash-lite "你好"
opencode run -m siliconflow/nex-agi/Nex-N2-Pro "你好"
opencode run -m modelscope/Qwen/Qwen3-Coder-30B-A3B-Instruct "你好"
opencode run -m nvidia/openai/gpt-oss-120b "你好"

# 设为默认模型
opencode.json → "model": "sensenova/glm-5.2"
```

TUI 内 `Ctrl+O` 选 provider 后用 `Ctrl+P` 切换模型。

### 与 pi 扩展的差异

| 维度 | pi 扩展 (`pi-opencode-native`) | opencode 原生 |
|---|---|---|
| 底层 | 自定义 streamSimple + fetch | `@ai-sdk/openai-compatible` |
| 消息清洗 | 内置 `cleanBody`（合并 system、删 `content: null`） | 无（AI SDK 默认行为） |
| Scope | 仅 pi 可用 | opencode TUI/CLI 可用 |
| 依赖 | 零外部依赖 | 需 `@ai-sdk/openai-compatible`（opencode 自动安装） |

opencode 原生方式不经过 `cleanBody`，但实测标准对话/工具调用均正常；若遇到 `Errors in message queue response` 400 错误，说明 SenseNova 网关拒绝了某字段，建议换用 pi 扩展（内置清洗）或避免使用 structured output 等特性。

## 注意事项

1. **模型歧义**：若机器上也配置了 pi 内置 `opencode` provider 且带 key，裸 `--model deepseek-v4-flash-free` 会报 "ambiguous across providers"。解决：显式 `--provider opencode-fix`，或删除内置 opencode 的 key，或将 defaultProvider 设为 `opencode-fix`。
2. **限流是共享的**：匿名 `public` key 的免费额度是全 Zen 用户共享的（社区实测约 200 请求/天兜底，官方未公布固定配额），到达后返回 429 `FreeUsageLimitError`，需等待重置。人越多额度越紧张。
3. **UA 门可能变化**：本扩展写死 `User-Agent: opencode/1.15.5`。OpenCode 官方若调整版本号或免费门控策略，免费通道可能失效，需同步更新本文件中的 `OPENCODE_STATIC_HEADERS`。
4. **数据条款**：免费模型的免费期内，**提交的数据可能被用于改进模型**（官方隐私声明明确例外）。切勿发送敏感/机密内容。`nemotron-*` 为 NVIDIA 试用端点，禁止提交个人或机密数据，会话会被记录。
5. **免费是限时的**：官方措辞为 "available for a limited time"，模型可能随时下架、改名或转为付费，不适合作为生产依赖。
6. **单文件可审计**：整个扩展就是一个 `.mjs` 文件，使用前建议通读确认无异常行为。
7. **代理会导致 500**：Zen API 请求**不能走 HTTP 代理**（实测经 v2rayN/Clash 等代理转发返回 500 Internal server error，直连正常）。若系统全局代理已开启（Windows WinINET），node/bun 的 fetch 默认不读系统代理所以不受影响，但请勿为此扩展显式设置 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量指向代理。
8. **DeepSeek V4 思维模式回传**：`deepseek-v4-flash-free` 思维模式开启时，DeepSeek 要求历史中 assistant 消息（尤其带 `tool_calls` 的轮次）必须回传 `reasoning_content`，缺失即报 `400 The reasoning_content in the thinking mode must be passed back to the API`。本扩展已把 pi 内部 thinking 块转回顶层 `reasoning_content` 字段随历史回传（空字符串也保留，工具调用轮次强制携带）。
9. **npm 发布与 token 安全**：发布到 npm 需要账号 2FA。建议在 npm 网页生成 granular access token 并勾选 *Bypass 2FA on publish*，存为环境变量 `NPM_BYPASS_TOKEN`，再写入本地 `~/.npmrc` 的 `_authToken` 供 `npm publish` 使用（免验证码）。**`~/.npmrc` 内含可绕过 2FA 的明文 token，切勿提交到任何仓库或分享给他人**；若将 home 配置纳入 git 管理（dotfiles 仓库），务必先把 `~/.npmrc` 加入 `.gitignore`。
10. **package.json 的 UTF-8 BOM（1.0.2 已修复）**：1.0.0/1.0.1 发布到 npm 的 `package.json` 首行带 UTF-8 BOM。pi 的 `readPiManifest` 用裸 `JSON.parse` 解析该文件，BOM 会令解析抛错并被静默忽略，导致整个扩展不加载（`/model` 里看不到 `opencode-fix`/`sensenova` 等任何 provider）。1.0.2 起已去掉 BOM；若 `pi install` 后看不到 provider，请 `pi update --extensions` 确认装的是 1.0.2+。pi 侧的健壮性问题已提交：[earendil-works/pi#8310](https://github.com/earendil-works/pi/issues/8310)。

## License

MIT