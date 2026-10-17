import { describe, expect, test } from "bun:test"
import {
  collectEvidence,
  inferFromHeaders,
  inferFromPackage,
  inferFromUrl,
  mergeUpstream,
  normalizeRouter,
  normalizeUpstream,
  redactHeaders,
} from "../src/upstream"

/** Headers captured from a real `opencode` gateway response (values verbatim). */
const GATEWAY_HEADERS = {
  "cache-control": "no-cache",
  "cf-ray": "a4afa2c39f164d29-PHL",
  connection: "keep-alive",
  "content-type": "text/event-stream",
  date: "Thu, 15 Oct 2026 14:50:26 GMT",
  server: "cloudflare",
  "transfer-encoding": "chunked",
  "x-opencode-endpoint-id": "orcarouter-dsv4.1flash",
  "x-opencode-log-id": "78cd3e7f-b42c-4903-a28a-a177727dfd73",
  "x-opencode-upstream-model-id": "deepseek/deepseek-v4.1-flash",
  "x-zen-model": "deepseek-v4.1-flash",
}

describe("collectEvidence", () => {
  test("reads the candidate headers from a Headers instance", () => {
    const headers = new Headers({ "x-served-by": "together-vllm", server: "cloudflare", "x-other": "ignored" })
    expect(collectEvidence(headers)).toEqual([
      { header: "x-served-by", value: "together-vllm" },
      { header: "server", value: "cloudflare" },
    ])
  })

  test("reads the candidate headers from a plain record, case-insensitively", () => {
    expect(collectEvidence({ "X-Served-By": "deepinfra" })).toEqual([{ header: "x-served-by", value: "deepinfra" }])
  })

  test("is empty without headers", () => {
    expect(collectEvidence(undefined)).toEqual([])
    expect(collectEvidence({})).toEqual([])
  })
})

describe("normalizeUpstream", () => {
  test("maps known operators to canonical names", () => {
    expect(normalizeUpstream("together")).toBe("Together")
    expect(normalizeUpstream("Together - vLLM")).toBe("Together")
    expect(normalizeUpstream("deepinfra")).toBe("DeepInfra")
    expect(normalizeUpstream("fireworks-ai")).toBe("Fireworks")
    expect(normalizeUpstream("groq")).toBe("Groq")
    expect(normalizeUpstream("deepseek")).toBe("DeepSeek")
    expect(normalizeUpstream("cloudflare")).toBe("Cloudflare")
  })

  test("treats the gateway as not-an-upstream", () => {
    expect(normalizeUpstream("opencode")).toBeUndefined()
    expect(normalizeUpstream("opencode-go")).toBeUndefined()
    expect(normalizeUpstream("orcarouter-dsv4.1flash")).toBeUndefined()
  })

  test("gives up on unknown names", () => {
    expect(normalizeUpstream(undefined)).toBeUndefined()
    expect(normalizeUpstream("")).toBeUndefined()
    expect(normalizeUpstream("dl-ai-7")).toBeUndefined()
  })
})

describe("normalizeRouter", () => {
  test("names the gateways that route to several operators", () => {
    expect(normalizeRouter("opencode")).toBe("opencode")
    expect(normalizeRouter("orcarouter-dsv4.1flash")).toBe("orcarouter")
    expect(normalizeRouter("openrouter")).toBe("openrouter")
    expect(normalizeRouter("fireworks")).toBeUndefined()
  })
})

describe("inferFromHeaders", () => {
  // Regression: `server: cloudflare` is the CDN in front of the gateway, not
  // the operator. The gateway reports the real one in its own headers.
  test("reads the operator the gateway reports, never the CDN", () => {
    expect(inferFromHeaders(GATEWAY_HEADERS)).toEqual({
      operator: "DeepSeek",
      model: "deepseek/deepseek-v4.1-flash",
      router: "orcarouter-dsv4.1flash",
      source: "header:x-opencode-upstream-model-id",
    })
  })

  test("network headers alone never name an operator", () => {
    const inferred = inferFromHeaders({ server: "cloudflare", via: "1.1 cloudflare", "cf-ray": "abc123" })
    expect(inferred?.operator).toBeUndefined()
    expect(inferred).toBeUndefined()
  })

  test("prefers an operator header over a router header", () => {
    const inferred = inferFromHeaders({ "x-opencode-endpoint-id": "orcarouter-dsv4.1flash", "x-served-by": "together" })
    expect(inferred).toEqual({ operator: "Together", router: "orcarouter-dsv4.1flash", source: "header:x-served-by" })
  })

  test("skips values naming the gateway itself", () => {
    expect(inferFromHeaders({ "x-upstream": "opencode", "x-inference-provider": "deepinfra" })).toEqual({
      operator: "DeepInfra",
      router: "opencode",
      source: "header:x-inference-provider",
    })
  })

  test("keeps an unrecognised value as the upstream model, not as an operator", () => {
    expect(inferFromHeaders({ "x-served-by": "dl-ai-7" })).toEqual({ model: "dl-ai-7", source: "header:x-served-by" })
  })

  test("falls back to the gateway's own model id", () => {
    expect(inferFromHeaders({ "x-zen-model": "deepseek-v4.1-flash" })).toEqual({ model: "deepseek-v4.1-flash" })
  })

  test("is undefined without headers", () => {
    expect(inferFromHeaders(undefined)).toBeUndefined()
    expect(inferFromHeaders({})).toBeUndefined()
  })
})

