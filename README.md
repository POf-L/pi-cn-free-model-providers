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

### 方式二：GitHub（推荐）

仓库已公开：<https://github.com/pgciq/pi-opencode-native>

```bash
pi install git:github.com/pgciq/pi-opencode-native
# 或
pi install https://github.com/pgciq/pi-opencode-native
```

> 扩展始终优先以 `pi-opencode-native-ext.mjs` 为入口文件（仓库根目录），`pi install` 会自动识别；若需指定分支可追加 `#master`。

### 方式三：npm

npm 包**尚未发布**（`pi-opencode-native` 在 registry 中不存在）。发布后可使用：

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

除 Zen 免费模型外，本扩展还注册了 **4 个第三方免费/低成本供应商**。所有 provider 的 key 解析优先级一致：环境变量 → auth.json 中非 `public` 的 key → 匿名占位（`key: "public"` 会被忽略）。auth.json 中相应条目**不要删除**——pi 找不到该 provider 的 key 时会直接跳过扩展。

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

### 如何选择

4 个额外供应商全部免费模型统一对比（基准数据截至 2026-08，来源：官方技术报告 + 独立评测）：

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

**场景选择矩阵：**

| 场景 | 选它 |
|---|---|
| 日常编码 / agent 开发（默认主力） | **硅基 Nex-N2-Pro**（免费 + 综合最强） |
| 超长上下文 / 长程开发管线 | SenseNova `glm-5.2`（开箱即用）或魔塔 `DeepSeek-V4-Pro`（需开通额度） |
| 中文任务 | Nex-N2-Pro 或 DeepSeek-V4-Pro（**勿用 GPT-OSS-120B**） |
| 多模态（文本+图像） | SenseNova `sensenova-6.8-flash-lite` |
| 英文数学、结构化输出 | **NVIDIA GPT-OSS-120B** |
| 限流兜底、轻量快速 | ModelScope Qwen3-Coder-30B / 硅基 Qwen3-8B |

**推荐组合**：主力 `siliconflow/nex-agi/Nex-N2-Pro` + 兜底 `modelscope/Qwen/Qwen3-Coder-30B-A3B-Instruct`（额度独立，主力限流时顶上）；长上下文/多模态需求切 SenseNova，特殊场景按需切换。

⚠️ 各平台免费额度均注明 "limited time"，模型可能随时下架/改名/转付费（NVIDIA 实测已下架 3 个模型），且免费期会话数据可能被用于改进模型，**勿发敏感内容、勿当生产依赖**。

## opencode 原生集成

上述 `sensenova` provider 也可通过 [opencode 自定义 provider](https://opencode.ai/docs/providers) 直接配置，**无需本扩展**。opencode 原生集成走 `@ai-sdk/openai-compatible`，不依赖自定义 streamSimple，但也不含扩展内置的 `cleanBody` 消息清洗（合并 system 消息、删 `content: null`）。

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

## License

MIT