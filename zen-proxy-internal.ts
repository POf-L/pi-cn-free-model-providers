import { appendFileSync, existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import net from "node:net"
import type { Config, Plugin } from "@opencode-ai/plugin"

const OFFICIAL_PROVIDER_ID = "opencode"
const PROXY_PROVIDER_ID = "zenproxy"
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
const PYTHON_PATH = process.env.ZEN_PROXY_PYTHON || "D:\\Python312\\python.exe"
const SCRIPT_PATH = process.env.ZEN_PROXY_SCRIPT || "D:\\项目\\zen_proxy\\zen_proxy.py"

function log(message: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

function isProxyProvider(providerID: string): boolean {
  return providerID === OFFICIAL_PROVIDER_ID || providerID === PROXY_PROVIDER_ID
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

async function proxyHealthy(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 800)
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

function proxyArguments(): string[] {
  const args = ["-I", "-B", "-u", SCRIPT_PATH, "--port", String(PORT), "--rotation", "0"]
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
    if (await proxyHealthy()) {
      log(`本地代理已就绪：${HOST}:${PORT}`)
      return
    }
    if (await portOpen(PORT)) {
      throw new Error(`端口 ${PORT} 已被非 zen_proxy 服务占用`)
    }
    log(`正在启动本地代理：${SCRIPT_PATH}`)
    const child = await launchProxy()
    if (!(await waitForProxy(child))) {
      throw new Error(`本地代理在 ${START_TIMEOUT_MS} 毫秒内未就绪`)
    }
    log(`本地代理启动完成：${HOST}:${PORT}`)
  })()
  ensurePromise = current.finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}

function configureProxyProvider(config: Config, providerID: string) {
  const provider = config.provider?.[providerID]
  if (!provider) return
  provider.options ??= {}
  provider.options.baseURL = PROXY_BASE_URL
  provider.options.timeout = false
}

function configureProviders(config: Config) {
  config.provider ??= {}
  const official = (config.provider[OFFICIAL_PROVIDER_ID] ??= {})
  official.options ??= {}
  official.options.baseURL = PROXY_BASE_URL
  official.options.timeout = false
  configureProxyProvider(config, PROXY_PROVIDER_ID)
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
