import assert from "node:assert/strict";

process.env.ZEN_PROXY_PORT = "18643";
const plugin = await (await import("../zen-proxy-internal.ts")).default({});
const config = { provider: { opencode: {} } };
await plugin.config(config);

assert.equal(config.provider.opencode.options.baseURL, "http://127.0.0.1:18643/v1");
console.log(config.provider.opencode.options);
