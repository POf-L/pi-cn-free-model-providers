import { createServer } from "node:http";

let captured = null;
const server = createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    captured = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const plugin = await (await import("../zen-proxy-internal.ts")).default({});
const config = { provider: { opencode: {} } };
await plugin.config(config);
const fetch = config.provider.opencode.options.fetch;

console.log("=== 客户端想发的请求（真实会话/项目/身份信息）===");
console.log(JSON.stringify({
  url: "/chat/completions",
  headers: {
    "x-session-id": "ses_REAL_9f3a1c",
    "x-opencode-session": "ses_REAL_9f3a1c",
    "x-parent-session-id": "ses_REAL_9f3a1c",
    "x-opencode-project": "proj_REAL_8b2d",
    "x-request-id": "req_REAL_111",
  },
  body: { model: "big-pickle", messages: [], user: "alice@corp.com", metadata: { tier: "free" } },
}, null, 2));

await fetch(url + "/chat/completions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-session-id": "ses_REAL_9f3a1c",
    "x-opencode-session": "ses_REAL_9f3a1c",
    "x-parent-session-id": "ses_REAL_9f3a1c",
    "x-opencode-project": "proj_REAL_8b2d",
    "x-request-id": "req_REAL_111",
  },
  body: JSON.stringify({ model: "big-pickle", messages: [], user: "alice@corp.com", metadata: { tier: "free" } }),
});

console.log("\n=== 插件实际发到上游的请求（已清洗）===");
console.log(JSON.stringify(captured, null, 2));
server.close();
