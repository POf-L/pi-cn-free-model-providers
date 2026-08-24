import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const python = process.env.ZEN_PROXY_PYTHON || "D:\\Python312\\python.exe";
const script = fileURLToPath(new URL("../zen_proxy.py", import.meta.url));
const captured = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitHealth(url, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (body.service === "zen_proxy") return body;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`代理健康检查超时：${url}`);
}

const upstream = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    captured.push({
      path: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const data = JSON.stringify({ ok: true });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    response.end(data);
  });
});

let proxyPID = null;
let plugin;
try {
  const upstreamPort = await listen(upstream);
  const proxyPort = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });

  process.env.ZEN_PROXY_PORT = String(proxyPort);
  process.env.ZEN_PROXY_PYTHON = python;
  process.env.ZEN_PROXY_SCRIPT = script;
  process.env.ZEN_PROXY_UPSTREAM_URL = `http://127.0.0.1:${upstreamPort}/upstream`;

  plugin = await (await import("../zen-proxy-internal.ts")).default({});
  const config = { provider: { opencode: { options: { apiKey: "保留" } } } };
  await plugin.config(config);
  const provider = config.provider.opencode;
  assert.equal(provider.options.baseURL, `http://127.0.0.1:${proxyPort}/v1`);
  assert.equal(provider.options.timeout, false);
  assert.equal(provider.options.apiKey, "保留");
  assert.equal(provider.options.fetch, undefined);
  assert.equal(provider.options.transformRequestBody, undefined);

  const aliasHeaders = { headers: { "x-request-id": "alias-only", "x-opencode-client": "" } };
  await plugin["chat.headers"]({
    sessionID: "session-alias",
    model: { providerID: "opencode" },
  }, aliasHeaders);
  assert.equal(aliasHeaders.headers["x-opencode-request"], "alias-only");
  assert.ok(aliasHeaders.headers["x-opencode-session"]);
  assert.equal(aliasHeaders.headers["x-opencode-client"], "cli");

  await plugin["chat.message"]({
    sessionID: "session-1",
    messageID: "message-1",
    model: { providerID: "opencode", modelID: "big-pickle" },
  });
  const health = await waitHealth(`http://127.0.0.1:${proxyPort}/__zen_proxy_health`);
  proxyPID = health.pid;
  await plugin["chat.params"]({ model: { providerID: "opencode" } });

  const send = async () => {
    const output = {
      headers: {
        "authorization": "Bearer test-key",
        "content-type": "application/json",
        "x-opencode-session": "real-session",
        "x-session-id": "real-session-id",
        "x-session-affinity": "real-affinity",
        "x-parent-session-id": "real-parent",
        "x-opencode-project": "real-project",
        "x-opencode-request": "real-request",
        "x-opencode-request-id": "real-request-id",
        "x-request-id": "real-request-alias",
        "x-opencode-ticket": "keep-ticket",
        "x-opencode-directory": "real-directory",
        "x-opencode-workspace": "real-workspace",
        "x-opencode-sync": "42",
        "x-opencode-title": "keep-title",
      },
    };
    await plugin["chat.headers"]({
      sessionID: "session-1",
      model: { providerID: "opencode" },
    }, output);
    const response = await fetch(`${provider.options.baseURL}/chat/completions`, {
      method: "POST",
      headers: output.headers,
      body: JSON.stringify({
        model: "big-pickle",
        messages: [],
        user: "real-user",
        metadata: { sessionID: "real-session", tier: "free" },
      }),
    });
    assert.equal(response.status, 200);
    return output;
  };

  const firstHeaders = await send();
  const first = captured.at(-1);
  await send();
  const second = captured.at(-1);
  const firstFakeSession = first.headers["x-opencode-session"];

  assert.equal(first.path, "/upstream/chat/completions");
  assert.equal(first.headers.authorization, "Bearer test-key");
  assert.equal(first.headers["x-opencode-session"], first.headers["x-session-id"]);
  assert.equal(first.headers["x-opencode-session"], first.headers["x-session-affinity"]);
  assert.notEqual(first.headers["x-opencode-session"], "real-session");
  assert.notEqual(first.headers["x-session-id"], "real-session-id");
  assert.notEqual(first.headers["x-session-affinity"], "real-affinity");
  assert.ok(first.headers["x-opencode-session"].startsWith("ses_"));
  assert.ok(first.headers["x-parent-session-id"].startsWith("ses_"));
  assert.notEqual(first.headers["x-parent-session-id"], "real-parent");
  assert.ok(first.headers["x-opencode-project"].startsWith("proj_"));
  assert.notEqual(first.headers["x-opencode-project"], "real-project");
  assert.ok(first.headers["x-opencode-request"].startsWith("req_"));
  assert.equal(first.headers["x-opencode-request"], first.headers["x-opencode-request-id"]);
  assert.equal(first.headers["x-opencode-request"], first.headers["x-request-id"]);
  assert.notEqual(first.headers["x-opencode-request"], "real-request");
  assert.equal(first.headers["x-opencode-client"], "cli");
  assert.equal(first.headers["x-opencode-ticket"], "keep-ticket");
  assert.ok(first.headers["x-opencode-directory"].startsWith("dir_"));
  assert.notEqual(first.headers["x-opencode-directory"], "real-directory");
  assert.ok(first.headers["x-opencode-workspace"].startsWith("wrk_"));
  assert.notEqual(first.headers["x-opencode-workspace"], "real-workspace");
  assert.equal(first.headers["x-opencode-sync"], "42");
  assert.equal(first.headers["x-opencode-title"], "keep-title");
  assert.equal(first.headers["x-zen-proxy-round"], undefined);
  assert.equal(firstHeaders.headers["x-zen-proxy-round"].length > 0, true);
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.model, "big-pickle");
  assert.deepEqual(firstBody.messages, []);
  assert.ok(firstBody.user.startsWith("usr_"));
  assert.notEqual(firstBody.user, "real-user");
  assert.ok(firstBody.metadata.sessionID.startsWith("ses_"));
  assert.equal(firstBody.metadata.tier, "free");
  assert.equal(second.headers["x-opencode-session"], firstFakeSession);
  assert.equal(second.headers["x-opencode-project"], first.headers["x-opencode-project"]);
  assert.notEqual(second.headers["x-opencode-request"], first.headers["x-opencode-request"]);

  const blankResponse = await fetch(`${provider.options.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-session": "",
      "x-opencode-project": "",
      "x-request-id": "",
      "x-opencode-client": "",
    },
    body: JSON.stringify({ model: "big-pickle", messages: [] }),
  });
  assert.equal(blankResponse.status, 200);
  const blank = captured.at(-1);
  assert.ok(blank.headers["x-opencode-session"].startsWith("ses_"));
  assert.ok(blank.headers["x-opencode-project"].startsWith("proj_"));
  assert.ok(blank.headers["x-request-id"].startsWith("req_"));
  assert.equal(blank.headers["x-opencode-client"], "cli");

  await plugin["chat.message"]({
    sessionID: "session-1",
    messageID: "message-1",
    model: { providerID: "opencode", modelID: "big-pickle" },
  });
  await send();
  assert.equal(captured.at(-1).headers["x-opencode-session"], firstFakeSession);

  await plugin["chat.message"]({
    sessionID: "session-1",
    messageID: "message-2",
    model: { providerID: "opencode", modelID: "big-pickle" },
  });
  await send();
  assert.notEqual(captured.at(-1).headers["x-opencode-session"], firstFakeSession);

  console.log("✓ 官方渠道已改走 Python 代理");
  console.log("✓ 全部会话、项目、请求标识均保留字段并改写值");
  console.log("✓ 同轮稳定、重复消息不轮换、新消息轮换");
  console.log("✓ 请求体清洗和客户端标识保留通过");
} finally {
  if (proxyPID) {
    try { process.kill(proxyPID); } catch {}
  }
  await close(upstream);
  delete process.env.ZEN_PROXY_PORT;
  delete process.env.ZEN_PROXY_PYTHON;
  delete process.env.ZEN_PROXY_SCRIPT;
  delete process.env.ZEN_PROXY_UPSTREAM_URL;
}
