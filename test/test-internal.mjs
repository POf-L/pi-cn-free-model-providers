// 真实测试 zen-proxy-internal.ts 的行为（官方 opencode 渠道 + 按轮清洗）
import { createServer } from "node:http";
import assert from "node:assert/strict";

let captured = { headers: null, body: null };

// ---- 本地 echo server ----
const server = createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured = {
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const echoURL = `http://127.0.0.1:${server.address().port}`;

const plugin = await (await import("../zen-proxy-internal.ts")).default({});
console.log("✓ hooks =", Object.keys(plugin));

// ============ config ============
const config = { provider: {} };
await plugin.config(config);
const provider = config.provider.opencode;
assert.equal(typeof provider.options.fetch, "function");
assert.ok(!("baseURL" in provider.options), "baseURL untouched");
console.log("✓ config hook ok");

// ============ chat.headers ============
{
  const out = { headers: {} };
  await plugin["chat.headers"]({ model: { providerID: "opencode" }, sessionID: "sess-1" }, out);
  assert.equal(out.headers["x-session-id"], "sess-1");
  const out2 = { headers: {} };
  await plugin["chat.headers"]({ model: { providerID: "anthropic" }, sessionID: "s" }, out2);
  assert.deepEqual(out2.headers, {}, "non-opencode untouched");
  console.log("✓ chat.headers ok");
}

const cleanFetch = provider.options.fetch;
const req = () =>
  cleanFetch(echoURL + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-session-id": "ses_REAL",
      "x-opencode-session": "ses_REAL",
      "x-parent-session-id": "ses_REAL",
      "x-opencode-project": "proj_REAL",
      "x-request-id": "req-in",
    },
    body: JSON.stringify({ model: "big-pickle", messages: [], user: "a@b.c", metadata: {} }),
  });

// ============ 一轮内稳定 ============
await plugin["chat.message"]({ sessionID: "s", messageID: "msg-1" });
await req();
const r1a = { ...captured.headers };
await req();
const r1b = captured.headers;

assert.equal(r1b["x-session-id"], r1a["x-session-id"], "session stable in round");
assert.equal(r1b["x-opencode-project"], r1a["x-opencode-project"], "project stable in round");
assert.equal(r1b["x-request-id"], r1a["x-request-id"], "request-id stable in round (no per-request change)");
console.log("✓ round 1: session/project/request-id all stable across requests");

// 同 messageID 重复触发不轮换
await plugin["chat.message"]({ sessionID: "s", messageID: "msg-1" });
await req();
assert.equal(captured.headers["x-session-id"], r1a["x-session-id"], "same messageID re-fire must NOT rotate");
console.log("✓ re-fire same messageID does not rotate");

// ============ 新消息 → 轮换 ============
await plugin["chat.message"]({ sessionID: "s", messageID: "msg-2" });
await req();
const r2 = captured.headers;
assert.notEqual(r2["x-session-id"], r1a["x-session-id"], "new round -> new fake session");
assert.notEqual(r2["x-opencode-project"], r1a["x-opencode-project"], "new round -> new fake project");
assert.notEqual(r2["x-request-id"], r1a["x-request-id"], "new round -> new request-id");
console.log("✓ round 2: all identities rotate on new user message");

// ============ body sanitize + hop 头 ============
{
  const got = JSON.parse(captured.body);
  assert.ok(!("user" in got) && !("metadata" in got), "user/metadata removed");
  assert.ok(!("upgrade" in captured.headers) && !("keep-alive" in captured.headers), "hop headers stripped");
  assert.ok(captured.headers["x-session-id"].startsWith("ses_"));
  assert.ok(captured.headers["x-opencode-project"].startsWith("proj_"));
  assert.ok(captured.headers["x-request-id"].startsWith("req_"));
  console.log("✓ body sanitize + hop-header stripping + prefixes ok");
}

server.close();
console.log("\n=== ALL TESTS PASSED (round-based cleaning) ===");
