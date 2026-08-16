import { appendFileSync } from "node:fs"
import { spawn } from "node:child_process"
import net from "node:net"
import type { Plugin } from "@opencode-ai/plugin"

const PROVIDER_ID = "zenproxy"
const PORT = 8643
const BAT_PATH = "D:\\项目\\opencode\\start_clean_proxy.bat"
const START_TIMEOUT_MS = 60_000
const POLL_MS = 300
const LOG_PATH = "D:\\WindowsTemp\\opencode\\zen-proxy-start.log"

function log(msg: string) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // logging must never break the request path
  }
}

log("plugin loaded")

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
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
      if (await portOpen(PORT)) {
        log("proxy already up")
        return true
      }
      log(`port ${PORT} closed, launching ${BAT_PATH}`)
      spawn("cmd", ["/c", "start", "", "cmd", "/k", BAT_PATH], {
        detached: true,
        stdio: "ignore",
      }).unref()
      const ok = await waitForPort(START_TIMEOUT_MS)
      log(ok ? `proxy ready (${START_TIMEOUT_MS}ms cap)` : `proxy FAILED to start within ${START_TIMEOUT_MS}ms`)
      return ok
    } finally {
      ensurePromise = null
    }
  })()
  return ensurePromise
}

export default (async () => {
  return {
    "chat.params": async (input) => {
      if (input.model.providerID !== PROVIDER_ID) return
      log(`zenproxy request from agent=${input.agent}`)
      await ensureZenProxy()
    },
  }
}) satisfies Plugin
