/**
 * Upstream operator detection.
 *
 * OpenCode routes a model through a provider. When that provider is a gateway
 * (`opencode`, OpenRouter, Vercel AI Gateway) the operator that actually runs
 * the inference is chosen per request, and the only places it can show up are
 * the gateway's own response headers, the endpoint the request went to, the
 * provider package in the model catalogue, or the provenance a compaction
 * records. The recorder tries them in that order:
 *
 * - `header:<name>` — gateway response headers
 * - `endpoint:<host>` — the request URL host, for per-operator providers
 * - `package:<name>` — the provider's package in the model catalogue
 * - `provenance` — the route a completed compaction reports
 *
 * Infrastructure headers (`server`, `via`, `cf-ray`) name the CDN in front of
 * the gateway, never the operator: they are stored as evidence and never
 * classified. Everything here is pure so the heuristics can be tested without
 * a network stack.
 */

/**
 * Headers that can name the inference operator, in decreasing priority. Values
 * are read as `operator`, `operator/model`, or a bare model id.
 */
export const OPERATOR_HEADERS = [
  "x-opencode-upstream-model-id",
  "x-served-by",
  "x-upstream",
  "x-upstream-provider",
  "x-inference-provider",
  "x-inference-backend",
  "x-model-served-by",
  "x-served-model",
  "x-opencode-upstream",
  "x-opencode-provider",
  "x-litellm-model-id",
  "x-litellm-provider",
  "x-portkey-provider",
  "x-backend",
  "x-backend-server",
] as const

/** Headers that identify the gateway's routing endpoint or the upstream model. */
export const ROUTE_HEADERS = ["x-opencode-endpoint-id", "x-zen-model"] as const

/** Headers that only describe the CDN in front of the gateway. */
export const NETWORK_HEADERS = ["server", "via", "cf-ray"] as const

/** Every header worth keeping as evidence, operator candidates first. */
export const UPSTREAM_HEADERS = [...OPERATOR_HEADERS, ...ROUTE_HEADERS, ...NETWORK_HEADERS] as const

/** Headers never written to the database, even in capture mode. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "proxy-authorization",
  "openai-api-key",
])

/**
 * Operators recognised by name. Order matters: more specific names first. A
 * value is normalised by splitting on non-alphanumerics and matching whole
 * tokens, so `together-vllm` still resolves to Together.
 */
const KNOWN_OPERATORS: ReadonlyArray<readonly [string, string]> = [
  ["deepinfra", "DeepInfra"],
  ["together", "Together"],
  ["fireworks", "Fireworks"],
  ["hyperbolic", "Hyperbolic"],
  ["sambanova", "SambaNova"],
  ["cerebras", "Cerebras"],
  ["groq", "Groq"],
  ["parasail", "Parasail"],
  ["baseten", "Baseten"],
  ["novita", "Novita"],
  ["deepseek", "DeepSeek"],
  ["moonshot", "Moonshot"],
  ["kimi", "Moonshot"],
  ["zhipu", "Zhipu"],
  ["minimax", "MiniMax"],
  ["qwen", "Alibaba"],
  ["alibaba", "Alibaba"],
  ["grok", "xAI"],
  ["anthropic", "Anthropic"],
  ["claude", "Anthropic"],
  ["openai", "OpenAI"],
  ["azure", "Azure"],
  ["bedrock", "AWS Bedrock"],
  ["vertex", "Google Vertex"],
  ["nvidia", "NVIDIA"],
  ["mistral", "Mistral"],
  ["cloudflare", "Cloudflare"],
  ["google", "Google"],
]

/**
 * Gateways that route to several operators. A value naming one of these is a
 * router, not an operator: reporting it as the upstream would be wrong (the
 * gateway is chosen by the user, the operator is chosen per request).
 */
const KNOWN_ROUTERS: ReadonlyArray<readonly [string, string]> = [
  ["openrouter", "openrouter"],
  ["orcarouter", "orcarouter"],
  ["opencode", "opencode"],
  ["vercel", "vercel-ai-gateway"],
  ["litellm", "litellm"],
  ["portkey", "portkey"],
]

