// OpenCode Zen native streamSimple for pi — zero pi-ai dependency.
// Fixes pi's 429 on free models by sending OpenCode-native headers
// (x-opencode-client: cli + ses_/msg_ ULID ids) and converting
// developer->system roles (upstream only accepts system/user/assistant).
import { randomBytes } from "node:crypto";

// ── Push-based stream (copied from pi-free lib/assistant-message-event-stream.js) ──
class EventStream {
  queue = [];
  waiting = [];
  done = false;
  constructor(isComplete, extractResult) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }
  push(event) {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }
  end(result) {
    this.done = true;
    if (result !== undefined) this.resolveFinalResult(result);
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) yield this.queue.shift();
      else if (this.done) return;
      else {
        const result = await new Promise((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }
  result() {
    return this.finalResultPromise;
  }
}
class AssistantMessageEventStream extends EventStream {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      }
    );
  }
}

// ── OpenCode-native ID generation (ULID-style, same as pi-free) ──
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function generateOpenCodeId(prefix) {
  const ms = BigInt(Date.now());
  const timeHex = ms.toString(16).padStart(12, "0");
  const bytes = randomBytes(14);
  let suffix = "";
  for (let i = 0; i < 14; i++) suffix += BASE62[bytes[i] % 62];
  return `${prefix}${timeHex}${suffix}`;
}
const SESSION_ID = generateOpenCodeId("ses_");
const OPENCODE_STATIC_HEADERS = {
  "User-Agent": "opencode/1.15.5",
  "x-opencode-client": "cli",
};

// ── Message / tool normalization ──
function getContentText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return c.text;
        if (c.type === "thinking") return c.thinking;
        return "";
      })
      .join("");
  }
  return "";
}
function normalizeMessages(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (!m || typeof m !== "object") continue;
    // Skip failed assistant turns
    if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) continue;
    if (m.role === "developer") {
      out.push({ role: "system", content: getContentText(m) });
    } else if (m.role === "user") {
      let content;
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        const hasImage = m.content.some((c) => c.type === "image");
        if (hasImage) {
          content = m.content
            .map((c) => {
              if (c.type === "text") return { type: "text", text: c.text };
              if (c.type === "image") return { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } };
              return null;
            })
            .filter((p) => p !== null);
        } else {
          content = getContentText(m);
        }
      } else {
        content = "";
      }
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      let content = "";
      let reasoningContent = "";
      const toolCalls = [];
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "text") content += block.text;
          // Replay reasoning instead of dropping it: DeepSeek V4 thinking mode
          // requires `reasoning_content` echoed back on assistant messages in
          // history (mandatory on tool-call turns), or the API returns 400.
          // The zen gateway forwards the top-level field upstream.
          else if (block.type === "thinking") reasoningContent += block.thinking ?? "";
          else if (block.type === "toolCall") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments),
              },
            });
          }
        }
      } else {
        content = m.content || "";
      }
      const mapped = { role: "assistant", content: content || null };
      // Echo reasoning_content back on every assistant message (empty string
      // is still required for tool-call turns — DeepSeek rejects omission).
      if (reasoningContent !== "" || toolCalls.length > 0) mapped.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) mapped.tool_calls = toolCalls;
      out.push(mapped);
    } else if (m.role === "toolResult") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: getContentText(m) });
    }
    // drop anything else
  }
  return out;
}

// ── Tool normalization (pi internal -> OpenAI wire format) ──
function normalizeTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      // Already in wire format
      if (t.type === "function" && t.function?.name) return t;
      // pi internal format: { name, description, parameters }
      if (t.name) {
        return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
      }
      return null;
    })
    .filter(Boolean);
  return mapped.length > 0 ? mapped : undefined;
}

