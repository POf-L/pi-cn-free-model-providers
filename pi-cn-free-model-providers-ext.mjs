// OpenCode Zen native streamSimple for pi — zero pi-ai dependency.
// Fixes pi's 429 on free models by sending OpenCode-native headers
// (x-opencode-client: cli + ses_/msg_ ULID ids) and converting
// developer->system roles (upstream only accepts system/user/assistant).
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Image, Markdown } from "@earendil-works/pi-tui";

// ── Clickable file links ──────────────────────────────────────────────────
// The TUI renders assistant text as Markdown and turns a `[label](url)` link
// into a clickable OSC 8 hyperlink (supported by Windows Terminal, WezTerm,
// iTerm2, Kitty, etc.). Convert absolute paths to Markdown links so generated
// media opens in one click instead of copy-pasting the raw path.
function fileLink(p, label = p) {
  return `[${label}](${pathToFileURL(String(p)).href})`;
}

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
// Every Zen call goes through one place so a local relay can be substituted.
// `OPENCODE_ZEN_BASE_URL` exists because the gateway refuses some models with
// `RegionError` depending on the caller's identity/region; users who front it
// with their own proxy previously had no way to point this extension at it.
const ZEN_BASE_URL = (process.env.OPENCODE_ZEN_BASE_URL ?? "https://opencode.ai/zen/v1").replace(/\/+$/, "");

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
  // Assistant turns that failed or were aborted are dropped below. Their tool
  // results must go with them: a `role: "tool"` whose tool_call_id is declared
  // by no surviving assistant message is an orphan, and strict
  // OpenAI-compatible gateways reject the request outright. Collect the ids of
  // the dropped calls so the matching results are skipped too.
  const orphanedToolCallIds = new Set();
  for (const m of messages ?? []) {
    if (!m || typeof m !== "object") continue;
    // Skip failed assistant turns
    if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block?.type === "toolCall" && block.id) orphanedToolCallIds.add(block.id);
        }
      }
      continue;
    }
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
      if (orphanedToolCallIds.has(m.toolCallId)) continue;
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
  // Most OpenAI-compatible gateways stream thinking as `reasoning_content`, but
  // SenseNova's gateway uses a bare `reasoning` field (verified against
  // https://token.sensenova.cn/v1 — every delta for sensenova-6.8-flash-lite
  // carries only `reasoning`). Reading just one name silently drops the thinking
  // stream for that provider even though its models declare `reasoning: true`.
  const reasoningDelta = delta.reasoning_content || delta.reasoning;
  if (reasoningDelta) {
    if (state.thinkingBlockIndex === -1) {
      state.thinkingBlockIndex = state.output.content.length;
      state.output.content.push({ type: "thinking", thinking: "" });
      state.stream.push({ type: "thinking_start", contentIndex: state.thinkingBlockIndex, partial: state.output });
    }
    const block = state.output.content[state.thinkingBlockIndex];
    block.thinking += reasoningDelta;
    state.stream.push({ type: "thinking_delta", contentIndex: state.thinkingBlockIndex, delta: reasoningDelta, partial: state.output });
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
      // Open the block as soon as the call is announced rather than on its first
      // argument chunk. Waiting loses calls that carry no arguments at all
      // (`arguments: ""` is falsy), and it froze id/name at whatever had
      // arrived by then — gateways are free to send the id afterwards.
      if (!t.emittedStart && (t.id || t.name)) {
        t.emittedStart = true;
        t.contentIndex = state.output.content.length;
        state.output.content.push({ type: "toolCall", id: t.id, name: t.name, arguments: {} });
        state.stream.push({ type: "toolcall_start", contentIndex: t.contentIndex, partial: state.output });
      }
      if (tc.function?.arguments) {
        t.arguments += tc.function.arguments;
        if (t.emittedStart) {
          state.stream.push({ type: "toolcall_delta", contentIndex: t.contentIndex, delta: tc.function.arguments, partial: state.output });
        }
      }
    }
  }
}
function finalizeToolCalls(state) {
  for (const t of state.toolCallsState) {
    if (t?.emittedStart) {
      let args = {};
      try { args = JSON.parse(t.arguments || "{}"); } catch {}
      // Re-write id/name as well: they may have arrived after the block was
      // opened, and a block left with an empty id can never be matched to its
      // tool result.
      const block = state.output.content[t.contentIndex];
      block.id = t.id;
      block.name = t.name;
      block.arguments = args;
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

// ── Verified image-generation models ---------------------------------------
// SenseNova exposes OpenAI-compatible image-generation endpoints.
// Keep this separate from the generic chat stream: its image responses are
// not chat-completion SSE messages and need to be saved/echoed explicitly.
let appendNativeImage = null;

function latestImageRequest(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const user = [...messages].reverse().find((message) => message?.role === "user");
  if (!user) return { prompt: "", images: [] };
  if (typeof user.content === "string") return { prompt: user.content, images: [] };
  const parts = Array.isArray(user.content) ? user.content : [];
  return {
    prompt: parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n"),
    images: parts.filter((part) => part?.type === "image"),
  };
}

async function saveNativeImage(image, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-images");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const mimeType = image?.mime_type ?? image?.mimeType ?? "image/png";
  const extension = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const safeModelId = String(modelId).replaceAll("/", "_");
  const path = join(directory, `opencode-${safeModelId}-${Date.now()}.${extension}`);
  if (image?.b64_json) {
    writeFileSync(path, Buffer.from(image.b64_json, "base64"));
  } else if (image?.url) {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`Unable to download generated image: HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  } else {
    throw new Error("Image API returned neither url nor b64_json");
  }
  return { path, mimeType };
}

function streamNativeImage(model, context, options) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const { prompt, images } = latestImageRequest(context);
      if (!prompt) throw new Error("Image generation requires a text prompt");
      // SenseNova is the only registered provider with a native image endpoint:
      // /images/generations for text-to-image, /images/edits once an image is
      // attached. response_format/output_format are required by its schema.
      const baseUrl = "https://token.sensenova.cn/v1";
      const apiKey = process.env.SENSENOVA_API_KEY ?? readAgentAuthKey("sensenova") ?? "";
      if (!apiKey) throw new Error("SENSENOVA_API_KEY (or a stored sensenova key) is required for image generation");
      const endpoint = images.length ? `${baseUrl}/images/edits` : `${baseUrl}/images/generations`;
      const body = {
        model: model.id,
        prompt,
        n: 1,
        response_format: "url",
        output_format: "png",
        ...(images.length ? { images: images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })) } : {}),
      };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? `Image API HTTP ${response.status}`);
      const image = payload?.data?.[0];
      if (!image) throw new Error("Image API returned no image data");
      const saved = await saveNativeImage(image, model.id);
      const text = `Generated image saved to: ${fileLink(saved.path)}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      appendNativeImage?.(saved);
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

// Factory for standard OpenAI-compatible providers (no special headers/schema).
// opts.maxTokens may be a number (all models) or a function (model) => number
// to let each model use its own registered limit.
// Provider-side model churn surfaces as distinctive upstream errors long before
// our curated lists get updated. Recognize them and attach an actionable hint:
// - 404 / "not found" / 已下线 → model deprecated or renamed;
// - insufficient-balance → if the model is curated as free, that label is stale
//   (it turned paid and just tried to bill the user).
function explainModelChurn(status, errText) {
  const t = String(errText).toLowerCase();
  if (
    status === 404 ||
    /model[\w-]{0,24}(not found|not exist|does not exist)/.test(t) ||
    /(已下线|已不再提供|不存在|deprecated|no longer available)/.test(t)
  ) {
    return "Hint: this model may have been deprecated/renamed by the provider — check the provider's /v1/models and update the curated list.";
  }
  if (/insufficient[ _-]?balance|余额不足/.test(t)) {
    return "Hint: rejected for insufficient balance — if this model is labeled free in the curated list, that label is stale (it has turned PAID). Update the curated list accordingly.";
  }
  return "";
}

function makeOpenAIStream(baseUrl, envKey, opts = {}) {
  return function streamSimple(model, context, options) {
    const stream = new AssistantMessageEventStream();
    const output = makeOutput(model);
    // Fall back to the model's own registered limit rather than a flat 128000:
    // `run` now treats this value as a ceiling, so a provider-wide constant
    // would cap large models below what they actually accept.
    const maxTokens = typeof opts.maxTokens === "function"
      ? opts.maxTokens(model)
      : (opts.maxTokens ?? model.maxTokens ?? 128000);
    const cfg = {
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      envKey,
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
    url: `${ZEN_BASE_URL}/chat/completions`,
    envKey: "OPENCODE_API_KEY",
    key: () => process.env.OPENCODE_API_KEY
      ?? (options?.apiKey && options.apiKey !== "public" ? options.apiKey : "public"),
    headers: () => ({
      ...OPENCODE_STATIC_HEADERS,
      "x-opencode-session": SESSION_ID,
      "x-opencode-request": generateOpenCodeId("msg_"),
    }),
    maxTokens: model.maxTokens ?? 128000,
  });
  return stream;
}

// SenseNova (商汤日日新) — OpenAI-compatible gateway with a strict schema.
// https://platform.sensenova.cn/docs — only listed fields are accepted;
// response_format is rejected, multiple system messages must be merged,
// assistant.content:null must be dropped, and max_tokens is validated against
// a PER-MODEL ceiling (verified: sensenova-6.8-flash-lite rejects 65537 with
// "should be in [1, 65536]" while glm-5.2 accepts 131072 and rejects 131073).
// A single provider-wide 65536 both failed the small models on overrides and
// halved glm-5.2, so defer to each model's registered limit.
const streamSenseNovaChat = makeOpenAIStream("https://token.sensenova.cn/v1", "SENSENOVA_API_KEY", {
  maxTokens: (model) => model.maxTokens ?? 65536,
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
const streamSenseNova = (model, context, options) =>
  model.opencodeImageModel ? streamNativeImage(model, context, options) : streamSenseNovaChat(model, context, options);

async function run(stream, output, model, context, options, cfg) {
  const state = { output, stream, contentBlockIndex: -1, thinkingBlockIndex: -1, toolCallsState: [] };
  try {
    // pi carries its system prompt (coding prompt, injected skills XML, etc.)
    // in context.systemPrompt — forward it, otherwise the model never sees it.
    const sysRaw = context.systemPrompt;
    let systemText = "";
    if (typeof sysRaw === "string") systemText = sysRaw;
    else if (Array.isArray(sysRaw)) systemText = sysRaw.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("");
    else if (sysRaw && typeof sysRaw === "object") {
      const c = sysRaw.content ?? sysRaw.text;
      if (typeof c === "string") systemText = c;
    }
    const messages = [
      ...(systemText ? [{ role: "system", content: systemText }] : []),
      ...normalizeMessages(context.messages ?? []),
    ];
    const tools = normalizeTools(context.tools);
    // cfg.maxTokens is a hard upstream ceiling, not just a default: SenseNova
    // validates it per model and answers 400 "field MaxTokens invalid, should be
    // in [1, N]". Letting options.maxTokens override it unclamped turned any
    // session-level bump into a failed request.
    const cap = cfg.maxTokens;
    const maxTokens = Math.max(1, Math.min(options?.maxTokens ?? cap, cap));
    let body = {
      model: model.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
      max_tokens: maxTokens,
    };
    if (cfg.cleanBody) body = cfg.cleanBody(body);
    // pi hands the selected thinking level to streamSimple as `options.reasoning`
    // (a level name from off|minimal|low|medium|high|xhigh|max). Forward it as
    // reasoning_effort, translated through the model's thinkingLevelMap, so the
    // /think selection actually reaches the gateway instead of being dropped.
    // Only models that declare a map get the field — the ones that reject it
    // outright (mimo-v2.5-free, big-pickle) must not receive it at all.
    const level = options?.reasoning ?? options?.thinkingLevel;
    if (model.thinkingLevelMap && typeof level === "string") {
      const effort = model.thinkingLevelMap[level] ?? level;
      if (effort) body.reasoning_effort = effort;
    }
    // Thinking mode for providers that opt in via a gateway extension field
    // (chat_template_kwargs.enable_thinking). pi signals the requested level
    // through options.thinkingLevel.
    if (cfg.enableThinking && options?.thinkingLevel && options.thinkingLevel !== "off") {
      body.chat_template_kwargs = { enable_thinking: true };
    }
    const apiKey = cfg.key();
    // Template-interpolating a missing key produced the literal header
    // `Bearer undefined`, which upstream answers with an opaque 401. Fail with
    // the name of the variable the user actually has to set instead.
    if (!apiKey) {
      throw new Error(
        `${model.provider} requires an API key: set ${cfg.envKey ?? "the provider's API key env var"} ` +
        `or store a key for this provider (pi auth), then retry.`,
      );
    }
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey}`,
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
    // Only claim a tool-use stop when a tool-call block actually made it into
    // the output. A state entry that never opened its block would otherwise
    // leave pi waiting for a tool result that does not exist.
    if (state.toolCallsState.some((t) => t?.emittedStart)) output.stopReason = "toolUse";
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

// ── Curated model allowlists ──
// Models we vouch for: verified free tier + correct metadata (contextWindow,
// maxTokens, reasoning, input, cost). At load each list is intersected with
// the provider's live /v1/models so models that leave the free tier or get
// renamed are auto-removed (drift detection). For Zen, every live model is
// additionally probe-verified as free at load (see verifyZenModels): unknown
// free models are auto-added with conservative metadata, and curated entries
// that switched to paid are dropped despite being whitelisted.
// Zen's /chat/completions names its effort enum when a value is rejected:
// none|minimal|low|medium|high|xhigh|max. pi only offers xhigh/max when a model
// declares them (see getSupportedThinkingLevels), and it has no "off" wire value
// of its own on this transport, so map that to the gateway's "none".
// NOT every Zen model takes the field: mimo-v2.5-free and big-pickle answer 400
// "Invalid request parameters" for any reasoning_effort (including valid ones)
// and work only when it is omitted, so they deliberately carry no map — `run`
// keys the field's presence off thinkingLevelMap.
const ZEN_CHAT_THINKING_LEVELS = { off: "none", xhigh: "xhigh", max: "max" };

const ZEN_FREE_MODELS = [
  {
    // Responses-API only: /chat/completions answers 500 for this model while
    // /responses answers 200 with cost "0". Image parts are accepted without
    // error. On output: the gateway accepts max_output_tokens up to at least
    // 700000 and rejects 1048576, so 131072 is a deliberate under-claim —
    // reserving most of the 1M window for output would make long sessions fail
    // the input+output budget instead.
    id: "muse-spark-1.2-contributor-free",
    name: "Muse Spark 1.2 Free",
    api: "openai-responses",
    reasoning: true,
    // pi hides the xhigh/max thinking levels unless the model names them in
    // thinkingLevelMap (getSupportedThinkingLevels treats those two as opt-in),
    // so without this the gateway's highest effort was unreachable from /think.
    // /responses accepts none|minimal|low|medium|high|xhigh for this model and
    // rejects max, so only xhigh is declared; pi sends the "off" level as
    // reasoning.effort "none" on its own.
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  },
  {
    // Completion ceiling verified: max_tokens 200000 is rejected with "supports
    // at most 131072 completion tokens". contextWindow is inherited and NOT
    // independently verified — the gateway answers oversized prompts by
    // compressing them ("use the context-compression plugin to compress your
    // prompt automatically") instead of naming the context length, so a padded
    // request cannot measure it. 200000 therefore stays as a safe under-claim.
    id: "mimo-v2.5-free",
    name: "MiMo-V2.5 Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 131072,
  },
  {
    // Replaces hy3-free, which vanished from /v1/models and now answers
    // "Model hy3-free is not supported". Context window read off the gateway's
    // own over-budget error ("maximum context length is 262144 tokens").
    id: "ling-3.0-flash-fin-free",
    name: "Ling 3.0 Flash Fin Free",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ZEN_CHAT_THINKING_LEVELS,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    // Context window corrected from 200000: the gateway reports "maximum
    // context length is 262144 tokens", and max_tokens 262000 is accepted.
    id: "laguna-s-2.1-free",
    name: "Laguna S 2.1 Free",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ZEN_CHAT_THINKING_LEVELS,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 131072,
  },
  {
    // Context window confirmed by the gateway ("maximum context length is
    // 1000000 tokens"); max_tokens 999000 is accepted, so 131072 is a practical
    // registered ceiling rather than a hard upstream limit.
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ZEN_CHAT_THINKING_LEVELS,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 131072,
  },
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: ZEN_CHAT_THINKING_LEVELS,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 131072,
  },
  {
    // Completion ceiling verified: max_tokens 200000 is rejected with "supports
    // at most 131072 completion tokens". contextWindow is inherited and not
    // independently verified (see mimo-v2.5-free above).
    id: "big-pickle",
    name: "Big Pickle",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 131072,
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
  {
    // Added after /v1/models showed pricing 0 and a live call returned 200 with
    // reasoning_content. max_tokens ceiling reported as [1, 393216], but the
    // catalog's own max_output_length is 65536, so register that.
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (via SenseNova)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    // Free per /v1/models pricing; verified with a live call (returns
    // reasoning_content, and max_tokens 999999 is not rejected).
    id: "kimi-k3",
    name: "Kimi K3 (via SenseNova)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "sensenova-u1-fast",
    name: "SenseNova U1 Fast (image generation)",
    api: "openai-completions",
    input: ["text"],
    opencodeImageModel: true,
    opencodeImageProvider: "sensenova",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 4096,
  },
  {
    id: "sensenova-u1.5-lite",
    name: "SenseNova U1.5 Lite (image generation/editing)",
    api: "openai-completions",
    input: ["text", "image"],
    opencodeImageModel: true,
    opencodeImageProvider: "sensenova",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 4096,
  },
];
// ── Live model-list drift detection ──
// Fetch complete model objects from a provider's /v1/models. The live payload
// is retained so capability metadata (modalities/features/supports_*) is not
// lost while doing drift detection.
// Combine a per-request timeout with the caller's overall deadline so the
// background pass can actually be bounded end to end.
function boundedSignal(timeoutMs, outer) {
  const own = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([own, outer]) : own;
}

async function fetchLiveModels(url, headers, signal) {
  try {
    const res = await fetch(url, { headers, signal: boundedSignal(8000, signal) });
    if (!res.ok) return null;
    const json = await res.json();
    const data = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(data)) return null;
    return data.filter((model) => model && (model.id ?? model.name));
  } catch {
    return null;
  }
}

async function fetchLiveModelIds(url, headers, signal) {
  const models = await fetchLiveModels(url, headers, signal);
  return models ? new Set(models.map((model) => model.id ?? model.name).filter(Boolean)) : null;
}

// When OPENCODE_ZEN_BASE_URL points at a local relay (the region-gate
// workaround), the relay may still be starting while this pass runs — the
// catalog fetch then fails, the whole Zen verification is skipped and every Zen
// call fails until the next session. Retry a loopback target a few times before
// giving up; a remote gateway is not retried (a 5xx there is real).
function isLoopbackUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function fetchLiveModelIdsResilient(url, headers, signal) {
  const attempts = isLoopbackUrl(url) ? 5 : 1;
  for (let i = 0; i < attempts; i++) {
    const ids = await fetchLiveModelIds(url, headers, signal);
    if (ids) return ids;
    if (i === attempts - 1 || signal?.aborted) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return null;
}

// pi keeps provider keys in <agentDir>/auth.json (written by `pi auth`), not in
// the environment. An env-only lookup therefore fell back to `Bearer public`,
// every authenticated /v1/models call answered 401, fetchLiveModels returned
// null and filterToLive silently handed back the curated list — which is why
// live metadata was never adopted and drift was never detected.
const AGENT_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
let agentAuthStore;
let agentAuthMtime = -1;

function readAgentAuthKey(providerId) {
  if (!providerId) return undefined;
  // Re-read when the file changes: `pi auth` can store a key mid-session, and a
  // process-lifetime cache would keep answering with the pre-login state.
  let mtime = -1;
  try {
    mtime = statSync(AGENT_AUTH_FILE).mtimeMs;
  } catch {
    mtime = -1;
  }
  if (agentAuthStore === undefined || mtime !== agentAuthMtime) {
    agentAuthMtime = mtime;
    try {
      agentAuthStore = JSON.parse(readFileSync(AGENT_AUTH_FILE, "utf-8"));
    } catch {
      agentAuthStore = null;
    }
  }
  const entry = agentAuthStore?.[providerId];
  if (!entry) return undefined;
  const key = typeof entry === "string" ? entry : entry.key ?? entry.apiKey ?? entry.access;
  return typeof key === "string" && key ? key : undefined;
}

function authHeader(envKey, providerId) {
  const key = process.env[envKey] ?? readAgentAuthKey(providerId) ?? "public";
  return { Authorization: `Bearer ${key}` };
}

// Read limits out of an upstream /v1/models entry. The wire names differ from
// pi's (`context_length` vs `contextWindow`, `max_output_length` vs
// `maxTokens`), which is exactly why spreading the live object achieved nothing
// — the values landed as inert extra keys and the curated numbers always won.
// Only positive integers are accepted so a null/0/string placeholder can never
// overwrite a good curated value.
function liveLimits(live) {
  const pick = (...names) => {
    for (const name of names) {
      const value = name.includes(".")
        ? name.split(".").reduce((node, key) => (node == null ? undefined : node[key]), live)
        : live?.[name];
      if (Number.isInteger(value) && value > 0) return value;
    }
    return undefined;
  };
  return {
    contextWindow: pick("context_length", "context_window", "contextWindow", "max_context_length", "max_input_tokens", "limit.context"),
    maxTokens: pick("max_output_length", "max_output_tokens", "max_completion_tokens", "maxTokens", "limit.output"),
  };
}

function mergeLiveModel(curated, live) {
  // Routing (api / streamSimple flags) and cost stay curated: those encode how
  // this extension talks to the provider, and upstream `pricing` is a
  // unit-ambiguous string. Limits and input modalities, on the other hand, are
  // authoritative upstream — SenseNova enforces max_output_length per model —
  // so let live values win when they are present and sane.
  const limits = liveLimits(live);
  // Native image/video/audio models are driven through /images/*, /videos or
  // /audio/*, so the chat-endpoint modalities upstream reports do not describe
  // what they accept. sensenova-u1.5-lite advertises text-only input yet takes
  // an image for /images/edits.
  const nativeEndpoint = curated.opencodeImageModel === true ||
    curated.opencodeVideoModel === true ||
    curated.opencodeAudioModel === true ||
    curated.opencodeTranscriptionModel === true;
  const liveInput = Array.isArray(live?.input_modalities ?? live?.inputModalities)
    ? (live.input_modalities ?? live.inputModalities).filter((item) => item === "text" || item === "image")
    : undefined;
  return {
    ...live,
    ...curated,
    id: curated.id,
    name: curated.name ?? live.name ?? live.label ?? curated.id,
    ...(limits.contextWindow ? { contextWindow: limits.contextWindow } : {}),
    ...(limits.maxTokens ? { maxTokens: limits.maxTokens } : {}),
    ...(!nativeEndpoint && liveInput?.length ? { input: liveInput } : {}),
    opencodeLiveModel: live,
  };
}

// Keep the curated allowlist for safety, but return each retained model with
// its complete upstream metadata instead of reducing /v1/models to IDs.
//
// The three outcomes are deliberately distinct:
//  • fetch failed (null) → return curated untouched; an outage must not shrink
//    the catalog.
//  • fetch succeeded with overlap → return the merged intersection.
//  • fetch succeeded with ZERO overlap → return the empty list. Falling back to
//    curated here (the old behaviour) meant that if a provider retired every
//    curated id at once, the extension kept registering models that no longer
//    exist, and every call would fail at runtime with no hint why.
async function filterToLive(curated, url, headers, signal) {
  const liveModels = await fetchLiveModels(url, headers, signal);
  if (!liveModels) return curated;
  const byId = new Map(liveModels.map((model) => [model.id ?? model.name, model]));
  return curated
    .filter((model) => byId.has(model.id))
    .map((model) => mergeLiveModel(model, byId.get(model.id)));
}

// ── Zen free-model auto-discovery ──
// /v1/models exposes no pricing and paid models keep "-free" ids, so freeness
// is verified by probing: a tiny chat completion per model.
//
// Probing always uses the anonymous "public" key, EVEN when a real
// OPENCODE_API_KEY is configured: free models answer 200 while paid ones are
// rejected during auth (401/402/403) before a single token is billed. The
// key-based variant (accept the answer, then read `cost`) does bill the paid
// models it probes — one output token each across ~50 paid ids per startup —
// so it is only used as a fallback when the anonymous attempt was inconclusive
// (e.g. the shared free quota answered 429).
//
// Returns { status, api } where status is "free" (verified), "paid" (verified
// not free), or "unknown" (network/shape errors — the caller keeps curated
// models on unknown, so a transient outage never wipes the list). `api` is the
// endpoint the model actually answered on.
//
// Some Zen models are Responses-API only: muse-spark-1.2-contributor-free
// answers 500 on /chat/completions and 200 with cost "0" on /responses. Probing
// only chat completions classified those as "unknown" forever, so they could
// never enter the list even though they are free and usable.
function zenRequestHeaders(apiKey = "public") {
  return {
    "Content-Type": "application/json",
    ...OPENCODE_STATIC_HEADERS,
    "x-opencode-session": SESSION_ID,
    "x-opencode-request": generateOpenCodeId("msg_"),
    Authorization: `Bearer ${apiKey}`,
  };
}

async function probeFreeStatus(modelId, signal) {
  const apiKey = process.env.OPENCODE_API_KEY;
  const attempt = async (path, body, key) => {
    let res;
    try {
      res = await fetch(`${ZEN_BASE_URL}${path}`, {
        method: "POST",
        headers: zenRequestHeaders(key),
        body: JSON.stringify(body),
        signal: boundedSignal(20000, signal),
      });
    } catch {
      return "unknown";
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A model the gateway itself says it does not have is gone, whatever the
      // status code happens to be (hy3-free answered 401 "Model hy3-free is not
      // supported", deepseek-v4-flash-free answers 400 "Model is unavailable.").
      // The wording must be about the MODEL: laguna-s-2.1-free's transient 503
      // reads "Endpoint is unavailable." and must stay "unknown".
      if (res.status === 404 || /model\b[^.]{0,64}(is unavailable|not supported|not found|does not exist)/i.test(text)) {
        return "gone";
      }
      // Auth/billing rejection = verified not free. Anything else (5xx, rate
      // limit) says nothing about pricing — treat as unknown.
      return [401, 402, 403].includes(res.status) ? "paid" : "unknown";
    }
    let json;
    try { json = await res.json(); } catch { return "unknown"; }
    // Anonymous 200 means the free tier served it. With a real key even paid
    // models answer, so freeness has to come from the reported cost.
    if (key === "public") return "free";
    return Number(json?.cost ?? 0) === 0 ? "free" : "paid";
  };

  const chatBody = { model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
  const responsesBody = { model: modelId, input: "hi" };
  const settled = (status) => status === "free" || status === "paid";

  const chat = await attempt("/chat/completions", chatBody, "public");
  if (settled(chat)) return { status: chat, api: "openai-completions" };

  // Only retry on the other transport when chat completions did not settle it:
  // a verified "paid" or "free" answer is final, and a second call would spend
  // another request against the shared free quota. "gone" is not final here —
  // Responses-API-only models can reject the chat transport outright.
  const responses = await attempt("/responses", responsesBody, "public");
  if (settled(responses)) return { status: responses, api: "openai-responses" };

  // Anonymous probing was inconclusive on both transports. A configured key can
  // still settle it (at the cost of one output token on paid models).
  if (apiKey) {
    const keyedChat = await attempt("/chat/completions", chatBody, apiKey);
    if (settled(keyedChat)) return { status: keyedChat, api: "openai-completions" };
    const keyedResponses = await attempt("/responses", responsesBody, apiKey);
    if (settled(keyedResponses)) return { status: keyedResponses, api: "openai-responses" };
    if (keyedChat === "gone" && keyedResponses === "gone") return { status: "gone", api: "openai-completions" };
    return { status: "unknown", api: "openai-completions" };
  }
  // Only call it gone when BOTH transports said so: one "gone" plus one
  // inconclusive answer could still be a transport quirk plus an outage.
  if (chat === "gone" && responses === "gone") return { status: "gone", api: "openai-completions" };
  return { status: "unknown", api: "openai-completions" };
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
function makeDiscoveredModel(id, api = "openai-completions", limits = {}) {
  const contextWindow = limits.contextWindow ?? 131072;
  const maxTokens = Math.min(limits.maxTokens ?? 65536, contextWindow);
  return {
    id,
    name: id,
    api,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

// Zen's /v1/models carries no limits at all (only id/object/created/owned_by),
// so an auto-discovered model used to be registered with flat 128K/64K guesses —
// wrong in both directions (nemotron-* really take 1M of context, big-pickle
// really accepts 131072 completion tokens). The gateway does name its real
// ceilings when a request exceeds them, and rejects before generating anything,
// so one deliberately over-budget request buys accurate metadata for free.
// Both observed shapes are parsed:
//   "max_tokens is too large: N. This model supports at most 131072 completion tokens…"
//   "This endpoint's maximum context length is 262144 tokens. However, you requested…"
function parseZenLimits(text) {
  const limits = {};
  const output = /at most (\d+) (?:completion|output) tokens/i.exec(text);
  if (output) limits.maxTokens = Number(output[1]);
  const context = /maximum context length is (\d+) tokens/i.exec(text);
  if (context) limits.contextWindow = Number(context[1]);
  return limits;
}

async function discoverZenLimits(modelId, api, signal) {
  const path = api === "openai-responses" ? "/responses" : "/chat/completions";
  const body = api === "openai-responses"
    ? { model: modelId, input: "hi", max_output_tokens: 99999999 }
    : { model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 99999999 };
  try {
    const res = await fetch(`${ZEN_BASE_URL}${path}`, {
      method: "POST",
      headers: zenRequestHeaders(),
      body: JSON.stringify(body),
      signal: boundedSignal(20000, signal),
    });
    // A 200 would mean the ceiling is above our absurd ask; nothing to learn,
    // and the response is a real (free) completion, so just ignore it.
    if (res.ok) return {};
    const limits = parseZenLimits(await res.text());
    // Never let a parsed output ceiling exceed the context window.
    if (limits.maxTokens && limits.contextWindow) {
      limits.maxTokens = Math.min(limits.maxTokens, limits.contextWindow);
    }
    return limits;
  } catch {
    return {};
  }
}
// Verify the whole live Zen list by probing every id. Curated entries keep their
// hand-verified metadata; unknown ones get their limits discovered from the
// gateway. This catches models that switched from free to paid while staying
// listed — they are dropped exactly like renamed/removed ones.
//
// A probe that came back "unknown" (5xx, rate limit, timeout) says nothing about
// pricing, so a curated model is KEPT on unknown: a single upstream hiccup used
// to silently remove a vouched model from the session's catalog (observed with
// laguna-s-2.1-free answering 503 "Endpoint is unavailable."). Non-curated
// unknowns are still skipped — nothing is known about them, so registering them
// would be a guess.
async function verifyZenModels(liveIds, signal) {
  const known = new Map(ZEN_FREE_MODELS.map((m) => [m.id, m]));
  const ids = [...liveIds];
  const probes = await mapLimit(ids, 12, (id) => probeFreeStatus(id, signal));
  const verified = [];
  const discovered = [];
  for (let i = 0; i < ids.length; i++) {
    const probe = probes[i];
    const curated = known.get(ids[i]);
    if (probe?.status === "paid" || probe?.status === "gone") continue;
    if (probe?.status !== "free" && !curated) continue;
    if (curated) {
      // A model that only answers on /responses must be registered with that
      // api, otherwise the chat-completions transport is used at runtime and
      // every request fails. An unknown probe carries no usable api signal, so
      // the curated value stands.
      const api = probe?.status === "free" ? probe.api : curated.api;
      verified.push(api === curated.api ? curated : { ...curated, api });
    } else {
      discovered.push({ id: ids[i], api: probe.api });
    }
  }
  const limits = await mapLimit(discovered, 6, (m) => discoverZenLimits(m.id, m.api, signal));
  discovered.forEach((m, index) => verified.push(makeDiscoveredModel(m.id, m.api, limits[index] ?? {})));
  if (verified.length) return verified;
  const kept = ZEN_FREE_MODELS.filter((m) => liveIds.has(m.id));
  return kept.length ? kept : ZEN_FREE_MODELS;
}

// ── Extension entry ──
// ── Non-blocking startup: register curated/cached lists immediately, then
// drift-detect live in the background so Pi never waits on the network. ──

const OPENCODE_CACHE_FILE = join(homedir(), ".pi", "cache", "opencode-native-models.json");
const OPENCODE_CACHE_TTL = 24 * 60 * 60 * 1000;
// Re-verifying costs one probe request per live Zen model (~60) against a free
// tier that is shared between all anonymous users, so doing it on every pi
// launch burns quota that the user would rather spend on actual completions.
// A fresh cache is trusted for this long before another sweep is scheduled.
const OPENCODE_VERIFY_TTL = 6 * 60 * 60 * 1000;

function cacheIsFresh(cache, ttl) {
  return !!cache && typeof cache.timestamp === "number" && Date.now() - cache.timestamp < ttl;
}

function loadCache() {
  try {
    const data = JSON.parse(readFileSync(OPENCODE_CACHE_FILE, "utf-8"));
    if (!data || typeof data.timestamp !== "number") return null;
    if (Date.now() - data.timestamp > OPENCODE_CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCache(models) {
  try {
    const dir = dirname(OPENCODE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Drop the derived fields before writing. `opencodeLiveModel` holds the
    // entire upstream /v1/models object for every model, which bloated the
    // cache for no benefit, and `capabilities` is recomputed on load anyway.
    const slim = {};
    for (const [key, list] of Object.entries(models)) {
      slim[key] = Array.isArray(list)
        ? list.map(({ opencodeLiveModel: _live, capabilities: _caps, ...rest }) => rest)
        : list;
    }
    writeFileSync(OPENCODE_CACHE_FILE, JSON.stringify({ timestamp: Date.now(), ...slim }));
  } catch {
    // best-effort; the cache is an optimization, never required
  }
}

function curatedModels() {
  return {
    zen: ZEN_FREE_MODELS,
    sensenova: SENSENOVA_MODELS,
  };
}

// Cached entries win field-by-field (the verify pass corrects `api` and the
// token limits from live probes), but fields the cache has never heard of fall
// back to the curated entry. Without this, adding a key to the allowlist —
// thinkingLevelMap was the case that exposed it — stayed invisible until the
// cache aged out, because a whole cached model object replaced the curated one.
function mergeCachedList(cached, curated) {
  if (!Array.isArray(cached)) return curated;
  const byId = new Map(curated.map((model) => [model.id, model]));
  return cached.map((model) => {
    const base = byId.get(model.id);
    return base ? { ...base, ...model } : model;
  });
}

function initialModels() {
  const cache = loadCache();
  if (!cache) return curatedModels();
  const curated = curatedModels();
  return {
    zen: mergeCachedList(cache.zen, curated.zen),
    sensenova: mergeCachedList(cache.sensenova, curated.sensenova),
  };
}

// Derive a capabilities block from model metadata. Image-generation models
// carry explicit opencodeImageModel metadata because their upstream endpoint
// is not chat completions; SenseNova's u1 models use the native
// /images/generations|edits paths. Unknown providers remain conservative.
function withCapabilities(model) {
  const live = model.opencodeLiveModel ?? {};
  const asArray = (value) => Array.isArray(value) ? value.map(String).map((item) => item.toLowerCase()) : [];
  const inputModalities = asArray(live.input_modalities ?? live.inputModalities ?? model.input);
  const outputModalities = asArray(live.output_modalities ?? live.outputModalities);
  const featureValues = [
    ...asArray(live.supported_features),
    ...asArray(live.features),
    ...asArray(live.capabilities),
  ];
  const type = String(live.type ?? live.model_type ?? "").toLowerCase();
  const has = (...names) => {
    const wanted = names.map((name) => name.toLowerCase());
    return wanted.some((name) => featureValues.includes(name)) || wanted.some((name) => live?.[name] === true);
  };
  const vision = model.opencodeImageModel ? false : inputModalities.includes("image") || live.multimodal === true;
  const image = model.opencodeImageModel === true || outputModalities.includes("image") ||
    type === "image" || live.supports_image_generation === true || has("image_generation");
  const video = model.opencodeVideoModel === true || outputModalities.includes("video") ||
    type === "video" || live.supports_video === true || has("video");
  const audio = model.opencodeAudioModel === true || model.opencodeTranscriptionModel === true || inputModalities.includes("audio") || outputModalities.includes("audio") ||
    type === "audio" || live.supports_audio === true || has("audio", "speech", "transcription");
  // Native image/video/audio models never reach chat completions, so they
  // cannot run tools no matter what the gateway advertises — SenseNova reports
  // a generic supported_features: ["tools", ...] for its image models too.
  const nativeEndpoint = model.opencodeImageModel === true ||
    model.opencodeVideoModel === true ||
    model.opencodeAudioModel === true ||
    model.opencodeTranscriptionModel === true;
  const tools = nativeEndpoint
    ? false
    : live.features?.tools === false || live.capabilities?.tools === false
      ? false
      : model.tools !== false;
  return {
    ...model,
    capabilities: {
      tools,
      vision,
      image,
      video,
      audio,
      reasoning: !!model.reasoning || live.reasoning === true || live.supports_reasoning === true,
    },
  };
}

function registerAll(pi, m) {
  appendNativeImage = (image) => pi.appendEntry("opencode-generated-image", image);
  pi.registerEntryRenderer("opencode-generated-image", (entry, _options, theme) => {
    const image = entry.data ?? {};
    try {
      const data = readFileSync(image.path).toString("base64");
      // Image.render calls theme.fallbackColor(), but the global `theme` passed
      // to entry renderers does not define it (pi bug). Provide a compatible
      // wrapper so the inline image preview renders and we never crash.
      const imageTheme = theme && typeof theme.fallbackColor === "function"
        ? theme
        : { fallbackColor: (s) => (theme && theme.fg ? theme.fg("toolOutput", s) : s) };
      return new Image(data, image.mimeType || "image/png", imageTheme, { maxWidthCells: 80, maxHeightCells: 30 });
    } catch {
      const unavailablePath = image.path ?? "unknown path";
      return new Markdown(`Generated image unavailable: ${fileLink(unavailablePath)}`, 1, 0, getMarkdownTheme());
    }
  });
  // Augment each model with a capabilities block (derived from reasoning/input).
  for (const key of Object.keys(m)) {
    if (Array.isArray(m[key])) m[key] = m[key].map(withCapabilities);
  }
  pi.registerProvider("opencode-zen", {
    name: "OpenCode Zen (native headers)",
    apiKey: "public",
    baseUrl: ZEN_BASE_URL,
    api: "openai-completions",
    // Responses-API-only models carry api: "openai-responses", which pi routes
    // through its own transport instead of streamSimple. Declare the OpenCode
    // identity headers at provider level so that path is not treated as a
    // generic client and rate-limited.
    headers: { ...OPENCODE_STATIC_HEADERS },
    streamSimple: streamOpenCode,
    models: m.zen,
  });
  pi.registerProvider("sensenova", {
    name: "SenseNova (商汤日日新)",
    apiKey: "public",
    baseUrl: "https://token.sensenova.cn/v1",
    api: "openai-completions",
    streamSimple: streamSenseNova,
    models: m.sensenova,
  });
}

// ---------------------------------------------------------------------------
// /model-capabilities — per-model capability table across all providers
// ---------------------------------------------------------------------------

const OPENCODE_PROVIDER_IDS = [
  "opencode-zen",
  "sensenova",
];

const OPENCODE_SESSION_USAGE = new Map();
let opencodeUsageHookInstalled = false;

function showModelMarkdown(pi, ctx, key, markdown) {
  if (ctx.mode === "tui") pi.appendEntry(key, { markdown });
  else if (ctx.hasUI) ctx.ui.notify(markdown, "info");
  else console.log(markdown);
}

function formatPrice(value) {
  if (value === undefined || value === null) return "—";
  if (Number(value) === 0) return "free/0";
  return `$${Number(value).toFixed(4)}`;
}

function registerPricesCommand(pi) {
  pi.registerCommand("model-prices", {
    description: "List model catalog prices per 1M tokens; optional provider filter",
    handler: async (args, ctx) => {
      const provider = (args || "").trim().split(/\\s+/).find((token) => OPENCODE_PROVIDER_IDS.includes(token));
      const models = (ctx.modelRegistry?.getAvailable?.() ?? []).filter((model) =>
        OPENCODE_PROVIDER_IDS.includes(model.provider) && (!provider || model.provider === provider),
      );
      const rows = models.sort((a, b) => a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)).map((model) => ({
        provider: model.provider,
        id: model.id,
        input: model.cost?.input,
        output: model.cost?.output,
        total: (Number(model.cost?.input) || 0) + (Number(model.cost?.output) || 0),
        context: model.contextWindow ?? 0,
      }));
      const markdown = [
        `# Model catalog prices${provider ? ` (${provider})` : ""}`,
        "",
        "_Catalog values are USD per 1M tokens. Zero means the curated catalog marks the model free; `—` means no price metadata._",
        "",
        "| Provider | Model | Input | Output | Total | Context |",
        "|---|---|---:|---:|---:|---:|",
        ...rows.map((row) => `| ${row.provider} | ${row.id} | ${formatPrice(row.input)} | ${formatPrice(row.output)} | ${formatPrice(row.total)} | ${row.context ? `${Math.round(row.context / 1000)}K` : "—"} |`),
        "",
        rows.length ? "" : "_No registered models match the filter._",
      ].join("\n");
      showModelMarkdown(pi, ctx, "model-prices", markdown);
    },
  });
  pi.registerEntryRenderer("model-prices", (entry) => new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
}

function installUsageTracker(pi) {
  if (opencodeUsageHookInstalled || typeof pi.on !== "function") return;
  opencodeUsageHookInstalled = true;
  pi.on("message_end", (event) => {
    const message = event?.message;
    if (message?.role !== "assistant" || !OPENCODE_PROVIDER_IDS.includes(message.provider)) return;
    const key = `${message.provider}/${message.model}`;
    const previous = OPENCODE_SESSION_USAGE.get(key) ?? { provider: message.provider, model: message.model, input: 0, output: 0, total: 0, cost: 0, turns: 0 };
    const usage = message.usage ?? {};
    const cost = usage.cost ?? {};
    const turnInput = Number(usage.input) || 0;
    const turnOutput = Number(usage.output) || 0;
    const turnTotal = Number(usage.totalTokens) || turnInput + turnOutput;
    previous.input += turnInput;
    previous.output += turnOutput;
    previous.total += turnTotal;
    previous.cost += Number(cost.total) || 0;
    previous.turns += 1;
    OPENCODE_SESSION_USAGE.set(key, previous);
  });
}

function registerUsageCommand(pi) {
  pi.registerCommand("model-usage", {
    description: "Show model token/cost usage accumulated in the current Pi process",
    handler: async (_args, ctx) => {
      const rows = [...OPENCODE_SESSION_USAGE.values()].sort((a, b) => a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider));
      const total = rows.reduce((sum, row) => sum + row.cost, 0);
      const markdown = [
        "# Model session usage",
        "",
        "_This is process/session usage from assistant messages, not a provider billing dashboard. Provider billing APIs are not uniform._",
        "",
        "| Provider | Model | Turns | Input tokens | Output tokens | Total tokens | Cost |",
        "|---|---|---:|---:|---:|---:|---:|",
        ...rows.map((row) => `| ${row.provider} | ${row.model} | ${row.turns} | ${row.input.toLocaleString()} | ${row.output.toLocaleString()} | ${row.total.toLocaleString()} | $${row.cost.toFixed(6)} |`),
        "",
        rows.length ? `**Session total:** $${total.toFixed(6)}` : "_No assistant usage recorded in this Pi process yet._",
      ].join("\n");
      showModelMarkdown(pi, ctx, "model-usage", markdown);
    },
  });
  pi.registerEntryRenderer("model-usage", (entry) => new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
}

function registerCapabilitiesCommand(pi) {
  const flags = {
    reasoning: "reasoning",
    vision: "vision",
    image: "image",
    video: "video",
    audio: "audio",
    tools: "tools",
  };

  pi.registerCommand("model-capabilities", {
    description:
      "List model capabilities (vision/image/video/audio/tools/reasoning) across all providers; e.g. /model-capabilities vision",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in flags);
      const models = (ctx.modelRegistry?.getAvailable?.() ?? []).filter((m) =>
        OPENCODE_PROVIDER_IDS.includes(m.provider),
      );

      const rows = models
        .map((model) => {
          const caps = model.capabilities ?? {};
          return {
            provider: model.provider,
            id: model.id,
            reasoning: caps.reasoning ? "✓" : "",
            vision: caps.vision ? "✓" : "",
            image: caps.image ? "✓" : "",
            video: caps.video ? "✓" : "",
            audio: caps.audio ? "✓" : "",
            tools: caps.tools ? "✓" : "",
          };
        })
        .filter((row) => !filter || row[flags[filter]] === "✓")
        .sort((a, b) =>
          a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
        );

      const markdown = [
        `# Model capabilities${filter ? ` (filter: ${filter})` : ""}`,
        "",
        "| Provider | Model | Reasoning | Vision | Image | Video | Audio | Tools |",
        "|---|---|:---:|:---:|:---:|:---:|:---:|:---:|",
        ...rows.map(
          (row) =>
            `| ${row.provider} | ${row.id} | ${row.reasoning || "—"} | ${row.vision || "—"} | ${row.image || "—"} | ${row.video || "—"} | ${row.audio || "—"} | ${row.tools || "—"} |`,
        ),
        "",
        "_Capabilities are derived from each curated model's reasoning/input fields; SenseNova's u1 image models use their native generation endpoints._",
      ].join("\n");

      if (ctx.mode === "tui") {
        pi.appendEntry("model-capabilities", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        console.log(markdown);
      }
    },
  });

  pi.registerEntryRenderer("model-capabilities", (entry) => {
    const mdTheme = getMarkdownTheme();
    return new Markdown(entry.data.markdown, 1, 0, mdTheme);
  });
}

// Background drift/probe pass. Best-effort: a failure leaves the already
// registered (curated or cached) models untouched, so the user is never blocked.
async function verifyAndUpdateModels(pi) {
  // Overall safety net so a pathological network can never strand this task.
  // This must be threaded into every request. The budget has to cover the whole
  // Zen sweep: ~60 ids probed 12 at a time (20s each) plus a limit-discovery
  // request per newly discovered model. 45s was tight enough that a slow round
  // could be cut off mid-sweep, which used to shrink the catalog; the pass runs
  // in the background, so a generous ceiling costs nothing.
  const signal = AbortSignal.timeout(180000);
  const zenHeaders = {
    ...OPENCODE_STATIC_HEADERS,
    ...authHeader("OPENCODE_API_KEY", "opencode-zen"),
  };
  const [zenLive, sensenovaModels] = await Promise.all([
    fetchLiveModelIdsResilient(`${ZEN_BASE_URL}/models`, zenHeaders, signal),
    filterToLive(SENSENOVA_MODELS, "https://token.sensenova.cn/v1/models", authHeader("SENSENOVA_API_KEY", "sensenova"), signal),
  ]);
  const zenModels = zenLive ? await verifyZenModels(zenLive, signal) : ZEN_FREE_MODELS;
  const verified = {
    zen: zenModels,
    sensenova: sensenovaModels,
  };
  registerAll(pi, verified);
  saveCache(verified);
}

// ── Extension entry ──
export default function (pi) {
  // Register immediately with the curated allowlists (or a fresh on-disk cache)
  // so Pi startup is never blocked on network model discovery. The live
  // drift/probe pass runs in the background and hot-swaps the catalog without a
  // /reload.
  const cache = loadCache();
  registerAll(pi, initialModels());
  registerCapabilitiesCommand(pi);
  registerPricesCommand(pi);
  installUsageTracker(pi);
  registerUsageCommand(pi);
  // A recent sweep already answered the same questions, and re-probing every
  // Zen model eats the shared anonymous quota. `/model-refresh` forces one.
  if (!cacheIsFresh(cache, OPENCODE_VERIFY_TTL)) {
    setTimeout(() => {
      verifyAndUpdateModels(pi).catch(() => {});
    }, 100);
  }
  pi.registerCommand("model-refresh", {
    description: "Re-run the live model verification pass now (ignores the 6h cache)",
    handler: async (_args, ctx) => {
      const before = Date.now();
      await verifyAndUpdateModels(pi).catch((error) => {
        showModelMarkdown(pi, ctx, "model-refresh", `Model refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
      const seconds = ((Date.now() - before) / 1000).toFixed(1);
      showModelMarkdown(pi, ctx, "model-refresh", `Model catalog re-verified in ${seconds}s.`);
    },
  });
  pi.registerEntryRenderer("model-refresh", (entry) => new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
}