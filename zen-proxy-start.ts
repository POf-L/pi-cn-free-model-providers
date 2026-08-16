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
const OFFICIAL_PROVIDER_ID = "opencode"
const ZENPROXY_MODEL_ID = "big-pickle"

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

export default (async ({ client }) => {
  const failedOver = new Set<string>()

  return {
    "chat.params": async (input) => {
      if (input.model.providerID !== PROVIDER_ID) return
      log(`zenproxy request from agent=${input.agent}`)
      await ensureZenProxy()
    },
    "chat.message": async (input, output) => {
      const msg = output.message as unknown as {
        providerID: string
        parentID?: string
        error?: { name?: string; data?: { statusCode?: number; message?: string } }
      }
      if (msg.providerID !== OFFICIAL_PROVIDER_ID) return
      const err = msg.error
      if (err?.name !== "APIError" || err.data?.statusCode !== 429) return
      if (failedOver.has(input.sessionID)) return
      if (!msg.parentID) return
      let text = ""
      try {
        const parent = await client.session.message({
          path: { id: input.sessionID, messageID: msg.parentID },
        })
        text = (parent.parts as { type: string; text?: string }[])
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text as string)
          .join("\n")
      } catch (e) {
        log(`429 failover: failed to read parent message: ${e}`)
        return
      }
      if (!text) {
        log("429 failover: parent message has no text parts, skipping")
        return
      }
      await ensureZenProxy()
      failedOver.add(input.sessionID)
      try {
        await client.session.promptAsync({
          path: { id: input.sessionID },
          body: {
            model: { providerID: PROVIDER_ID, modelID: ZENPROXY_MODEL_ID },
            parts: [{ type: "text", text }],
          },
        })
        log(`429 failover -> zenproxy for session=${input.sessionID}`)
      } catch (e) {
        log(`429 failover: promptAsync failed: ${e}`)
        failedOver.delete(input.sessionID)
      }
    },
  }
}) satisfies Plugin