// ── SSE parsing ──
function processDelta(state, delta) {
  if (delta.reasoning_content) {
    if (state.thinkingBlockIndex === -1) {
      state.thinkingBlockIndex = state.output.content.length;
      state.output.content.push({ type: "thinking", thinking: "" });
      state.stream.push({ type: "thinking_start", contentIndex: state.thinkingBlockIndex, partial: state.output });
    }
    const block = state.output.content[state.thinkingBlockIndex];
    block.thinking += delta.reasoning_content;
    state.stream.push({ type: "thinking_delta", contentIndex: state.thinkingBlockIndex, delta: delta.reasoning_content, partial: state.output });
  }
  if (delta.content) {
    if (state.thinkingBlockIndex !== -1) {
      state.stream.push({ type: "thinking_end", contentIndex: state.thinkingBlockIndex, content: state.output.content[state.thinkingBlockIndex].thinking, partial: state.output });
      state.thinkingBlockIndex = -1;
    }
    if (state.contentBlockIndex === -1) {
      state.contentBlockIndex = state.output.content.length;
      state.output.content.push({ type: "text", text: "" });
      state.stream.push({ type: "text_start", contentIndex: state.contentBlockIndex, partial: state.output });
    }
    const block = state.output.content[state.contentBlockIndex];
    block.text += delta.content;
    state.stream.push({ type: "text_delta", contentIndex: state.contentBlockIndex, delta: delta.content, partial: state.output });
  }
  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state.toolCallsState[idx]) state.toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0, emittedStart: false };
      const t = state.toolCallsState[idx];
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name = tc.function.name;
      if (tc.function?.arguments) {
        t.arguments += tc.function.arguments;
        if (!t.emittedStart) {
          t.emittedStart = true;
          t.contentIndex = state.output.content.length;
          state.output.content.push({ type: "toolCall", id: t.id, name: t.name, arguments: {} });
          state.stream.push({ type: "toolcall_start", contentIndex: t.contentIndex, partial: state.output });
        }
        state.stream.push({ type: "toolcall_delta", contentIndex: t.contentIndex, delta: tc.function.arguments, partial: state.output });
      }
    }
  }
}
function finalizeToolCalls(state) {
  for (const t of state.toolCallsState) {
    if (t?.emittedStart) {
      let args = {};
      try { args = JSON.parse(t.arguments || "{}"); } catch {}
      state.output.content[t.contentIndex].arguments = args;
      state.stream.push({
        type: "toolcall_end",
        contentIndex: t.contentIndex,
        toolCall: { type: "toolCall", id: t.id, name: t.name, arguments: args },
        partial: state.output,
      });
    }
  }
}
function handleSSELine(state, line) {
  if (!line.startsWith("data:")) return false;
  const dataStr = line.slice(5).trim();
  if (dataStr === "[DONE]") return true;
  let parsed;
  try { parsed = JSON.parse(dataStr); } catch { return false; }
  if (parsed.error) throw new Error(`OpenCode SSE error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  if (parsed.usage) {
    const input = parsed.usage.prompt_tokens ?? 0;
    const output = parsed.usage.completion_tokens ?? 0;
    state.output.usage = {
      input,
      output,
      cacheRead: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
      totalTokens: parsed.usage.total_tokens ?? input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  if (parsed.choices && Array.isArray(parsed.choices) && parsed.choices.length > 0) {
    const choice = parsed.choices[0];
    if (choice.delta) processDelta(state, choice.delta);
    if (choice.finish_reason) state.output.stopReason = choice.finish_reason;
  }
  return false;
}
async function consumeSSEStream(state, reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) break;
      const line = buffer.substring(0, lineEnd).trim();
      buffer = buffer.substring(lineEnd + 1);
      const done2 = handleSSELine(state, line);
      if (done2) break;
    }
  }
}

// ── Shared output factory ──
function makeOutput(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// Factory for standard OpenAI-compatible providers (no special headers/schema).
// opts.maxTokens may be a number (all models) or a function (model) => number
// to let each model use its own registered limit.
// Provider-side model churn surfaces as distinctive upstream errors long before
// our curated lists get updated. Recognize them and attach an actionable hint:
// - 404 / "not found" / 已下线 → model deprecated or renamed;
// - insufficient-balance → if the model is curated as free, that label is stale
//   (it turned paid and just tried to bill the user). See also:
//   .github/workflows/siliconflow-watch.yml (weekly official-announcements poll).
function explainModelChurn(status, errText) {
  const t = String(errText).toLowerCase();
  if (
    status === 404 ||
    /model[\w-]{0,24}(not found|not exist|does not exist)/.test(t) ||
    /(已下线|已不再提供|不存在|deprecated|no longer available)/.test(t)
  ) {
    return "Hint: this model may have been deprecated/renamed by the provider — check 模型广场 (https://cloud.siliconflow.cn/me/models) and update the curated list.";
  }
  if (/insufficient[ _-]?balance|余额不足/.test(t)) {
    return "Hint: rejected for insufficient balance — if this model is labeled 免费 in the curated list, that label is stale (it has turned PAID). Update SILICONFLOW_MODELS accordingly.";
  }
  return "";
}

function makeOpenAIStream(baseUrl, envKey, opts = {}) {
  return function streamSimple(model, context, options) {
    const stream = new AssistantMessageEventStream();
    const output = makeOutput(model);
    const maxTokens = typeof opts.maxTokens === "function" ? opts.maxTokens(model) : (opts.maxTokens ?? 128000);
    const cfg = {
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      key: () => process.env[envKey] ?? (options?.apiKey && options.apiKey !== "public" ? options.apiKey : undefined),
      headers: () => ({}),
      maxTokens,
    };
    if (opts.cleanBody) cfg.cleanBody = opts.cleanBody;
    if (opts.enableThinking) cfg.enableThinking = true;
    run(stream, output, model, context, options, cfg);
    return stream;
  };
}

// ── Main streamSimple ──
function streamOpenCode(model, context, options) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  run(stream, output, model, context, options, {
    url: "https://opencode.ai/zen/v1/chat/completions",
    key: () => process.env.OPENCODE_API_KEY
      ?? (options?.apiKey && options.apiKey !== "public" ? options.apiKey : "public"),
    headers: () => ({
      ...OPENCODE_STATIC_HEADERS,
      "x-opencode-session": SESSION_ID,
      "x-opencode-request": generateOpenCodeId("msg_"),
    }),
    maxTokens: 128000,
  });
  return stream;
}

// SenseNova (商汤日日新) — OpenAI-compatible gateway with a strict schema.
// https://platform.sensenova.cn/docs — only listed fields are accepted;
// response_format is rejected, multiple system messages must be merged,
// assistant.content:null must be dropped, max_tokens <= 65536.
const streamSenseNova = makeOpenAIStream("https://token.sensenova.cn/v1", "SENSENOVA_API_KEY", {
  maxTokens: 65536,
  cleanBody: (body) => {
    const msgs = body.messages ?? [];
    const merged = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (m.role === "system" && last?.role === "system") {
        last.content = `${last.content}\n\n${m.content}`;
      } else {
        merged.push({ ...m });
      }
    }
    for (const m of merged) {
      if (m.role === "assistant" && m.content === null) delete m.content;
    }
    return { ...body, messages: merged };
  },
});

// Standard OpenAI-compatible providers
const streamSiliconFlow = makeOpenAIStream("https://api.siliconflow.cn/v1", "SILICONFLOW_API_KEY");
const streamModelScope = makeOpenAIStream("https://api-inference.modelscope.cn/v1", "MODELSCOPE_API_KEY", {
  maxTokens: 65536,
});
const streamNvidia = makeOpenAIStream("https://integrate.api.nvidia.com/v1", "NVIDIA_NIM_API_KEY");

// Agnes AI — OpenAI-compatible gateway (apihub.agnes-ai.com = 国际站,
// api.agnes-ai.cn = 中国站). Same model lineup on both. Supports
// image_url input (base64 data URLs work), tool calling, and thinking mode
// via chat_template_kwargs.enable_thinking (wired to pi's thinkingLevel).
// https://www.agnes-ai.com/zh-Hans/docs/overview
const streamAgnes = makeOpenAIStream("https://apihub.agnes-ai.com/v1", "AGNES_API_KEY", {
  maxTokens: 65536,
  enableThinking: true,
});
const streamAgnesCN = makeOpenAIStream("https://api.agnes-ai.cn/v1", "AGNES_CN_API_KEY", {
  maxTokens: 65536,
  enableThinking: true,
});

// Cloudflare Workers AI — official OpenAI-compatible endpoint.
// https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
// The account id is embedded in the URL path, so the base URL is built from
// CLOUDFLARE_ACCOUNT_ID at request time (cannot use makeOpenAIStream's static
// baseUrl). Free tier: 10,000 neurons/day (UTC reset); the 5 frontier models
// (deepseek-v4-flash/pro, glm-5.2, kimi-k2.6/k2.7-code) require paid billing
// and are intentionally NOT registered here.
const streamCloudflare = (model, context, options) => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const stream = new AssistantMessageEventStream();
    const output = makeOutput(model);
    output.stopReason = "error";
    output.errorMessage = "CLOUDFLARE_ACCOUNT_ID env var is not set; cannot build Workers AI endpoint URL";
    stream.push({ type: "error", reason: "error", error: output });
    try { stream.end(); } catch {}
    return stream;
  }
  return makeOpenAIStream(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    "CLOUDFLARE_API_KEY",
    { maxTokens: (model) => model.maxTokens ?? 65536 }
  )(model, context, options);
};

async function run(stream, output, model, context, options, cfg) {
  const state = { output, stream, contentBlockIndex: -1, thinkingBlockIndex: -1, toolCallsState: [] };
  try {
    const messages = normalizeMessages(context.messages ?? []);
    const tools = normalizeTools(context.tools);
    let body = {
      model: model.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(options?.maxTokens ? { max_tokens: options.maxTokens } : { max_tokens: cfg.maxTokens }),
    };
    if (cfg.cleanBody) body = cfg.cleanBody(body);
    // Thinking mode for providers that opt in via a gateway extension field
    // (e.g. Agnes AI: chat_template_kwargs.enable_thinking). pi signals the
    // requested level through options.thinkingLevel.
    if (cfg.enableThinking && options?.thinkingLevel && options.thinkingLevel !== "off") {
      body.chat_template_kwargs = { enable_thinking: true };
    }
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${cfg.key()}`,
      ...(cfg.headers ? cfg.headers() : {}),
    };
    stream.push({ type: "start", partial: output });
    const response = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      const hint = explainModelChurn(response.status, errText);
      throw new Error(`${model.provider} API request failed: ${response.status} ${response.statusText}. ${errText.slice(0, 300)}${hint ? `\n${hint}` : ""}`);
    }
    const reader = response.body.getReader();
    await consumeSSEStream(state, reader);
    finalizeToolCalls(state);
    if (state.toolCallsState.length > 0) output.stopReason = "toolUse";
    else if (!output.stopReason || output.stopReason === "stop") output.stopReason = "stop";
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  } catch (e) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = e instanceof Error ? e.message : String(e);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    try { stream.end(); } catch {}
  }
}

