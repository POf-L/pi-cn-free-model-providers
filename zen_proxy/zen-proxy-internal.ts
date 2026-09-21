import { appendFileSync, existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import net from "node:net"
import type { Config, Plugin } from "@opencode-ai/plugin"

const OFFICIAL_PROVIDER_ID = "opencode"
const HOST = "127.0.0.1"
const PORT = (() => {
  const value = Number(process.env.ZEN_PROXY_PORT)
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 8643
})()
const PROXY_BASE_URL = `http://${HOST}:${PORT}/v1`
const HEALTH_URL = `http://${HOST}:${PORT}/__zen_proxy_health`
const ROUND_HEADER = "x-zen-proxy-round"
const START_TIMEOUT_MS = 60_000
const POLL_MS = 300
const LOG_PATH = "D:\\WindowsTemp\\opencode\\zen-proxy-start.log"
// The proxy is started from non-tool hooks, so its executable and script must
// not be caller-configurable.  A model/tool environment that can replace
// either value would turn chat setup into an arbitrary-process launcher.
const TRUSTED_PYTHON_PATH = "D:\\Python312\\python.exe"
const TRUSTED_SCRIPT_PATH = "D:\\项目\\zen_proxy\\zen_proxy.py"
const PYTHON_PATH = TRUSTED_PYTHON_PATH
const SCRIPT_PATH = TRUSTED_SCRIPT_PATH
const TRUSTED_RETRIES = 4

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").replace(/[\\]+/g, "\\").toLowerCase()
}

function validateLaunchEnvironment() {
  const suppliedPython = process.env.ZEN_PROXY_PYTHON
  const suppliedScript = process.env.ZEN_PROXY_SCRIPT
  if (suppliedPython && normalizeWindowsPath(suppliedPython) !== normalizeWindowsPath(TRUSTED_PYTHON_PATH)) {
    throw new Error("zen proxy 拒绝使用非受信 Python；请移除 ZEN_PROXY_PYTHON 覆盖")
  }
  if (suppliedScript && normalizeWindowsPath(suppliedScript) !== normalizeWindowsPath(TRUSTED_SCRIPT_PATH)) {
    throw new Error("zen proxy 拒绝使用非受信脚本；请移除 ZEN_PROXY_SCRIPT 覆盖")
  }

  const retries = process.env.ZEN_PROXY_RETRIES
  if (retries !== undefined && !/^[0-6]$/.test(retries.trim())) {
    throw new Error("zen proxy 拒绝不安全的重试次数；只允许 0 到 6")
  }

  const upstream = process.env.ZEN_PROXY_UPSTREAM_URL
  if (!upstream) return
  let url: URL
  try {
    url = new URL(upstream)
  } catch {
    throw new Error(`上游地址无效：${upstream}`)
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("zen proxy 拒绝非 HTTP(S) 或带凭据的上游地址")
  }
  // Plain HTTP is only acceptable for a loopback test fixture.  Production
  // traffic must stay on the pinned HTTPS Zen endpoint.
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname.toLowerCase())
  if (url.protocol === "http:" && !loopback) {
    throw new Error("zen proxy 拒绝向非本机上游发送明文模型流量")
  }
  if (url.protocol === "https:" && url.hostname.toLowerCase() !== "opencode.ai") {
    throw new Error("zen proxy 拒绝未列入白名单的 HTTPS 上游")
  }
}

function log(message: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

// 只接管 opencode 官方渠道；其他自定义渠道（codex-relay / baipiao 等）完全不碰
function isProxyProvider(providerID: string): boolean {
  return providerID === OFFICIAL_PROVIDER_ID
}

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === name)
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = headerKey(headers, name)
  const value = key ? headers[key] : undefined
  return value?.trim() ? value : undefined
}

function setHeaderIfMissing(headers: Record<string, string>, name: string, value: string) {
  if (headerValue(headers, name)) return
  headers[headerKey(headers, name) ?? name] = value
}

function randomID(prefix: string): string {
  return prefix + randomUUID().replaceAll("-", "").slice(0, 22)
}

function portOpen(port: number, host = HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.setTimeout(500)
    const fail = () => {
      socket.destroy()
      resolve(false)
    }
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", fail)
    socket.once("timeout", fail)
  })
}

async function proxyHealthy(timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(HEALTH_URL, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    })
    if (!response.ok) return false
    const body = await response.json() as { service?: unknown }
    return body.service === "zen_proxy"
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function isNonZenHttpOccupant(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1200)
  try {
    const response = await fetch(HEALTH_URL, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    })
    if (!response.ok) return true
    try {
      const body = await response.json() as { service?: unknown }
      return body.service !== "zen_proxy"
    } catch {
      return true
    }
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function proxyArguments(): string[] {
  validateLaunchEnvironment()
  const args = ["-I", "-B", "-u", SCRIPT_PATH, "--port", String(PORT), "--rotation", "0", "--retries", String(TRUSTED_RETRIES)]
  const upstream = process.env.ZEN_PROXY_UPSTREAM_URL
  if (!upstream) return args

  let url: URL
  try {
    url = new URL(upstream)
  } catch {
    throw new Error(`上游地址无效：${upstream}`)
  }
  const prefix = url.pathname.replace(/\/+$/, "") || "/"
  args.push(
    "--upstream-host", url.hostname,
    "--upstream-port", String(url.port || (url.protocol === "https:" ? 443 : 80)),
    "--upstream-prefix", prefix,
  )
  if (url.protocol === "http:") args.push("--no-ssl")
  return args
}

