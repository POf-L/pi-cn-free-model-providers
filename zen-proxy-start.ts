import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import net from "node:net"
import type { Plugin } from "@opencode-ai/plugin"

const PROVIDER_ID = "zenproxy"
const PORT = 8643
const BAT_PATH = "D:\\项目\\opencode\\start_clean_proxy.bat"
const START_TIMEOUT_MS = 60_000
const POLL_MS = 300
const LOG_PATH = "D:\\WindowsTemp\\opencode\\zen-proxy-start.log"
const OFFICIAL_PROVIDER_ID = "opencode"
const ZENPROXY_MODEL_ID = "big-pickle"
const RATE_LIMIT_STATE_PATH = "D:\\WindowsTemp\\opencode\\zen-proxy-rate-limits.json"
const ZEN_API_BASE = "https://opencode.ai/zen/v1"
const RATE_LIMIT_TTL_MS = 60 * 60 * 1000

function log(msg: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

log("plugin loaded")

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.setTimeout(500)
    const fail = () => { socket.destroy(); resolve(false) }
    socket.once("connect", () => { socket.destroy(); resolve(true) })
    socket.once("error", fail)
    socket.once("timeout", fail)
  })
}

async function waitForPort(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(PORT)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return portOpen(PORT)
}

let ensurePromise: Promise<boolean> | null = null

function ensureZenProxy(): Promise<boolean> {
  if (ensurePromise) return ensurePromise
  ensurePromise = (async () => {
    try {
      if (await portOpen(PORT)) { log("proxy already up"); return true }
      log(`port ${PORT} closed, launching ${BAT_PATH}`)
      spawn("cmd", ["/c", "start", "", "cmd", "/k", BAT_PATH], {
        detached: true, stdio: "ignore",
      }).unref()
      const ok = await waitForPort(START_TIMEOUT_MS)
      log(ok ? `proxy ready (${START_TIMEOUT_MS}ms cap)` : `proxy FAILED to start within ${START_TIMEOUT_MS}ms`)
      return ok
    } finally { ensurePromise = null }
  })()
  return ensurePromise
}

function loadRateLimit(): number | null {
  try {
    const raw = readFileSync(RATE_LIMIT_STATE_PATH, "utf-8").trim()
    const parsed = JSON.parse(raw)
    let expireAt: number | null = null
    if (typeof parsed === "number") {
      expireAt = parsed
    } else if (Array.isArray(parsed) && parsed.length > 0) {
      expireAt = Math.max(...parsed.map((e: any) => Number(e[1]) || 0))
    }
    if (expireAt && expireAt > Date.now()) {
      log(`restored global rate limit, expires in ${Math.round((expireAt - Date.now()) / 1000)}s`)
      return expireAt
    }
    if (expireAt) log(`rate limit expired, ignoring`)
  } catch {}
  return null
}

function saveRateLimit(expireAt: number) {
  try {
    writeFileSync(RATE_LIMIT_STATE_PATH, JSON.stringify(expireAt))
  } catch {}
}

function randId(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, "").slice(0, 22)
}

function isRateLimitBody(body: string): boolean {
  return /FreeUsageLimitError|GoUsageLimitError|insufficient.?quota|quota.?exceeded|rate.?limit|too.?many.?requests/i.test(body)
}

async function healthCheckRateLimit(): Promise<number | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const resp = await fetch(`${ZEN_API_BASE}/models`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    })
    clearTimeout(timer)
    if (resp.status === 429) {
      const body = await resp.text()
      log(`health check: 429, body=${body.slice(0, 300)}`)
      if (isRateLimitBody(body)) {
        return Date.now() + RATE_LIMIT_TTL_MS
      }
    }
    log(`health check: OK (status=${resp.status})`)
  } catch (e: any) {
    log(`health check: failed (${e?.name || e?.message || e})`)
  }
  return null
}

export default (async ({ client }) => {
  let globalRateLimitExpireAt: number | null = loadRateLimit()

  const startupCheck = (async () => {
    if (globalRateLimitExpireAt && Date.now() < globalRateLimitExpireAt) {
      log("startup: rate limit loaded from state, skip health check")
      return
    }
    log("startup: health check -> official API")
    const expireAt = await healthCheckRateLimit()
    if (expireAt) {
      globalRateLimitExpireAt = expireAt
      saveRateLimit(expireAt)
      log(`startup: rate-limited, will redirect to zenproxy`)
    }
  })()

  return {
    "chat.params": async (input) => {
      if (input.model.providerID !== OFFICIAL_PROVIDER_ID) {
        if (input.model.providerID === PROVIDER_ID) {
          log(`zenproxy request from agent=${input.agent}`)
          await ensureZenProxy()
        }
        return
      }
      await startupCheck
      if (globalRateLimitExpireAt && Date.now() < globalRateLimitExpireAt) {
        log(`rate-limited (expires in ${Math.round((globalRateLimitExpireAt - Date.now()) / 1000)}s), overriding -> zenproxy`)
        input.model.providerID = PROVIDER_ID
        input.model.modelID = ZENPROXY_MODEL_ID
        await ensureZenProxy()
        return
      }
      log(`official opencode request from agent=${input.agent}`)
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== OFFICIAL_PROVIDER_ID) return
      output.headers["x-opencode-session"] = randId("ses_")
      output.headers["x-opencode-request"] = randId("req_")
      if (output.headers["x-opencode-project"]) {
        output.headers["x-opencode-project"] = randId("proj_")
      }
      if (!output.headers["x-opencode-client"]) {
        output.headers["x-opencode-client"] = "cli"
      }
      log(`headers rewritten: ses=${output.headers["x-opencode-session"]} req=${output.headers["x-opencode-request"]}`)
    },
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const props = (event as any).properties ?? {}
        const status = props.status as any
        if (status?.type === "retry") {
          const reason = status.action?.reason
          if (
            reason === "free_tier_limit" ||
            reason === "account_rate_limit" ||
            /rate.?limit|quota|overloaded|too many/i.test(status.message || "")
          ) {
            const ttl = status.next ? status.next - Date.now() : RATE_LIMIT_TTL_MS
            globalRateLimitExpireAt = Date.now() + Math.max(ttl, 60_000)
            saveRateLimit(globalRateLimitExpireAt)
            log(`rate-limited: reason=${reason} next=${status.next} ttl=${Math.round(ttl / 1000)}s`)
          }
        }
      }
    },
  }
}) satisfies Plugin