describe("inferFromUrl", () => {
  test("names the operator behind a direct endpoint", () => {
    expect(inferFromUrl("https://api.fireworks.ai/inference/v1/chat/completions")).toEqual({
      operator: "Fireworks",
      source: "endpoint:api.fireworks.ai",
    })
    expect(inferFromUrl("https://api.deepseek.com/v1/chat/completions")?.operator).toBe("DeepSeek")
    expect(inferFromUrl("https://bedrock-runtime.eu-central-1.amazonaws.com/model/x/invoke")?.operator).toBe("AWS Bedrock")
  })

  test("names a gateway router instead of pretending it is an operator", () => {
    expect(inferFromUrl("https://opencode.ai/zen/v1/chat/completions")).toEqual({
      router: "opencode",
      source: "endpoint:opencode.ai",
    })
    expect(inferFromUrl("https://openrouter.ai/api/v1/chat/completions")?.router).toBe("openrouter")
  })

  test("ignores unknown hosts and broken URLs", () => {
    expect(inferFromUrl("https://example.test/v1")).toBeUndefined()
    expect(inferFromUrl("not a url")).toBeUndefined()
    expect(inferFromUrl(undefined)).toBeUndefined()
  })
})

describe("inferFromPackage", () => {
  test("names the operator of a provider package", () => {
    expect(inferFromPackage("@opencode/ai/providers/fireworks")).toEqual({
      operator: "Fireworks",
      source: "package:@opencode/ai/providers/fireworks",
    })
    expect(inferFromPackage("@ai-sdk/amazon-bedrock")?.operator).toBe("AWS Bedrock")
  })

  test("a gateway package is a router", () => {
    expect(inferFromPackage("@opencode/ai/providers/opencode")).toEqual({
      router: "opencode",
      source: "package:@opencode/ai/providers/opencode",
    })
  })

  test("protocol packages never pretend to be an operator", () => {
    expect(inferFromPackage("@ai-sdk/openai-compatible")).toBeUndefined()
    expect(inferFromPackage("@ai-sdk/openai")).toBeUndefined()
    expect(inferFromPackage("some-unknown-package")).toBeUndefined()
    expect(inferFromPackage(undefined)).toBeUndefined()
  })
})

describe("mergeUpstream", () => {
  test("keeps the first field found, in argument order", () => {
    const merged = mergeUpstream(
      { model: "deepseek/deepseek-v4.1-flash", source: "header:x-opencode-upstream-model-id" },
      { operator: "Fireworks", source: "endpoint:api.fireworks.ai" },
      { router: "opencode" },
    )
    expect(merged).toEqual({
      model: "deepseek/deepseek-v4.1-flash",
      operator: "Fireworks",
      router: "opencode",
      source: "endpoint:api.fireworks.ai",
    })
  })

  test("keeps the operator source when only a model was known first", () => {
    expect(mergeUpstream({ model: "x/y" }, { operator: "Together", source: "provenance" })).toEqual({
      model: "x/y",
      operator: "Together",
      source: "provenance",
    })
  })

  test("is undefined without candidates", () => {
    expect(mergeUpstream(undefined, undefined)).toBeUndefined()
  })
})

describe("redactHeaders", () => {
  test("drops credentials and normalises names", () => {
    const headers = new Headers({ Authorization: "Bearer secret", "x-served-by": "together", Cookie: "a=b" })
    expect(redactHeaders(headers)).toEqual({ "x-served-by": "together" })
  })

  test("truncates long values", () => {
    const long = "x".repeat(300)
    const redacted = redactHeaders({ "cf-ray": long })
    expect(redacted["cf-ray"]!.length).toBeLessThan(long.length)
    expect(redacted["cf-ray"]!.endsWith("…")).toBe(true)
  })

  test("is empty without headers", () => {
    expect(redactHeaders(undefined)).toEqual({})
  })
})
