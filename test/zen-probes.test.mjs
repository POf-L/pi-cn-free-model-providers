import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Exercise the production probe helpers without loading the TUI or scheduling
// live catalog refreshes. Only the tool factory and HTTP transport are fixtures.
const source = readFileSync(new URL("../pi-cn-free-model-providers-ext.mjs", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
}
function harness(fetch = () => { throw new Error("unexpected network call"); }, cache = null, overrides = {}) {
  return vm.runInNewContext([
    section("const EFFORT_LEVELS_ALL =", "const SENSENOVA_MODELS ="),
    section("function normalizeTools(", "// ── SSE parsing"),
    section("function handleSSELine(", "// ── Shared output factory"),
    section("function zenRequestHeaders(", "// Run async fn"),
    section("async function mapLimit(", "// ── Extension entry"),
    section("const OPENCODE_CACHE_TTL =", "function loadCache("),
    section("function curatedModels(", "// Derive a capabilities block"),
    section("async function verifyAndUpdateModels(", "// Pi's built-in summarizer"),
    section("async function compactZenContext(", "// ── Extension entry"),
    "({ consumeSSEStream, zenRequestHeaders, zenProbePath, zenProbeBody, zenProbeErrorStatus, readZenProbeResult, probeFreeStatus, mergeCachedList, mergeCachedStrict, initialModels, verifyZenModels, zenCacheIsVerified, verifyAndUpdateModels, compactZenContext, handleZenCompaction, ZEN_FREE_MODELS })",
  ].join("\n"), {
    process: { cwd: () => "/probe", env: {} }, fetch, TextDecoder, AbortSignal,
    loadCache: () => cache,
    authHeader: () => ({}),
    filterToLive: async () => [{ id: "test-sensenova" }],
    SENSENOVA_MODELS: [{ id: "test-sensenova" }],
    ZEN_BASE_URL: "http://test.invalid/v1",
    boundedSignal: () => undefined,
    openCodeHeaders: () => ({ "x-opencode-session": "ses_0123456789abABCDEFGHIJKLMN" }),
    createCodingTools: () => ["read", "bash", "edit", "write"].map((name) => ({
      name, description: name, parameters: { type: "object", properties: {} },
      execute() { throw new Error("probes must not execute tools"); },
    })),
    ...overrides,
  });
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const sse = (payloads, done = true) => new Response(
  payloads.map((p) => `data: ${JSON.stringify(p)}\r\n\r\n`).join("") + (done ? "data: [DONE]\r\n\r\n" : ""),
  { headers: { "content-type": "text/event-stream" } },
);
const chunk = { choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] };
const verifiedCache = (zen) => ({
  timestamp: Date.now(), zen, sensenova: [{ id: "test-sensenova" }],
  zenVerification: { version: 2, baseUrl: "http://test.invalid/v1", checkedAt: Date.now() },
});

test("stream stops at DONE without waiting for an open connection to close", { timeout: 1000 }, async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); },
    cancel() { cancelled = true; },
  });
  await harness().consumeSSEStream({ output: {} }, stream.getReader());
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("stream handles split chunks and a final line without a newline", async () => {
  const state = { output: {} };
  const stream = new ReadableStream({
    start(controller) {
      for (const text of ["da", 'ta: {"choices":[{"finish_', 'reason":"length"}]}']) {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });
  await harness().consumeSSEStream(state, stream.getReader());
  assert.equal(state.output.stopReason, "length");
  assert.equal(stream.locked, false);
});

test("all probe transports stream and carry the coding tool schemas", () => {
  const api = harness();
  const chat = api.zenProbeBody("test", "openai-completions");
  const responses = api.zenProbeBody("test", "openai-responses");
  assert.equal(chat.stream, true);
  assert.equal(chat.max_tokens, 1);
  assert.deepEqual(plain(chat.tools.map((t) => t.function.name)), ["read", "bash", "edit", "write"]);
  assert.equal(responses.stream, true);
  assert.equal(responses.max_output_tokens, 16);
  assert.deepEqual(plain(responses.tools.map((t) => t.name)), ["read", "bash", "edit", "write"]);
  assert.ok(responses.tools.every((t) => t.strict === false && !t.function && !t.execute));
  const messages = api.zenProbeBody("test-claude", "anthropic-messages");
  assert.equal(messages.stream, true);
  assert.equal(messages.max_tokens, 1);
  assert.deepEqual(plain(messages.tools.map((t) => t.name)), ["read", "bash", "edit", "write"]);
  assert.ok(messages.tools.every((t) => t.input_schema.type === "object" && !t.function && !t.execute));
  assert.equal(messages.stream_options, undefined);
});

test("Anthropic probes use the Messages endpoint and native authentication headers", () => {
  const api = harness();
  assert.equal(api.zenProbePath("anthropic-messages"), "/messages");
  assert.equal(api.zenProbePath("openai-responses"), "/responses");
  assert.equal(api.zenProbePath("openai-completions"), "/chat/completions");
  const headers = api.zenRequestHeaders("public", "anthropic-messages");
  assert.equal(headers["x-api-key"], "public");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.ok(headers["x-opencode-session"]);
  assert.equal(headers.Authorization, undefined);
  assert.equal(api.zenRequestHeaders().Authorization, "Bearer public");
});

test("access restrictions and generic 403 are not classified as paid", () => {
  const { zenProbeErrorStatus: classify } = harness();
  for (const type of ["FreeTierError", "RegionError", "UpgradeRequired", "RateLimitError", "Forbidden"]) {
    assert.equal(classify(403, JSON.stringify({ type })), "unknown", type);
  }
  assert.equal(classify(401, '{"type":"AuthError","message":"Missing API key"}'), "paid");
  assert.equal(classify(402, "payment required"), "paid");
  assert.equal(classify(400, "Model is unavailable."), "gone");
  assert.equal(classify(503, "Endpoint is unavailable."), "unknown");
});

test("anonymous complete SSE is free, incomplete and error SSE are unknown", async () => {
  const { readZenProbeResult: read } = harness();
  assert.equal(await read(sse([chunk]), "public"), "free");
  assert.equal(await read(sse([chunk], false), "public"), "unknown");
  assert.equal(await read(sse([{ error: { type: "FreeTierError" } }]), "public"), "unknown");
  assert.equal(await read(sse([{ type: "response.completed", response: { status: "completed", cost: "0" } }], false), "public"), "free");
});

test("keyed success needs explicit valid cost", async () => {
  const { readZenProbeResult: read } = harness();
  assert.equal(await read(sse([chunk]), "test-key"), "unknown");
  assert.equal(await read(sse([chunk, { cost: "0" }]), "test-key"), "free");
  assert.equal(await read(sse([chunk, { cost: "0.1" }]), "test-key"), "paid");
  assert.equal(await read(sse([chunk, { cost: "unknown" }]), "test-key"), "unknown");
});

test("Anthropic SSE requires a message and terminal event, with explicit cost for keyed calls", async () => {
  const { readZenProbeResult: read } = harness();
  const start = { type: "message_start", message: { type: "message", content: [] } };
  const stop = { type: "message_stop" };
  assert.equal(await read(sse([start, stop], false), "public"), "free");
  assert.equal(await read(sse([start], false), "public"), "unknown");
  assert.equal(await read(sse([stop], false), "public"), "unknown");
  assert.equal(await read(sse([start, { type: "error", error: { type: "FreeTierError" } }, stop], false), "public"), "unknown");
  assert.equal(await read(sse([start, stop], false), "test-key"), "unknown");
  for (const [cost, status] of [["0", "free"], ["0.1", "paid"]]) {
    const priced = { ...start, message: { ...start.message, cost } };
    assert.equal(await read(sse([priced, stop], false), "test-key"), status);
  }
});

test("preferred native Responses transport is probed first", async () => {
  const calls = [];
  const api = harness(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return sse([{ type: "response.completed", response: { status: "completed" } }], false);
  });
  assert.deepEqual(plain(await api.probeFreeStatus("muse", undefined, "openai-responses")), { status: "free", api: "openai-responses" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/responses$/);
  assert.equal(calls[0].body.stream, true);
});

test("preferred Anthropic transport is probed first", async () => {
  const calls = [];
  const api = harness(async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return sse([
      { type: "message_start", message: { type: "message", content: [] } },
      { type: "message_stop" },
    ], false);
  });
  assert.deepEqual(plain(await api.probeFreeStatus("test-claude", undefined, "anthropic-messages")), { status: "free", api: "anthropic-messages" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/messages$/);
  assert.equal(calls[0].headers["x-api-key"], "public");
  assert.equal(calls[0].body.model, "test-claude");
  assert.ok(calls[0].body.tools.every((t) => t.input_schema));
});

test("a rejected chat endpoint can fall back to Responses", async () => {
  const api = harness(async (url) => url.endsWith("/responses")
    ? sse([{ type: "response.completed", response: { status: "completed" } }], false)
    : new Response("Model is unavailable.", { status: 400 }));
  assert.deepEqual(plain(await api.probeFreeStatus("test")), { status: "free", api: "openai-responses" });
});

test("all blocked transports keep an unknown model status", async () => {
  const api = harness(async () => new Response('{"type":"FreeTierError"}', { status: 403 }));
  assert.equal((await api.probeFreeStatus("test")).status, "unknown");
});

test("cache overrides discovered fields without losing curated defaults", () => {
  const api = harness();
  const result = api.mergeCachedList(
    [{ id: "known", maxTokens: 4096 }, { id: "discovered", maxTokens: 8192 }],
    [{ id: "known", maxTokens: 1024, reasoning: true }, { id: "missing", maxTokens: 2048 }],
  );
  assert.deepEqual(plain(result), [
    { id: "known", maxTokens: 4096, reasoning: true },
    { id: "missing", maxTokens: 2048 },
    { id: "discovered", maxTokens: 8192 },
  ]);
});

test("strict cache never restores a curated model that failed its probe", () => {
  const api = harness();
  const result = api.mergeCachedStrict(
    [{ id: "known", maxTokens: 4096 }, { id: "discovered", maxTokens: 8192 }],
    [{ id: "known", maxTokens: 1024, reasoning: true }, { id: "missing", maxTokens: 2048 }],
  );
  assert.deepEqual(plain(result), [
    { id: "known", maxTokens: 4096, reasoning: true },
    { id: "discovered", maxTokens: 8192 },
  ]);
});

test("strict startup shows only the last proven-free Zen set", () => {
  const free = [{ id: "big-pickle", maxTokens: 4096 }];
  const api = harness(undefined, verifiedCache(free));
  const result = api.initialModels();
  assert.ok(!result.zen.some((m) => m.id === "union-alpha"));
  assert.ok(!result.zen.some((m) => m.id === "muse-spark-1.3-contributor-free"));
  assert.equal(result.zen.find((m) => m.id === "big-pickle").maxTokens, 4096);
  const unverified = harness(undefined, null).initialModels();
  // When cache is absent, seed with curated models so models are available immediately
  assert.ok(unverified.zen.length > 0);
});

test("strict verification keeps only free models and never falls back to curated", async () => {
  const api = harness(async (url, init) => {
    const model = JSON.parse(init.body).model;
    if (model === "big-pickle") return sse([chunk]);
    if (model === "new-free") {
      return sse([{ type: "response.completed", response: { status: "completed" } }], false);
    }
    return new Response('{"type":"FreeTierError"}', { status: 403 });
  });
  const result = await api.verifyZenModels(new Set(["big-pickle", "new-free", "union-alpha", "muse-spark-1.3-contributor-free"]));
  assert.deepEqual(plain(result.map((m) => m.id).sort()), ["big-pickle", "new-free"]);
  const none = harness(async () => new Response('{"type":"FreeTierError"}', { status: 403 }));
  assert.deepEqual(plain(await none.verifyZenModels(new Set(["big-pickle", "union-alpha"]))), []);
});

test("legacy, expired, wrong-version and different-route caches are not verification evidence", () => {
  const current = verifiedCache([{ id: "union-alpha" }]);
  const variants = [
    { ...current, zenVerification: undefined },
    { ...current, zenVerification: { ...current.zenVerification, version: 1 } },
    { ...current, zenVerification: { ...current.zenVerification, baseUrl: "https://other.invalid/v1" } },
    { ...current, zenVerification: { ...current.zenVerification, checkedAt: Date.now() - 7 * 3600000 } },
    { ...current, zenVerification: { ...current.zenVerification, checkedAt: Date.now() + 60000 } },
  ];
  for (const cache of variants) {
    const api = harness(undefined, cache);
    assert.equal(api.zenCacheIsVerified(cache), false);
    // If cache is invalid or unverified, it safely falls back to curated models
    assert.ok(api.initialModels().zen.length > 0);
    assert.deepEqual(plain(api.initialModels().sensenova), [{ id: "test-sensenova" }]);
  }
  const api = harness(undefined, verifiedCache([]));
  assert.equal(api.zenCacheIsVerified(verifiedCache([])), true);
  assert.ok(api.initialModels().zen.length > 0);
});

test("cached Muse effort enums cannot override corrected metadata", () => {
  const id = "muse-spark-1.3-contributor-free";
  const api = harness(undefined, verifiedCache([{
    id, maxTokens: 8192, thinkingLevelMap: { off: "none", xhigh: "xhigh", max: null },
  }]));
  const model = api.initialModels().zen[0];
  assert.equal(model.maxTokens, 8192);
  assert.deepEqual(plain(model.thinkingLevelMap), { off: null, xhigh: "xhigh", max: null });
  assert.equal(api.zenProbeBody(id, "openai-responses").reasoning.effort, "minimal");
});

test("failed catalog fetch clears Zen instead of renewing old verification", async () => {
  let registered, saved, proof;
  const api = harness(undefined, verifiedCache([{ id: "union-alpha" }]), {
    fetchLiveModelIdsResilient: async () => null,
    registerAll: (_pi, models) => { registered = models; },
    saveCache: (models, verification) => { saved = models; proof = verification; },
  });
  await api.verifyAndUpdateModels({});
  assert.deepEqual(plain(registered.zen), []);
  assert.deepEqual(plain(saved.sensenova), [{ id: "test-sensenova" }]);
  assert.equal(proof, null);
});

test("successful sweep writes evidence only for its free subset", async () => {
  let saved, proof;
  const api = harness(async (_url, init) => JSON.parse(init.body).model === "big-pickle"
    ? sse([chunk]) : new Response("Model is unavailable.", { status: 400 }), null, {
    fetchLiveModelIdsResilient: async () => new Set(["big-pickle", "union-alpha"]),
    registerAll: () => {},
    saveCache: (models, verification) => { saved = models; proof = verification; },
  });
  await api.verifyAndUpdateModels({});
  assert.deepEqual(plain(saved.zen.map((m) => m.id)), ["big-pickle"]);
  assert.equal(api.zenCacheIsVerified({ ...saved, zenVerification: proof }), true);
});

test("Zen compaction keeps Pi preparation and supplies schemas with tools disabled", async () => {
  const preparation = { firstKeptEntryId: "keep", tokensBefore: 1000 };
  const summary = { summary: "Saved summary", ...preparation, details: { readFiles: [] } };
  const signal = new AbortController().signal;
  let sent;
  const api = harness(undefined, null, {
    compact: async (prep, model, key, headers, instructions, abortSignal, thinking, stream, env) => {
      assert.equal(prep, preparation);
      assert.equal(key, "public");
      assert.equal(instructions, "retain file paths");
      assert.equal(abortSignal, signal);
      assert.equal(thinking, "minimal");
      assert.deepEqual(env, { TEST: "1" });
      stream(model, { messages: [{ role: "user", content: "Summarize" }] }, { headers, apiKey: key, signal });
      return summary;
    },
  });
  const ctx = {
    cwd: "/probe", model: { provider: "opencode-zen", id: "big-pickle" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "public", headers: { "x-test": "keep" }, env: { TEST: "1" } }),
      getProvider: () => ({ streamSimple: (model, context, options) => { sent = { model, context, options }; } }),
    },
  };
  const result = await api.compactZenContext({ preparation, customInstructions: "retain file paths", signal }, ctx, "minimal");
  assert.equal(result.compaction, summary);
  assert.deepEqual(plain(sent.context.tools.map((tool) => tool.name)), ["read", "bash", "edit", "write"]);
  assert.equal(sent.options.toolChoice, "none");
  assert.equal(sent.options.reasoning, "minimal");
  assert.match(sent.context.systemPrompt, /text-only summary/);
  assert.equal(sent.options.headers["x-test"], "keep");
  assert.ok(sent.options.headers["x-opencode-session"]);
  assert.equal(sent.options.signal, signal);
  assert.equal(await api.compactZenContext({}, { model: { provider: "codex-relay" } }), undefined);
});

test("Zen compaction rejects raw tool-call markup before a summary can be saved", async () => {
  const api = harness(undefined, null, {
    compact: async (_prep, model, _key, _headers, _instructions, _signal, _thinking, stream) => {
      const reply = await stream(model, { messages: [] }, {}).result();
      if (reply.stopReason === "error") throw new Error(reply.errorMessage);
      return { summary: reply.content[0].text };
    },
  });
  const ctx = {
    cwd: "/probe", model: { provider: "opencode-zen", id: "big-pickle" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "public" }),
      getProvider: () => ({ streamSimple: () => ({
        result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '\n<｜DSML｜tool_calls><｜DSML｜invoke name="bash">' }] }),
      }) }),
    },
  };
  await assert.rejects(api.compactZenContext({ preparation: {} }, ctx, "off"), /original context was preserved/);
  const messages = [];
  ctx.ui = { notify: (message) => messages.push(message) };
  assert.deepEqual(plain(await api.handleZenCompaction({ preparation: {} }, ctx, "off")), { cancel: true });
  assert.match(messages[0], /tool-call markup/);
});
