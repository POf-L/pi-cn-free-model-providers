// zen-proxy-autostart: make sure the local zen proxy on 127.0.0.1:8643 is up before
// pi talks to the OpenCode Zen gateway.
//
// Why the proxy is needed at all: opencode.ai/zen refuses some models outright with
// `RegionError` when the request carries this machine's own client identity. The
// Python proxy rewrites the session/request identity headers, which clears that gate.
// Verified: a direct POST https://opencode.ai/zen/v1/responses for muse-spark
// returns 403 RegionError, the same request through the proxy returns 200.
//
// Unified repo layout (single top-level from D:/项目):
//   D:/项目/pi-cn-free-model-providers/zen_proxy/zen_proxy.py  (new, canonical)
//   D:/项目/zen_proxy/zen_proxy.py                             (old, pre-merge fallback)
// All Zen traffic goes through it: `OPENCODE_ZEN_BASE_URL` is set to
// http://127.0.0.1:8643/v1 as a user environment variable, and
// pi-cn-free-model-providers reads it for the provider baseUrl, the /v1/models
// drift check, and the free-tier probe. Without the relay running, the probe
// cannot reach the gateway and the zen catalog falls back to the curated list —
// muse-spark then disappears until the next session.
//
// OpenCode gets the proxy started by its own plugin (zen_proxy/zen-proxy-internal.ts).
// pi has no such hook, so this extension performs the same health-check-then-spawn dance.
// Paths are hard-coded on purpose, mirroring that plugin: this runs at startup, so a
// caller-supplied executable would turn session setup into a process launcher.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOST = "127.0.0.1";
const PORT = 8643;
const HEALTH_URL = `http://${HOST}:${PORT}/__zen_proxy_health`;
const PYTHON_PATH = "D:\\Python312\\python.exe";
const NEW_SCRIPT_PATH = "D:\\项目\\pi-cn-free-model-providers\\zen_proxy\\zen_proxy.py";
const OLD_SCRIPT_PATH = "D:\\项目\\zen_proxy\\zen_proxy.py";

function pickScript(): string | undefined {
  if (existsSync(NEW_SCRIPT_PATH)) return NEW_SCRIPT_PATH;
  if (existsSync(OLD_SCRIPT_PATH)) return OLD_SCRIPT_PATH;
  return undefined;
}
const START_TIMEOUT_MS = 60000;
const POLL_MS = 300;

async function healthy(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: unknown };
    return body.service === "zen_proxy";
  } catch {
    return false;
  }
}

function launch(scriptPath: string) {
  // `--rotation 0` and `--retries 2` match what the opencode plugin passes, so both
  // agents share one proxy process with identical behaviour.
  const child = spawn(
    PYTHON_PATH,
    ["-I", "-B", "-u", scriptPath, "--port", String(PORT), "--rotation", "0", "--retries", "2"],
    {
      cwd: scriptPath.replace(/[\\/][^\\/]+$/, ""),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return child;
}

async function ensureProxy(): Promise<string | undefined> {
  if (await healthy()) return undefined;
  if (!existsSync(PYTHON_PATH)) return `zen proxy: Python not found at ${PYTHON_PATH}`;
  const scriptPath = pickScript();
  if (!scriptPath) return `zen proxy: script not found at ${NEW_SCRIPT_PATH} nor ${OLD_SCRIPT_PATH}`;

  try {
    launch(scriptPath);
  } catch (error) {
    return `zen proxy: spawn failed - ${(error as Error).message}`;
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (await healthy()) return undefined;
  }
  return `zen proxy: not ready on ${HOST}:${PORT} within ${START_TIMEOUT_MS}ms`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const problem = await ensureProxy();
    // Only surface failures. A healthy proxy is the normal case and needs no noise;
    // a failure means zen-proxy/* models will error, so the user should know why.
    if (problem) ctx.ui.notify(problem, "warning");
  });
}