async function launchProxy() {
  validateLaunchEnvironment()
  if (/[\\/]/.test(PYTHON_PATH) && !existsSync(PYTHON_PATH)) {
    throw new Error(`找不到 Python：${PYTHON_PATH}`)
  }
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(`找不到代理脚本：${SCRIPT_PATH}`)
  }

  const child = spawn(PYTHON_PATH, proxyArguments(), {
    cwd: SCRIPT_PATH.replace(/[\\/][^\\/]+$/, ""),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  })
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve())
    child.once("error", reject)
  })
  child.unref()
  return child
}

async function waitForProxy(child: ReturnType<typeof spawn>): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await proxyHealthy()) return true
    if (child.exitCode !== null) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return proxyHealthy()
}

let ensurePromise: Promise<void> | null = null

function ensureZenProxy(): Promise<void> {
  if (ensurePromise) return ensurePromise
  const current = (async () => {
    validateLaunchEnvironment()
    if (await proxyHealthy()) {
      log(`本地代理已就绪：${HOST}:${PORT}`)
      return
    }
    // 端口能连上但健康检查不通 ≠ 被占用：可能是刚启动/抖动/超时，
    // 此时若直接抛“被非 zen_proxy 占用”会误报。先重试健康检查，给启动中的代理留窗口
    if (await portOpen(PORT)) {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (await proxyHealthy()) {
          log(`本地代理已就绪（重试后）：${HOST}:${PORT}`)
          return
        }
      }
      if (await isNonZenHttpOccupant()) {
        throw new Error(`端口 ${PORT} 已被非 zen_proxy 服务占用`)
      }
      // TCP 能连但 HTTP 无明确非 zen 指纹：大概率是 zen 启动中/僵死/抖动，
      // 不按“占用”处理，继续走启动流程让系统 bind 结果决定，避免把 TIME_WAIT/半启动误判为占用
      log(`端口 ${PORT} 可连接但健康检查持续失败且无非 zen 指纹，尝试启动/接管代理…`)
    }
    log(`正在启动本地代理：${SCRIPT_PATH}`)
    const child = await launchProxy()
    if (!(await waitForProxy(child))) {
      // 启动后仍不健康，区分是“真被占用”还是“启动失败”
      if (await proxyHealthy()) {
        log(`本地代理已就绪（启动后）：${HOST}:${PORT}`)
        return
      }
      if (await portOpen(PORT)) {
        throw new Error(
          `端口 ${PORT} 无法拉起 zen_proxy，且健康检查失败。请排查：1) netstat -ano | findstr ${PORT} 看 PID；2) 若 PID 非 python.exe 的 zen_proxy.py 则为真占用，请改 ZEN_PROXY_PORT 或释放端口；3) 若是 python.exe 占用但健康失败，查看 D:\\WindowsTemp\\opencode\\zen-proxy-start.log`,
        )
      }
      throw new Error(`本地代理在 ${START_TIMEOUT_MS} 毫秒内未就绪`)
    }
    log(`本地代理启动完成：${HOST}:${PORT}`)
  })()
  ensurePromise = current.finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}

function configureProviders(config: Config) {
  config.provider ??= {}
  // 仅改写官方渠道的 baseURL/timeout，不新建也不修改任何其他 provider
  const official = (config.provider[OFFICIAL_PROVIDER_ID] ??= {})
  official.options ??= {}
  official.options.baseURL = PROXY_BASE_URL
  official.options.timeout = false
}

export default (async () => {
  const lastMessageIDs = new Map<string, string>()
  const roundIDs = new Map<string, string>()

  return {
    config: async (config) => {
      configureProviders(config)
    },

    "chat.message": async (input, output) => {
      if (input.model?.providerID && !isProxyProvider(input.model.providerID)) return
      const scopeID = input.sessionID || "__default__"
      const messageID = input.messageID ?? output?.message?.id
      if (messageID && lastMessageIDs.get(scopeID) === messageID) return
      await ensureZenProxy()
      if (messageID) lastMessageIDs.set(scopeID, messageID)
      else lastMessageIDs.delete(scopeID)
      roundIDs.set(scopeID, randomUUID())
    },

    "chat.params": async (input) => {
      if (!isProxyProvider(input.model.providerID)) return
      await ensureZenProxy()
    },

    "chat.headers": async (input, output) => {
      if (!isProxyProvider(input.model.providerID)) return
      await ensureZenProxy()
      const scopeID = input.sessionID || "__default__"
      let roundID = roundIDs.get(scopeID)
      if (!roundID) {
        roundID = randomUUID()
        roundIDs.set(scopeID, roundID)
      }
      output.headers[ROUND_HEADER] = roundID

      const sessionID = input.sessionID || randomID("ses_")
      setHeaderIfMissing(output.headers, "x-opencode-session", sessionID)
      setHeaderIfMissing(output.headers, "x-session-id", sessionID)
      setHeaderIfMissing(output.headers, "x-session-affinity", sessionID)
      const requestID =
        headerValue(output.headers, "x-opencode-request") ??
        headerValue(output.headers, "x-opencode-request-id") ??
        headerValue(output.headers, "x-request-id") ??
        randomID("req_")
      setHeaderIfMissing(output.headers, "x-opencode-request", requestID)
      setHeaderIfMissing(output.headers, "x-opencode-client", "cli")
    },
  }
}) satisfies Plugin