// ── Agnes AI models (shared by international + China providers) ──
// Text/chat models only; image/video generation models are not chat
// completions and are intentionally not registered. Limits from:
// https://wiki.agnes-ai.com/en/docs/agnes-25-flash.md (and agnes-20-flash.md)
const AGNES_MODELS = [
  {
    id: "agnes-2.5-flash",
    name: "Agnes 2.5 Flash",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 512000,
    maxTokens: 65536,
  },
  {
    id: "agnes-2.0-flash",
    name: "Agnes 2.0 Flash",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 512000,
    maxTokens: 65536,
  },
  {
    id: "agnes-2.5-pro",
    name: "Agnes 2.5 Pro",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.45, output: 0.9, cacheRead: 0.0038, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "agnes-2.5-pro-alpha",
    name: "Agnes 2.5 Pro Alpha",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.45, output: 0.9, cacheRead: 0.0038, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];

// ── Curated model allowlists ──
// Models we vouch for: verified free tier + correct metadata (contextWindow,
// maxTokens, reasoning, input, cost). At load each list is intersected with
// the provider's live /v1/models so models that leave the free tier or get
// renamed are auto-removed (drift detection). For Zen, every live model is
// additionally probe-verified as free at load (see verifyZenModels): unknown
// free models are auto-added with conservative metadata, and curated entries
// that switched to paid are dropped despite being whitelisted.
const ZEN_FREE_MODELS = [
  {
    id: "mimo-v2.5-free",
    name: "MiMo-V2.5 Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "hy3-free",
    name: "Hy3 Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "laguna-s-2.1-free",
    name: "Laguna S 2.1 Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "big-pickle",
    name: "Big Pickle",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "x-preview-f-free",
    name: "Ox Alpha Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
];
const SENSENOVA_MODELS = [
  {
    id: "sensenova-6.7-flash-lite",
    name: "SenseNova 6.7 Flash-Lite",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash-Lite",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash (via SenseNova)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2 (via SenseNova)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  },
];
// 免费清单 2026-08-22 经模型广场 biz_info 计价接口逐个核验，并与 /v1/models 在架列表取交集。
// 变动提示：nex-agi/Nex-N2-Pro 已转付费（输入¥0.00175/输出¥0.007 每K tokens）；
// Qwen2.5-7B-Instruct 不再免费；glm-4-9b-chat、Qwen2-7B-Instruct、R1-Distill-Qwen-7B、
// bce 向量/重排序等老牌免费模型均已下线。当前免费聊天模型仅剩以下小模型。
const SILICONFLOW_MODELS = [
  {
    id: "Qwen/Qwen3-8B",
    name: "Qwen3-8B (免费)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
    name: "DeepSeek-R1-0528-Qwen3-8B (免费推理)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "THUDM/GLM-Z1-9B-0414",
    name: "GLM-Z1-9B (免费推理)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "THUDM/GLM-4-9B-0414",
    name: "GLM-4-9B-0414 (免费)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: "Qwen/Qwen3.5-4B",
    name: "Qwen3.5-4B (免费长上下文)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
];
const MODELSCOPE_MODELS = [
  {
    id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    name: "Qwen3-Coder-30B (via ModelScope)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  // DeepSeek-V4-Pro 存在但默认配额不足(429)，需在 ModelScope 控制台开通对应模型额度
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro (via ModelScope, 需开通)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];
const NVIDIA_MODELS = [
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B (via NVIDIA NIM)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
];
const CLOUDFLARE_MODELS = [
  {
    id: "@cf/openai/gpt-oss-120b",
    name: "GPT-OSS 120B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    name: "GPT-OSS 20B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 24000,
    maxTokens: 8192,
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    name: "Qwen3 30B A3B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    name: "Qwen2.5 Coder 32B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    name: "Gemma 4 26B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    name: "GLM-4.7-Flash (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    name: "DeepSeek R1 Distill Qwen 32B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 80000,
    maxTokens: 65536,
  },
];

// ── Live model-list drift detection ──
// Fetch a provider's /v1/models and return the set of ids. Best-effort: any
// non-OK status, unexpected shape, or network error returns null so callers
// fall back to the curated allowlist (registration never breaks).
async function fetchLiveModelIds(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    const data = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(data)) return null;
    return new Set(data.map((m) => m.id ?? m.name).filter(Boolean));
  } catch {
    return null;
  }
}
function authHeader(envKey) {
  return { Authorization: `Bearer ${process.env[envKey] ?? "public"}` };
}
// Intersect curated with live ids; drop models no longer present upstream.
async function filterToLive(curated, url, headers) {
  const live = await fetchLiveModelIds(url, headers);
  if (!live) return curated;
  const kept = curated.filter((m) => live.has(m.id));
  return kept.length ? kept : curated;
}

// ── Zen free-model auto-discovery ──
// /v1/models exposes no pricing and paid models keep "-free" ids, so freeness
// is verified by probing: a tiny chat completion per unknown model. Free
// models accept the anonymous "public" key (HTTP 200) while paid ones reject
// it during auth (401/402/403) before any tokens are billed. When a real
// OPENCODE_API_KEY is set, the response's `cost` field must be zero instead —
// paid models then succeed but report non-zero cost.
// Returns "free" (verified), "paid" (verified not free), or "unknown"
// (network/shape errors — callers must keep the model rather than drop it,
// so a transient outage never wipes the list).
async function probeFreeStatus(modelId) {
  const apiKey = process.env.OPENCODE_API_KEY;
  let res;
  try {
    res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...OPENCODE_STATIC_HEADERS,
        "x-opencode-session": SESSION_ID,
        "x-opencode-request": generateOpenCodeId("msg_"),
        Authorization: `Bearer ${apiKey ?? "public"}`,
      },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return "unknown";
  }
  if (!res.ok) {
    // Auth/billing rejection = verified not free. Anything else (5xx, rate
    // limit) says nothing about pricing — treat as unknown.
    return [401, 402, 403].includes(res.status) ? "paid" : "unknown";
  }
  let json;
  try { json = await res.json(); } catch { return "unknown"; }
  if (apiKey) return Number(json?.cost ?? 0) === 0 ? "free" : "paid";
  return "free";
}
// Run async fn over items with bounded concurrency.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
function makeDiscoveredModel(id) {
  return {
    id,
    name: id,
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  };
}
// Verify the whole live Zen list by probing every id (curated entries use
// their hand-verified metadata, unknown ones get conservative defaults). This
// catches models that switched from free to paid while staying listed — they
// are dropped exactly like renamed/removed ones. If nothing verifies free
// (e.g. probes all failed), fall back to the curated ∩ live intersection so a
// gateway outage never empties the provider.
async function verifyZenModels(liveIds) {
  const known = new Map(ZEN_FREE_MODELS.map((m) => [m.id, m]));
  const ids = [...liveIds];
  const statuses = await mapLimit(ids, 8, probeFreeStatus);
  const verified = [];
  for (let i = 0; i < ids.length; i++) {
    if (statuses[i] !== "free") continue;
    verified.push(known.get(ids[i]) ?? makeDiscoveredModel(ids[i]));
  }
  if (verified.length) return verified;
  const kept = ZEN_FREE_MODELS.filter((m) => liveIds.has(m.id));
  return kept.length ? kept : ZEN_FREE_MODELS;
}

// ── Extension entry ──
export default async function (pi) {
  // Drift detection: intersect each curated allowlist with the provider's
  // live /v1/models. Models that left the free tier / were renamed are dropped
  // automatically. Fetch failures fall back to the curated list so registration
  // never breaks. For Zen, every live model is additionally probe-verified as
  // still free (see verifyZenModels above) — this also drops models that
  // switched to paid while remaining listed.
  const zenHeaders = {
    ...OPENCODE_STATIC_HEADERS,
    Authorization: `Bearer ${process.env.OPENCODE_API_KEY ?? "public"}`,
  };
  const [zenLive, sensenovaModels, siliconflowModels, modelscopeModels, nvidiaModels, agnesModels] = await Promise.all([
    fetchLiveModelIds("https://opencode.ai/zen/v1/models", zenHeaders),
    filterToLive(SENSENOVA_MODELS, "https://token.sensenova.cn/v1/models", authHeader("SENSENOVA_API_KEY")),
    filterToLive(SILICONFLOW_MODELS, "https://api.siliconflow.cn/v1/models", authHeader("SILICONFLOW_API_KEY")),
    filterToLive(MODELSCOPE_MODELS, "https://api-inference.modelscope.cn/v1/models", authHeader("MODELSCOPE_API_KEY")),
    filterToLive(NVIDIA_MODELS, "https://integrate.api.nvidia.com/v1/models", authHeader("NVIDIA_NIM_API_KEY")),
    filterToLive(AGNES_MODELS, "https://apihub.agnes-ai.com/v1/models", authHeader("AGNES_API_KEY")),
  ]);
  const zenModels = zenLive ? await verifyZenModels(zenLive) : ZEN_FREE_MODELS;
  // Cloudflare has no anonymous /v1/models (account-scoped search endpoint);
  // paid models are excluded via the opencode blacklist instead. Keep curated.
  const cloudflareModels = CLOUDFLARE_MODELS;

  pi.registerProvider("opencode-fix", {
    name: "OpenCode Zen (native headers)",
    apiKey: "public",
    baseUrl: "https://opencode.ai/zen/v1",
    api: "openai-completions",
    streamSimple: streamOpenCode,
    models: zenModels,
  });
  pi.registerProvider("sensenova", {
    name: "SenseNova (商汤日日新)",
    apiKey: "public",
    baseUrl: "https://token.sensenova.cn/v1",
    api: "openai-completions",
    streamSimple: streamSenseNova,
    models: sensenovaModels,
  });
  pi.registerProvider("siliconflow", {
    name: "硅基流动 (SiliconFlow)",
    apiKey: "public",
    baseUrl: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    streamSimple: streamSiliconFlow,
    models: siliconflowModels,
  });
  pi.registerProvider("modelscope", {
    name: "魔塔社区 (ModelScope)",
    apiKey: "public",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    api: "openai-completions",
    streamSimple: streamModelScope,
    models: modelscopeModels,
  });
  pi.registerProvider("nvidia", {
    name: "NVIDIA NIM",
    apiKey: "public",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    api: "openai-completions",
    streamSimple: streamNvidia,
    models: nvidiaModels,
  });
  pi.registerProvider("cloudflare", {
    name: "Cloudflare Workers AI (免费额度)",
    apiKey: "public",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    api: "openai-completions",
    streamSimple: streamCloudflare,
    models: cloudflareModels,
  });
  pi.registerProvider("agnes", {
    name: "Agnes AI (国际站)",
    apiKey: "public",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    api: "openai-completions",
    streamSimple: streamAgnes,
    models: agnesModels,
  });
  pi.registerProvider("agnes-cn", {
    name: "Agnes AI (中国站)",
    apiKey: "public",
    baseUrl: "https://api.agnes-ai.cn/v1",
    api: "openai-completions",
    streamSimple: streamAgnesCN,
    models: agnesModels,
  });
}