/** Request hosts that belong to a single operator, or to a known gateway. */
const KNOWN_ENDPOINT_HOSTS: ReadonlyArray<readonly [string, { operator?: string; router?: string }]> = [
  ["api.fireworks.ai", { operator: "Fireworks" }],
  ["api.deepseek.com", { operator: "DeepSeek" }],
  ["api.together.xyz", { operator: "Together" }],
  ["api.groq.com", { operator: "Groq" }],
  ["api.cerebras.ai", { operator: "Cerebras" }],
  ["api.sambanova.ai", { operator: "SambaNova" }],
  ["api.hyperbolic.xyz", { operator: "Hyperbolic" }],
  ["api.deepinfra.com", { operator: "DeepInfra" }],
  ["api.baseten.co", { operator: "Baseten" }],
  ["api.novita.ai", { operator: "Novita" }],
  ["api.parasail.io", { operator: "Parasail" }],
  ["api.moonshot.ai", { operator: "Moonshot" }],
  ["api.moonshot.cn", { operator: "Moonshot" }],
  ["api.z.ai", { operator: "Zhipu" }],
  ["open.bigmodel.cn", { operator: "Zhipu" }],
  ["api.minimax.chat", { operator: "MiniMax" }],
  ["dashscope.aliyuncs.com", { operator: "Alibaba" }],
  ["api.x.ai", { operator: "xAI" }],
  ["api.anthropic.com", { operator: "Anthropic" }],
  ["api.openai.com", { operator: "OpenAI" }],
  ["openai.azure.com", { operator: "Azure" }],
  ["bedrock-runtime", { operator: "AWS Bedrock" }],
  ["generativelanguage.googleapis.com", { operator: "Google" }],
  ["aiplatform.googleapis.com", { operator: "Google Vertex" }],
  ["api.nvidia.com", { operator: "NVIDIA" }],
  ["api.mistral.ai", { operator: "Mistral" }],
  ["api.cloudflare.com", { operator: "Cloudflare" }],
  ["opencode.ai", { router: "opencode" }],
  ["openrouter.ai", { router: "openrouter" }],
  ["ai-gateway.vercel.sh", { router: "vercel-ai-gateway" }],
]

/** Provider packages that describe a protocol, not an operator. */
const GENERIC_PACKAGES = new Set(["openai-compatible", "openai-responses", "anthropic-compatible", "compatible", "openai"])

export type UpstreamEvidence = {
  /** Header name as inspected. */
  header: string
  value: string
}

