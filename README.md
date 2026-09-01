# pi-cn-free-model-providers

让 [pi](https://github.com/Codeks/pi)（AI 编码助手 CLI）面向中国大陆免费用户，通过原生通道接入 **OpenCode Zen** 与 **SenseNova（商汤日日新）** 两个当前提供免费额度的渠道。平台免费政策可能变化，模型会自动进行实时目录校验。

## 问题背景

OpenCode Zen 的免费模型由上游 "Console" 推理提供商托管，其**按 `User-Agent` 头**决定是否放行免费容量：

- 请求带 `User-Agent: opencode/...` → 放行（200）
- 请求带 `curl`、`OpenAI/JS` 等非 opencode UA → 拒绝（429 `FreeUsageLimitError`）

pi 内置的 opencode provider 不使用 opencode UA，因此直接调用免费模型必然 429。本扩展注册了一个**自包含的 provider**（`opencode-zen`），用原生头（`User-Agent: opencode/1.15.5` + `x-opencode-client` + `x-opencode-session/request` ULID ID）发起请求，同时把 pi 内部消息格式正确转换为 OpenAI 兼容格式（`developer`→`system`、thinking 块转回 assistant 消息的 `reasoning_content`、tool 消息转 `role: "tool"` 等）。

**零外部依赖**：不 import pi-ai（pi 是单文件 bun 打包，磁盘上无法解析该模块），自带 SSE 解析与事件流。

## 启动行为：模型发现不阻塞 pi 启动

扩展在加载时**立即**用内置白名单（或上次的本地缓存）注册全部 provider 与模型，pi 启动后即可立即使用——**绝不**为等待网络发现而阻塞。修复前的版本会在工厂函数里 `await` 各 provider 的 `/v1/models`，导致 pi 启动卡 5–68 秒。

模型发现转为**后台**进行：

- 启动后用 `setTimeout` 触发一次 `verifyAndUpdateModels`：逐个 provider 拉取实时 `/v1/models` 与内置白名单做交集（去漂移），Zen 还会逐个探测免费状态；已转付费、下线或改名的模型会在后台自动剔除；
- 每个请求带硬超时（单请求 5–8s，整体 45s 上限），任一 provider 失败/超时只会保留已有列表，绝不让注册中断；
- 发现结果**热更新**目录（pi 在加载后注册 provider 会立即生效，无需 `/reload`）；
- 结果持久化到 `~/.pi/cache/opencode-native-models.json`（24h TTL）。下次启动即使**完全离线**，也能用缓存里的模型列表秒开；缓存过期或缺失时回退到内置白名单。

> 行为等价于 agnes / sensenova 扩展的 `refreshModels` 模式；本扩展一次注册多个供应商（含 OpenCode Zen 免费通道），故用「后台热重注册」实现同样的非阻塞效果。
>
> **动态清单说明**：README 中的模型表是人工维护的能力/定位快照，不作为运行时可用性的唯一依据。启动后的实时目录和免费状态探测会自动剔除已下线或转付费模型；供应商价格变化由 GitHub Actions 巡检并通过 Issue 提醒，确认后再同步更新代码和 README。

## 安装

### 方式一：本地文件

```bash
pi install /path/to/pi-cn-free-model-providers-ext.mjs
```

### 方式二：GitHub（推荐）

仓库已公开：<https://github.com/pgciq/pi-cn-free-model-providers>

```bash
pi install git:github.com/pgciq/pi-cn-free-model-providers
# 或
pi install https://github.com/pgciq/pi-cn-free-model-providers
```

> 扩展始终优先以 `pi-cn-free-model-providers-ext.mjs` 为入口文件（仓库根目录），`pi install` 会自动识别；若需指定分支可追加 `#master`。

### 方式三：npm

npm 包已发布：<https://www.npmjs.com/package/pi-cn-free-model-providers>

当前版本：`1.0.17`。安装命令：

```bash
pi install npm:pi-cn-free-model-providers
```

#### npm 发布

仓库已配置 `.github/workflows/publish-npm.yml`，使用 npm **Trusted Publisher（OIDC）** 发布，不需要配置 `NPM_TOKEN`。

发布流程采用 `v*` Git tag 触发：

```bash
# 下一版本示例：先递增 package.json 的 version，例如改为 1.0.18
npm version 1.0.18 --no-git-tag-version
git add package.json
git commit -m "chore: bump version to 1.0.18"
git push origin master
git tag v1.0.18
git push origin v1.0.18
```

推送新的 `v*` 标签后，GitHub Actions 会自动校验包名、入口文件和 npm 打包内容，并使用 OIDC + `--provenance` 发布公开包。npm Trusted Publisher 配置中的仓库、workflow 文件名必须与当前项目一致：

```text
Repository: pgciq/pi-cn-free-model-providers
Workflow: .github/workflows/publish-npm.yml
```

## 配置

### 1. API key

> 从 **1.0.4** 起，每个 provider 都在注册时自声明 `apiKey: "public"`（匿名占位），pi 因此始终视其为已配置 key，**无需再手动编辑 `~/.pi/agent/auth.json`**，装完即可用。`public` 只是占位，实际请求按下面的优先级解析真实 key。

key 解析优先级（从高到低）：

1. **环境变量**（推荐，不把 key 写进配置文件）：`OPENCODE_API_KEY`、`SENSENOVA_API_KEY`、`SILICONFLOW_API_KEY`、`MODELSCOPE_API_KEY`、`NVIDIA_NIM_API_KEY`、`CLOUDFLARE_API_KEY`（+ `CLOUDFLARE_ACCOUNT_ID`）、`AGNES_API_KEY`、`AGNES_CN_API_KEY`
2. `~/.pi/agent/auth.json` 中对应 provider 条目（**非** `public` 的值）
3. 兜底匿名 `public`（仅 Zen 免费模型可用，其余 provider 需真实 key）

```bash
# 方式 A：环境变量（推荐，账号 key）
export OPENCODE_API_KEY=sk-xxx

# 方式 B（可选）：auth.json 存真实 key
cat ~/.pi/agent/auth.json
# { "opencode-zen": { "type": "api_key", "key": "sk-xxx" } }
```

> ⚠️ `auth.json` 条目现在完全可选。若想为某个 provider 存真实 key，写入非 `public` 的值即可（优先级高于匿名兜底、低于环境变量）。Zen 免费模型不写任何 key 也能匿名使用。

### 2. 默认 provider（可选，推荐）

`~/.pi/agent/settings.json`：

```json
{
  "defaultProvider": "opencode-zen",
  "defaultModel": "big-pickle"
}
```

## 使用

```bash
# 一次性问答
pi -p "Reply with exactly OK"

# 交互式
pi

# 指定模型
pi --model opencode-zen/big-pickle
```

### 可用免费模型（opencode-zen）

实时探测结果（2026-09-01，经本地 relay 直连 Zen 网关核验，全部 `cost: 0`）：

| 模型 ID | 说明 | 上下文 | 输出上限 |
|---|---|---|---|
| `muse-spark-1.2-contributor-free` | 仅 Responses API（`/chat/completions` 返回 500），文本+图像 | 1M | 131,072 |
| `big-pickle` | 匿名 stealth 模型（社区确认底层≈DeepSeek V4 Flash） | 200K | 131,072 |
| `mimo-v2.5-free` | 多模态系列的文本档 | 200K | 131,072 |
| `ling-3.0-flash-fin-free` | 新上线免费模型（替代已下线的 `hy3-free`） | 256K | 65,536 |
| `laguna-s-2.1-free` | 长时程 agent 编码 | 256K | 131,072 |
| `nemotron-3-ultra-free` | 超长上下文（1M） | 1M | 131,072 |
| `nemotron-3.5-lightning-free` | 高速执行 | 1M | 131,072 |

> 下线/不可用：`hy3-free` 已从 `/v1/models` 消失，调用返回 `Model hy3-free is not supported`，已移出白名单。`deepseek-v4-flash-free` 仍在目录里但调用返回 `Model is unavailable.`，因此不收录。`x-preview-f-free`（Ox Alpha）此前已转付费并移除。
>
> 🔭 **变动监听**：`.github/workflows/opencode-zen-watch.yml` 每日巡检 `/v1/models`，并使用匿名 `public` key 对在册模型做最小探测；模型消失或返回鉴权/计费拒绝时自动创建或更新维护 Issue。网络错误、429 和 5xx 只记为 UNKNOWN，不会误判为付费。

TUI 内 **Ctrl+P** 循环切换模型。

## SenseNova（商汤日日新）

接入[商汤日日新平台](https://platform.sensenova.cn/)的 OpenAI 兼容网关（`https://token.sensenova.cn/v1`），免费公测套餐可用。key 解析优先级：环境变量 `SENSENOVA_API_KEY` → `~/.pi/agent/auth.json` 中 `sensenova` 条目 → 匿名占位。

```bash
# 在 https://platform.sensenova.cn/console/keys 申请 key
export SENSENOVA_API_KEY=sk-xxx
# 或用 pi auth 存入 ~/.pi/agent/auth.json
```

### 可用模型

数据源：`GET /v1/models`（带 key）返回的权威目录，全部 `pricing.prompt = pricing.completion = 0`。上下文/输出上限取自目录的 `context_length` / `max_output_length`，插件启动时用实时值覆盖白名单里的静态数字。

| 模型 ID | 说明 | 上下文 | 输出上限 |
|---|---|---|---|
| `sensenova-6.7-flash-lite` | 轻量多模态智能体（文本+图像） | 256K | 65,536 |
| `sensenova-6.8-flash-lite` | 新一代轻量多模态智能体（文本+图像） | 256K | 65,536 |
| `deepseek-v4-flash` | DeepSeek 高性能对话（thinking/非 thinking、工具调用） | 1M | 65,536 |
| `deepseek-v4-pro` | DeepSeek 旗舰推理（2026-09 实测免费可用） | 1M | 65,536 |
| `glm-5.2` | 智谱旗舰长程任务模型 | 1M | 131,072 |
| `kimi-k3` | Moonshot 旗舰（2026-09 实测免费可用） | 1M | 65,536 |
| `sensenova-u1-fast` | 图像生成专用（`/v1/images/generations`） | 256K | 65,536 |
| `sensenova-u1.5-lite` | 图像生成/编辑（`/v1/images/generations`、`/v1/images/edits`） | 256K | 65,536 |

`sensenova-u1-fast` 和 `sensenova-u1.5-lite` 注册为图像模型，不会误走 chat completions；生成结果保存到 `.pi/generated-images/`，路径在 TUI 中渲染为可点击的 `file://` 链接。

> 🔭 **变动监听**：`.github/workflows/sensenova-watch.yml` 每周巡检（04:59 UTC），走带密钥的权威目录 `GET /v1/models`：在册模型消失＝下线/改名；pricing 非 0＝免费档撤销；新 id 出现＝新模型上线。需配置 secret `SENSENOVA_API_KEY`；基线存 `.github/watch-state/`。

### 使用

```bash
pi -p --provider sensenova --model sensenova/sensenova-6.8-flash-lite "你好"
pi --provider sensenova --model sensenova/glm-5.2
```

### SenseNova 特有的坑（已内置处理）

网关 schema 比 OpenAI 更严，**官方参数表未列出的字段一律拒收**（报错被替换成无信息量的 `Errors in message queue response`）。扩展内置 `cleanBody` 已处理：合并多条 `system` 消息、删除 `assistant.content: null`。`max_tokens` 按**每个模型**校验（`sensenova-6.8-flash-lite` 拒绝 65537，`glm-5.2` 接受 131072，`deepseek-v4-pro` 上限 393216），因此以模型注册值为准而非一个全局常量。思维链以 `delta.reasoning` 回传（不是 `reasoning_content`），扩展两种都接收。

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
        },
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro (via SenseNova)",
          "limit": { "context": 1048576, "output": 65536 },
          "reasoning": true,
          "tool_call": true,
          "cost": { "input": 0, "output": 0 }
        },
        "kimi-k3": {
          "name": "Kimi K3 (via SenseNova)",
          "limit": { "context": 1048576, "output": 65536 },
          "reasoning": true,
          "tool_call": true,
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

# 设为默认模型
opencode.json → "model": "sensenova/glm-5.2"
```

TUI 内 `Ctrl+O` 选 provider 后用 `Ctrl+P` 切换模型。

### 与 pi 扩展的差异

| 维度 | pi 扩展 (`pi-cn-free-model-providers`) | opencode 原生 |
|---|---|---|
| 底层 | 自定义 streamSimple + fetch | `@ai-sdk/openai-compatible` |
| 消息清洗 | 内置 `cleanBody`（合并 system、删 `content: null`） | 无（AI SDK 默认行为） |
| Scope | 仅 pi 可用 | opencode TUI/CLI 可用 |
| 依赖 | 零外部依赖 | 需 `@ai-sdk/openai-compatible`（opencode 自动安装） |

opencode 原生方式不经过 `cleanBody`，但实测标准对话/工具调用均正常；若遇到 `Errors in message queue response` 400 错误，说明 SenseNova 网关拒绝了某字段，建议换用 pi 扩展（内置清洗）或避免使用 structured output 等特性。

## 注意事项

1. **模型歧义**：若机器上也配置了 pi 内置 `opencode` provider 且带 key，裸 `--model big-pickle` 等模型 ID 会报 "ambiguous across providers"。解决：显式 `--provider opencode-zen`，或删除内置 opencode 的 key，或将 defaultProvider 设为 `opencode-zen`。
2. **限流是共享的**：匿名 `public` key 的免费额度是全 Zen 用户共享的（社区实测约 200 请求/天兜底，官方未公布固定配额），到达后返回 429 `FreeUsageLimitError`，需等待重置。人越多额度越紧张。
3. **UA 门可能变化**：本扩展写死 `User-Agent: opencode/1.15.5`。OpenCode 官方若调整版本号或免费门控策略，免费通道可能失效，需同步更新本文件中的 `OPENCODE_STATIC_HEADERS`。
4. **数据条款**：免费模型的免费期内，**提交的数据可能被用于改进模型**（官方隐私声明明确例外）。切勿发送敏感/机密内容。
5. **免费是限时的**：官方措辞为 "available for a limited time"，模型可能随时下架、改名或转为付费，不适合作为生产依赖。
6. **单文件可审计**：整个扩展就是一个 `.mjs` 文件，使用前建议通读确认无异常行为。
7. **代理会导致 500**：Zen API 请求**不能走 HTTP 代理**（实测经 v2rayN/Clash 等代理转发返回 500 Internal server error，直连正常）。若系统全局代理已开启（Windows WinINET），node/bun 的 fetch 默认不读系统代理所以不受影响，但请勿为此扩展显式设置 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量指向代理。
8. **DeepSeek V4 思维模式回传**：`deepseek-v4-flash`（通过 SenseNova 等）思维模式开启时，DeepSeek 要求历史中 assistant 消息（尤其带 `tool_calls` 的轮次）必须回传 `reasoning_content`，缺失即报 `400 The reasoning_content in the thinking mode must be passed back to the API`。本扩展已把 pi 内部 thinking 块转回顶层 `reasoning_content` 字段随历史回传（空字符串也保留，工具调用轮次强制携带）。
9. **npm 发布与 Trusted Publisher**：npm 发布由 `.github/workflows/publish-npm.yml` 负责，采用 GitHub Actions OIDC Trusted Publisher，不需要长期保存 `NPM_TOKEN`。发布前递增 `package.json` 版本号，再推送匹配的 `v*` tag；Trusted Publisher 必须绑定仓库 `pgciq/pi-cn-free-model-providers` 和 workflow `.github/workflows/publish-npm.yml`。
10. **package.json 的 UTF-8 BOM（1.0.2 已修复）**：1.0.0/1.0.1 发布到 npm 的 `package.json` 首行带 UTF-8 BOM。pi 的 `readPiManifest` 用裸 `JSON.parse` 解析该文件，BOM 会令解析抛错并被静默忽略，导致整个扩展不加载（`/model` 里看不到 `opencode-zen`/`sensenova` 等任何 provider）。1.0.2 起已去掉 BOM；若 `pi install` 后看不到 provider，请 `pi update --extensions` 确认装的是 1.0.2+。pi 侧的健壮性问题已提交：[earendil-works/pi#8310](https://github.com/earendil-works/pi/issues/8310)。
11. **无需手动配置 auth.json（1.0.4 起）**：旧版要求 `~/.pi/agent/auth.json` 中为每个 provider 添加 `{ "type": "api_key", "key": "public" }` 条目，否则 pi 找不到 key 会直接跳过扩展（报 `No API key found for <provider>`）。1.0.4 起每个 provider 自注册 `apiKey: "public"`（匿名占位），pi 视其为已配置 key，装完即可见可用；要使用账号 key 直接用环境变量即可。重装插件后无需再改 auth.json。

12. **免费清单自动去漂移**：启动后会在**后台**拉取各 provider 的 `/v1/models` 实时列表，与内置白名单做交集，**自动剔除已下架/改名的模型**。三种结果严格区分：拉取失败 → 保留内置白名单（网络故障绝不缩表）；拉取成功且有交集 → 用实时元数据（`context_length` / `max_output_length` / `input_modalities`）覆盖白名单里的静态数字；拉取成功但**交集为空** → 返回空列表。最后这种以前会退回白名单，结果是上游把所有模型下架后插件还在注册不存在的模型、每次调用都失败且看不出原因。

13. **Zen 免费模型自动发现 + 免费状态复核**：Zen 在启动后于**后台**对实时列表中的每个模型发一个 `max_tokens: 1` 的探测请求（12 路并发）。探测**始终先用匿名 `public` key**——免费模型返回 200，付费模型在鉴权阶段就被 401/402/403 拒绝，**不产生任何计费**；只有匿名两条传输都无结论（例如共享额度 429）时，才在配了真实 `OPENCODE_API_KEY` 的情况下改用「看响应 `cost` 是否为 0」的判定（这种判定会让付费模型各产生 1 个 output token 的费用）。结果分四档：
    - `free` — 保留或新增。不在白名单的新免费模型无需等发版即可使用；它的上下文/输出上限**从网关自报的超额报错里解析**（`This model supports at most N completion tokens` / `This endpoint's maximum context length is N tokens`），不再是固定的 128K/64K 猜测。
    - `paid` — 剔除（避免匿名下报错、配了真实 key 时被误扣费）。
    - `gone` — 剔除。网关自己说「没这个模型」（`Model xxx is not supported`、`Model is unavailable.`，或 404），且两条传输都这么说才算。注意与瞬时故障区分：`Endpoint is unavailable.`（503）不算。
    - `unknown` — 网络故障、5xx、限流。**白名单模型一律保留**（曾出现 `laguna-s-2.1-free` 偶发 503 就让它整个会话从 `/model` 里消失）；非白名单的 unknown 不新增，因为对它一无所知。
    全部无结论时回退到「白名单 ∩ 实时列表」。白名单条目始终优先（元数据经手工核验，更精确）。

14. **探测有 6 小时缓存**：每次校验要对约 60 个 Zen 模型各发一个请求，而免费额度是全体匿名用户共享的，每次启动 pi 都重跑等于把额度花在探测上。因此磁盘缓存在 6 小时内视为新鲜，直接跳过后台校验；需要立刻重跑用 `/model-refresh`。

15. **本地 relay 冷启动重试**：若 `OPENCODE_ZEN_BASE_URL` 指向本机 relay（绕区域门的方案），relay 可能还在启动中，此时目录拉取会失败并导致整轮 Zen 校验被跳过。对 loopback 地址会重试 5 次（间隔 2s）；远端网关不重试（那里的 5xx 是真故障）。

## 命令

- `/model-capabilities [image|video|audio|vision|reasoning|tools]` — 列出本扩展注册的全部 provider 下每个模型的能力；SenseNova 的 u1 图像模型走原生 endpoint。
- `/model-prices [provider]` — 查询已注册模型的 catalog 定价（USD/1M tokens、上下文窗口）。零值表示 curated catalog 标记为免费；没有真实价格时显示 `—`。
- `/model-usage` — 查询当前 Pi 进程累计的 token/cost 使用量。它是 session usage，不是各 provider 的后台账单；各 provider 没有统一 usage API。
- `/model-refresh` — 立刻重跑实时校验（忽略 6 小时缓存），完成后报告耗时。

## ModLens 视觉引擎切换

若安装了 [ModLens](https://github.com/liustack/modlens) 技能（`~/.agents/skills/modlens`），可通过以下命令在已配置的视觉引擎间切换：

```bash
# 查看当前状态
bash ~/.agents/skills/modlens/scripts/run.sh doctor

# 切换视觉引擎（推荐用 config use openai <槽位>，再设 provider openai）
# key 从环境变量读取（.zshrc 已配置，无需手动输入）

# --- 国内直连（无需代理） ---

# Agnes CN（免费，512K 上下文，默认首选）
bash ~/.agents/skills/modlens/scripts/run.sh config use openai cn
bash ~/.agents/skills/modlens/scripts/run.sh config set provider openai

# 智谱 GLM-4V Plus（需 key，环境变量 BIGMODEL_API_KEY）
bash ~/.agents/skills/modlens/scripts/run.sh config use openai zhipu
bash ~/.agents/skills/modlens/scripts/run.sh config set provider openai

# 商汤 SenseNova 6.8 Flash Lite（免费多模态，环境变量 SENSENOVA_API_KEY）
bash ~/.agents/skills/modlens/scripts/run.sh config use openai sensenova
bash ~/.agents/skills/modlens/scripts/run.sh config set provider openai

# 阿里通义千问 Qwen-VL（需 key，环境变量 ALI_API_KEY，DashScope 平台）
bash ~/.agents/skills/modlens/scripts/run.sh config use openai dashscope
bash ~/.agents/skills/modlens/scripts/run.sh config set provider openai

# 硅基流动 Qwen3-VL-30B-A3B（环境变量 SILICONFLOW_API_KEY）
bash ~/.agents/skills/modlens/scripts/run.sh config use openai siliconflow
bash ~/.agents/skills/modlens/scripts/run.sh config set provider openai

# Agnes 国际版（国内直连可用，比 CN 慢约一倍）
bash ~/.agents/skills/modlens/scripts/run.sh config use openai intl
bash ~/.agents/skills/modlens/scripts/run.sh config set provider openai

# --- 需代理 ---

# Gemini（免费，~1500次/天，需要代理访问 Google API）
bash ~/.agents/skills/modlens/scripts/run.sh config set provider gemini-api
```

各引擎对比：

| 引擎 | 模型 | 速度 | 布局分析 | 网络 | 实测 | 当前状态 |
|------|------|------|---------|------|------|---------|
| Agnes CN | agnes-2.5-flash | ~17-20s | 48 区域（详细） | 直连国内 | ✅ | ✅ 首选 |
| 智谱 | glm-4v-plus | ~21s | — | 直连国内 | ✅（需 `structuredOutput: true`） | 备选 |
| 商汤 | sensenova-6.8-flash-lite | ~27s | 多模态 | 直连国内 | ✅ | 备选 |
| 阿里通义千问 | qwen3-vl-flash | — | — | 直连国内 | ❌ VL 免费额度耗尽（图像生成额度有剩余） | 备选 |
| 硅基流动 | Qwen3-VL-30B-A3B | ~39s | 开源视觉 MoE | 直连国内 | ✅ | 备选 |
| Gemini | gemini-3.6-flash | ~16s | 4 区域（简洁） | 需代理 | ✅ | 备选 |
| Agnes 国际版 | agnes-2.5-flash | ~35s | 48 区域（详细） | 国内直连（慢） | ✅ | 备选 |

> 所有 openai 槽位的 key 均从环境变量读取（`AGNES_CN_API_KEY`、`AGNES_API_KEY`、`BIGMODEL_API_KEY`、`SENSENOVA_API_KEY`、`SILICONFLOW_API_KEY`、`ALI_API_KEY`），配置在 `~/.zshrc` 中。

## License

MIT