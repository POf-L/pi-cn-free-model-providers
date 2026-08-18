import { randomUUID } from "node:crypto"
import type { Config, Plugin } from "@opencode-ai/plugin"

const PROVIDER_ID = "zenproxy"
const ZEN_API_BASE = "https://opencode.ai/zen/v1"
const SESSION_HEADERS = [
  "x-opencode-session",
  "x-session-id",
  "x-session-affinity",
  "x-parent-session-id",
] as const
const PROJECT_HEADERS = ["x-opencode-project"] as const
const REQUEST_HEADERS = ["x-opencode-request", "x-opencode-request-id", "x-request-id"] as const

function randomID(prefix: string): string {
  return prefix + randomUUID().replaceAll("-", "").slice(0, 22)
}

function getSessionID(sessionID: string): string {
  return randomID("ses_")
}

function mapSessionID(scopeID: string, sessionID: string): string {
  return randomID("ses_")
}

function mapProjectID(scopeID: string, projectID: string): string {
  return randomID("proj_")
}

function sanitizeRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...body }
  delete sanitized.user
  delete sanitized.metadata
  return sanitized
}

function sanitizeJSONBody(body: string): string {
  try {
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body
    if (!Object.hasOwn(parsed, "user") && !Object.hasOwn(parsed, "metadata")) return body
    return JSON.stringify(sanitizeRequestBody(parsed))
  } catch {
    return body
  }
}

function sanitizeHeaders(headers: Headers): Headers {
  const scopeID =
    headers.get("x-session-id") ??
    headers.get("x-session-affinity") ??
    headers.get("x-opencode-session")

  if (scopeID) {
    for (const name of SESSION_HEADERS) {
      const value = headers.get(name)
      if (value) headers.set(name, mapSessionID(scopeID, value))
    }
    for (const name of PROJECT_HEADERS) {
      const value = headers.get(name)
      if (value) headers.set(name, mapProjectID(scopeID, value))
    }
  } else {
    for (const name of SESSION_HEADERS) {
      if (headers.has(name)) headers.set(name, randomID("ses_"))
    }
    for (const name of PROJECT_HEADERS) {
      if (headers.has(name)) headers.set(name, randomID("proj_"))
    }
  }

  const requestID = randomID("req_")
  for (const name of REQUEST_HEADERS) {
    if (headers.has(name)) headers.set(name, requestID)
  }
  if (!headers.has("x-opencode-client")) headers.set("x-opencode-client", "cli")
  return headers
}

function createSanitizingFetch(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    }
    sanitizeHeaders(headers)

    let body = init?.body
    if (body === undefined && input instanceof Request && input.body) {
      body = await input.clone().text()
    }
    if (typeof body === "string") {
      const sanitized = sanitizeJSONBody(body)
      if (sanitized !== body) headers.delete("content-length")
      body = sanitized
    }

    return fetch(input, {
      ...init,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  }) as typeof fetch
}

function configureZenProvider(config: Config, cleanFetch: typeof fetch) {
  const provider = config.provider?.[PROVIDER_ID]
  if (!provider) return
  provider.options ??= {}
  provider.options.baseURL = ZEN_API_BASE
  provider.options.fetch = cleanFetch
  provider.options.transformRequestBody = sanitizeRequestBody
  provider.options.timeout = false
}

export default (async () => {
  const cleanFetch = createSanitizingFetch()

  return {
    config: async (config) => {
      configureZenProvider(config, cleanFetch)
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID) return
      const sessionID = getSessionID(input.sessionID)
      output.headers["x-session-id"] = sessionID
      output.headers["x-session-affinity"] = sessionID
      if (!output.headers["x-opencode-client"]) output.headers["x-opencode-client"] = "cli"
    },
  }
}) satisfies Plugin
