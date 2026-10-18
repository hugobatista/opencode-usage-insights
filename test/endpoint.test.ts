import { describe, expect, test } from "bun:test"
import { ENDPOINT_HEADER, inferFromHeaders, inferFromUrl, mergeEndpoint } from "../src/endpoint"

/**
 * Endpoint discovery: the identity the line and the panel lead with. Only the
 * routing endpoint is discovered — the operator a header mentions is not who
 * ran the model, so nothing here classifies one.
 */

describe("inferFromHeaders", () => {
  test("reads the routing endpoint a gateway names", () => {
    const info = inferFromHeaders({ [ENDPOINT_HEADER]: "orcarouter-dsv4.1flash" })
    expect(info).toEqual({ router: "orcarouter-dsv4.1flash", source: `header:${ENDPOINT_HEADER}` })
  })

  test("accepts a Headers instance and trims the value", () => {
    const headers = new Headers({ [ENDPOINT_HEADER]: "  thesean-dsv4.1flash  " })
    expect(inferFromHeaders(headers)?.router).toBe("thesean-dsv4.1flash")
  })

  test("ignores headers that name an operator instead of an endpoint", () => {
    expect(inferFromHeaders({ "x-served-by": "fireworks", "x-litellm-provider": "together" })).toBeUndefined()
  })

  test("ignores an empty or absurdly long value", () => {
    expect(inferFromHeaders({ [ENDPOINT_HEADER]: "   " })).toBeUndefined()
    expect(inferFromHeaders({ [ENDPOINT_HEADER]: "x".repeat(65) })).toBeUndefined()
  })

  test("rejects a value that is not one token", () => {
    // The audit's payload: an escape sequence in a response header used to
    // reach the panel's own header line, where the terminal acted on it.
    expect(inferFromHeaders({ [ENDPOINT_HEADER]: "gw\u001b]0;pwned\u0007" })).toBeUndefined()
    expect(inferFromHeaders({ [ENDPOINT_HEADER]: "two words" })).toBeUndefined()
    expect(inferFromHeaders({ [ENDPOINT_HEADER]: "semi;colon" })).toBeUndefined()
  })

  test("folds the case, so the same endpoint groups once", () => {
    expect(inferFromHeaders({ [ENDPOINT_HEADER]: "OrcaRouter-DSV4.1Flash" })?.router).toBe("orcarouter-dsv4.1flash")
  })

  test("has nothing to say without headers", () => {
    expect(inferFromHeaders(undefined)).toBeUndefined()
    expect(inferFromHeaders({})).toBeUndefined()
  })
})

describe("inferFromUrl", () => {
  test("does not mistake a gateway for the operator behind it", () => {
    // The gateway is the route, not who ran the model: without its own header
    // the endpoint is unknown, and the views say so instead of showing the
    // provider's name as if it were the endpoint.
    expect(inferFromUrl("https://opencode.ai/zen/v1/chat")).toBeUndefined()
    expect(inferFromUrl("https://openrouter.ai/api/v1/chat")).toBeUndefined()
    expect(inferFromUrl("https://ai-gateway.vercel.sh/v1/chat")).toBeUndefined()
  })

  test("names the operator a per-operator host belongs to", () => {
    expect(inferFromUrl("https://api.fireworks.ai/inference/v1")?.router).toBe("fireworks")
    expect(inferFromUrl("https://bedrock-runtime.eu-west-1.amazonaws.com/model/x")?.router).toBe("bedrock")
    expect(inferFromUrl("https://api.deepinfra.com/v1/openai")?.router).toBe("deepinfra")
  })

  test("reports the host it matched, as evidence", () => {
    expect(inferFromUrl("https://api.novita.ai/v3/openai")?.source).toBe("endpoint:api.novita.ai")
  })

  test("leaves an unknown host without an endpoint", () => {
    expect(inferFromUrl("https://example.com/v1/chat")).toBeUndefined()
    expect(inferFromUrl("not a url")).toBeUndefined()
    expect(inferFromUrl(undefined)).toBeUndefined()
  })

  test("matches on a label boundary, so a lookalike host names nothing", () => {
    // The audit's case: a suffix match used to accept any host that merely
    // ends with a known one, including one an attacker registers.
    expect(inferFromUrl("https://api.anthropic.com.evil.tld/v1/chat")).toBeUndefined()
    expect(inferFromUrl("https://notopencode.ai/zen/v1/chat")).toBeUndefined()
    expect(inferFromUrl("https://opencode.ai.evil.tld/zen")?.router).toBeUndefined()
    // A subdomain of a known host still names it.
    expect(inferFromUrl("https://gateway.api.fireworks.ai/inference")?.router).toBe("fireworks")
  })

  test("accepts the regional hosts the providers use, dash or dot", () => {
    expect(inferFromUrl("https://bedrock-runtime.us-east-1.amazonaws.com/model/x")?.router).toBe("bedrock")
    expect(inferFromUrl("https://us-central1-aiplatform.googleapis.com/v1")?.router).toBe("vertex")
    expect(inferFromUrl("https://ripple.us-east-1.amazonaws.com.evil.tld")?.router).toBeUndefined()
  })
})

describe("mergeEndpoint", () => {
  test("prefers the header over the host", () => {
    const merged = mergeEndpoint(
      { router: "orcarouter-dsv4.1flash", source: `header:${ENDPOINT_HEADER}` },
      { router: "opencode", source: "endpoint:opencode.ai" },
    )
    expect(merged).toEqual({ router: "orcarouter-dsv4.1flash", source: `header:${ENDPOINT_HEADER}` })
  })

  test("falls back to the host when no header named one", () => {
    expect(mergeEndpoint(undefined, { router: "fireworks", source: "endpoint:api.fireworks.ai" })).toEqual({
      router: "fireworks",
      source: "endpoint:api.fireworks.ai",
    })
  })

  test("has nothing when no candidate named an endpoint", () => {
    expect(mergeEndpoint(undefined, undefined)).toBeUndefined()
    expect(mergeEndpoint({}, {})).toBeUndefined()
  })
})
