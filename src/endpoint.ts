/**
 * Endpoint discovery.
 *
 * OpenCode routes a model through a provider, and the endpoint the request was
 * actually sent to is the identity that answers "who ran this inference": a
 * gateway names its own routing endpoint in the response headers, and a
 * per-operator provider is named by the host of its API. The recorder stores
 * that endpoint on the step and nothing else about the route — the operator a
 * header happens to mention is not the endpoint, so it is not kept.
 *
 * Everything here is pure so the discovery can be tested without a network
 * stack.
 */

import { normalizeToken } from "./text"

/** Header a gateway sets to name the routing endpoint that served the request. */
export const ENDPOINT_HEADER = "x-opencode-endpoint-id" as const

/** Longest endpoint id kept: a routing label, not a sentence. */
export const ENDPOINT_MAX = 64

/**
 * Request hosts that name the operator behind the request.
 *
 * A gateway host is deliberately absent: `opencode.ai`, `openrouter.ai` and
 * `vercel-ai-gateway` are routers, not the platform that ran the model, and
 * treating them as the endpoint made every request served without an endpoint
 * header read as "opencode" — the provider's name wearing the endpoint's
 * clothes. When the gateway does not name its downstream endpoint, the endpoint
 * is unknown, and the views say so.
 */
const KNOWN_ENDPOINT_HOSTS: ReadonlyArray<readonly [string, string]> = [
  ["api.fireworks.ai", "fireworks"],
  ["api.deepseek.com", "deepseek"],
  ["api.together.xyz", "together"],
  ["api.groq.com", "groq"],
  ["api.cerebras.ai", "cerebras"],
  ["api.sambanova.ai", "sambanova"],
  ["api.hyperbolic.xyz", "hyperbolic"],
  ["api.deepinfra.com", "deepinfra"],
  ["api.baseten.co", "baseten"],
  ["api.novita.ai", "novita"],
  ["api.parasail.io", "parasail"],
  ["api.moonshot.ai", "moonshot"],
  ["api.moonshot.cn", "moonshot"],
  ["api.z.ai", "zhipu"],
  ["open.bigmodel.cn", "zhipu"],
  ["api.minimax.chat", "minimax"],
  ["dashscope.aliyuncs.com", "alibaba"],
  ["api.x.ai", "xai"],
  ["api.anthropic.com", "anthropic"],
  ["api.openai.com", "openai"],
  ["openai.azure.com", "azure"],
  ["bedrock-runtime.*.amazonaws.com", "bedrock"],
  ["generativelanguage.googleapis.com", "google"],
  ["aiplatform.googleapis.com", "vertex"],
  ["api.nvidia.com", "nvidia"],
  ["api.mistral.ai", "mistral"],
  ["api.cloudflare.com", "cloudflare"],
]

export type EndpointInfo = {
  /** Routing endpoint or host that served the request. */
  router?: string | undefined
  /** Where the finding came from: `header:<name>` or `endpoint:<host>`. */
  source?: string | undefined
}

function readHeader(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
  const get = (headers as Headers).get
  if (typeof get === "function") {
    const value = get.call(headers, name)
    return value === null || value === "" ? undefined : value
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    const value = (headers as Record<string, string | undefined>)[key]
    return value ? value : undefined
  }
  return undefined
}

/**
 * Endpoint the gateway named in the response headers, when it named one.
 *
 * The value is a routing label, so it is validated as a token and lowercased:
 * a gateway that changes the case between responses would otherwise read as a
 * different endpoint and split its own history in two. Anything that is not a
 * token (control characters, spaces, an essay) is not an endpoint id.
 */
export function inferFromHeaders(headers: Headers | Record<string, string | undefined> | undefined): EndpointInfo | undefined {
  if (!headers) return undefined
  const value = readHeader(headers, ENDPOINT_HEADER)
  if (value === undefined) return undefined
  const router = normalizeToken(value, ENDPOINT_MAX)
  if (router === undefined) return undefined
  return { router, source: `header:${ENDPOINT_HEADER}` }
}

/**
 * True when `host` is `suffix`, a subdomain of it (`cdn.opencode.ai`), or a
 * regional host that carries it as a label tail (`us-central1-aiplatform.googleapis.com`).
 * The boundary has to fall on a dot or a dash: a host that merely contains a
 * known domain (`api.anthropic.com.evil.tld`) names nothing.
 *
 * A `*` in the pattern stands for one label, for the hosts whose region sits
 * in the middle (`bedrock-runtime.*.amazonaws.com`).
 */
export function hostMatches(host: string, pattern: string): boolean {
  const hostLabels = host.split(".")
  const patternLabels = pattern.split(".")
  if (patternLabels.includes("*")) {
    if (hostLabels.length !== patternLabels.length) return false
    return patternLabels.every((label, index) => label === "*" || label === hostLabels[index])
  }
  if (host === pattern) return true
  if (host.endsWith(`.${pattern}`)) return true
  return host.endsWith(`-${pattern}`)
}

/** Endpoint named by the host of the request URL. */
export function inferFromUrl(url: string | undefined): EndpointInfo | undefined {
  if (url === undefined) return undefined
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (host === "") return undefined
  for (const [suffix, router] of KNOWN_ENDPOINT_HOSTS) {
    if (hostMatches(host, suffix)) return { router, source: `endpoint:${host}` }
  }
  return undefined
}

/** First candidate that named an endpoint, headers before the URL. */
export function mergeEndpoint(...candidates: readonly (EndpointInfo | undefined)[]): EndpointInfo | undefined {
  const merged: EndpointInfo = {}
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (merged.router === undefined && candidate.router !== undefined) merged.router = candidate.router
    if (merged.source === undefined && candidate.source !== undefined) merged.source = candidate.source
  }
  return merged.router === undefined ? undefined : merged
}