export type UpstreamInfo = {
  /** Inference operator that ran the model, when a source names one. */
  operator?: string | undefined
  /** Upstream model id as reported by the gateway (`deepseek/deepseek-v4.1-flash`). */
  model?: string | undefined
  /** Gateway endpoint or host that routed the request (`orcarouter-dsv4.1flash`, `opencode.ai`). */
  router?: string | undefined
  /** Where the primary finding came from: `header:<name>`, `endpoint:<host>`, `package:<name>`, `provenance`. */
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

/** Candidate headers present in a response, in priority order. */
export function collectEvidence(headers: Headers | Record<string, string | undefined> | undefined): UpstreamEvidence[] {
  if (!headers) return []
  const evidence: UpstreamEvidence[] = []
  for (const header of UPSTREAM_HEADERS) {
    const value = readHeader(headers, header)
    if (value !== undefined) evidence.push({ header, value })
  }
  return evidence
}

function tokensOf(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** Canonical name of a known operator named by `value`, matching whole tokens. */
export function normalizeUpstream(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const tokens = tokensOf(value)
  for (const [token, operator] of KNOWN_OPERATORS) {
    if (tokens.includes(token)) return operator
  }
  return undefined
}

/** Canonical name of a known gateway named by `value`, matching whole tokens. */
export function normalizeRouter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const tokens = tokensOf(value)
  for (const [token, router] of KNOWN_ROUTERS) {
    if (tokens.includes(token)) return router
  }
  return undefined
}

/**
 * Split a header value such as `deepseek/deepseek-v4.1-flash` into an operator
 * (or router) and the upstream model id. Unrecognised values are kept as the
 * model id — a report should show what the gateway said without pretending it
 * is an operator.
 */
function classify(value: string): UpstreamInfo {
  const trimmed = value.trim()
  if (trimmed === "") return {}
  const slash = trimmed.indexOf("/")
  const head = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const model = slash === -1 ? undefined : trimmed
  const router = normalizeRouter(head)
  if (router !== undefined) return { router, model }
  const operator = normalizeUpstream(head)
  if (operator !== undefined) return { operator, model }
  const wholeRouter = normalizeRouter(trimmed)
  if (wholeRouter !== undefined) return { router: wholeRouter }
  const wholeOperator = normalizeUpstream(trimmed)
  if (wholeOperator !== undefined) return { operator: wholeOperator }
  return trimmed.length <= 64 ? { model: trimmed } : {}
}

/**
 * Operator, upstream model and router named by the response headers. Network
 * headers are ignored on purpose: `server: cloudflare` means the CDN, not the
 * operator.
 */
export function inferFromHeaders(headers: Headers | Record<string, string | undefined> | undefined): UpstreamInfo | undefined {
  if (!headers) return undefined
  const info: UpstreamInfo = {}

  for (const header of OPERATOR_HEADERS) {
    const value = readHeader(headers, header)
    if (value === undefined) continue
    const classified = classify(value)
    if (info.operator === undefined && classified.operator !== undefined) {
      info.operator = classified.operator
      info.source = `header:${header}`
    }
    if (info.model === undefined && classified.model !== undefined) {
      info.model = classified.model
      info.source ??= `header:${header}`
    }
    if (info.router === undefined && classified.router !== undefined) {
      info.router = classified.router
      info.source ??= `header:${header}`
    }
    if (info.operator !== undefined && info.model !== undefined) break
  }

  const endpoint = readHeader(headers, "x-opencode-endpoint-id")
  if (endpoint !== undefined) {
    const trimmed = endpoint.trim()
    if (trimmed !== "" && trimmed.length <= 64) {
      info.router ??= trimmed
      info.source ??= "header:x-opencode-endpoint-id"
    }
  }
  const zenModel = readHeader(headers, "x-zen-model")
  if (zenModel !== undefined && info.model === undefined) {
    const trimmed = zenModel.trim()
    if (trimmed !== "") info.model = trimmed
  }

  return Object.keys(info).length === 0 ? undefined : info
}

/** Operator or gateway the request was sent to, from its URL host. */
export function inferFromUrl(url: string | undefined): UpstreamInfo | undefined {
  if (url === undefined) return undefined
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (host === "") return undefined
  for (const [suffix, match] of KNOWN_ENDPOINT_HOSTS) {
    // Suffixes are specific enough (`opencode.ai`, `bedrock-runtime.`) that an
    // infix match is safe and covers regional hosts.
    if (!host.includes(suffix)) continue
    const info: UpstreamInfo = {}
    if (match.operator !== undefined) {
      info.operator = match.operator
      info.source = `endpoint:${host}`
    }
    if (match.router !== undefined) {
      info.router = match.router
      info.source ??= `endpoint:${host}`
    }
    return Object.keys(info).length === 0 ? undefined : info
  }
  return undefined
}

/**
 * Operator a provider package names, e.g. `@opencode/ai/providers/fireworks`
 * or `@ai-sdk/amazon-bedrock`. Only the last token counts, so protocol
 * packages such as `@ai-sdk/openai-compatible` do not pretend to be OpenAI.
 */
export function inferFromPackage(pkg: string | undefined): UpstreamInfo | undefined {
  if (pkg === undefined) return undefined
  const parts = pkg.split("/").filter((part) => part !== "")
  const name = parts[parts.length - 1]?.toLowerCase() ?? ""
  if (name === "" || GENERIC_PACKAGES.has(name)) return undefined
  const last = tokensOf(name).pop()
  if (last === undefined) return undefined
  const operator = normalizeUpstream(last)
  if (operator !== undefined) return { operator, source: `package:${pkg}` }
  const router = normalizeRouter(name)
  if (router !== undefined) return { router, source: `package:${pkg}` }
  return undefined
}

/**
 * First non-empty field of every candidate, in argument order. Callers pass
 * the most authoritative source first.
 */
export function mergeUpstream(...candidates: readonly (UpstreamInfo | undefined)[]): UpstreamInfo | undefined {
  const merged: UpstreamInfo = {}
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (merged.operator === undefined && candidate.operator !== undefined) {
      merged.operator = candidate.operator
      merged.source = candidate.source
    }
    if (merged.model === undefined && candidate.model !== undefined) merged.model = candidate.model
    if (merged.router === undefined && candidate.router !== undefined) {
      merged.router = candidate.router
      merged.source ??= candidate.source
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged
}

/** Copy response headers for storage, dropping credentials and long values. */
export function redactHeaders(headers: Headers | Record<string, string | undefined> | undefined): Record<string, string> {
  if (!headers) return {}
  const entries: [string, string][] = []
  if (typeof (headers as Headers).forEach === "function") {
    ;(headers as Headers).forEach((value, key) => entries.push([key, value]))
  } else {
    for (const key of Object.keys(headers)) {
      const value = (headers as Record<string, string | undefined>)[key]
      if (value !== undefined) entries.push([key, value])
    }
  }
  const result: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue
    result[key.toLowerCase()] = value.length > 256 ? `${value.slice(0, 256)}…` : value
  }
  return result
}
