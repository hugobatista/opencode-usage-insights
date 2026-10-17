import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createRecorder, type Recorder } from "../src/recorder"
import { openStatsDb } from "../src/stats/db"

const NOW = 1_000_000

function harness(options?: { captureHeaders?: boolean; providerPackage?: (providerID: string | undefined) => string | undefined }): {
  db: Database
  recorder: Recorder
} {
  const db = openStatsDb(":memory:")
  const recorder = createRecorder(db, {
    captureHeaders: options?.captureHeaders ?? false,
    providerPackage: options?.providerPackage,
    now: () => NOW,
  })
  return { db, recorder }
}

function stepRow(db: Database): Record<string, unknown> {
  return db.query("SELECT * FROM steps").get() as Record<string, unknown>
}

describe("recorder sessions", () => {
  test("records created, renamed and moved sessions", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.created",
      created: 100,
      data: { sessionID: "s1", parentID: "parent", title: "First", location: { directory: "/tmp/project" } },
    })
    recorder.handleEvent({ type: "session.renamed", created: 200, data: { sessionID: "s1", title: "Renamed" } })
    recorder.handleEvent({ type: "session.moved", created: 300, data: { sessionID: "s1", location: { directory: "/tmp/other" } } })
    const row = db.query("SELECT * FROM sessions").get() as Record<string, unknown>
    expect(row).toEqual({
      session_id: "s1",
      parent_id: "parent",
      directory: "/tmp/other",
      title: "Renamed",
      started_at: 100,
      updated_at: 300,
    })
  })

  test("records user and synthetic prompts, ignores compaction inbox items", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.inbox.enqueued", created: 10, data: { sessionID: "s1", inboxID: "p1", item: { type: "user" } } })
    recorder.handleEvent({ type: "session.inbox.enqueued", created: 20, data: { sessionID: "s1", inboxID: "p2", item: { type: "synthetic" } } })
    recorder.handleEvent({ type: "session.inbox.enqueued", created: 30, data: { sessionID: "s1", inboxID: "p3", item: { type: "compaction" } } })
    const rows = db.query("SELECT message_id, created_at FROM prompts ORDER BY message_id").all() as Record<string, unknown>[]
    expect(rows).toEqual([
      { message_id: "p1", created_at: 10 },
      { message_id: "p2", created_at: 20 },
    ])
  })
})

describe("recorder steps", () => {
  test("joins started, streamed and ended into one step", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 500,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1", variant: "max" }, started: 400 },
    })
    recorder.handleEvent({ type: "session.step.streamed", created: 550, data: { sessionID: "s1", assistantMessageID: "a1" } })
    recorder.handleEvent({
      type: "session.step.ended",
      created: 900,
      data: {
        sessionID: "s1",
        assistantMessageID: "a1",
        finish: "stop",
        cost: 0.02,
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } },
        providerState: { route: "go" },
      },
    })
    expect(stepRow(db)).toEqual({
      message_id: "a1",
      session_id: "s1",
      parent_id: null,
      provider_id: "opencode",
      model_id: "m1",
      variant: "max",
      input_tokens: 10,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_read: 30,
      cache_write: 40,
      cost: 0.02,
      created_at: 400,
      streamed_at: 550,
      completed_at: 900,
      finish: "stop",
      provider_state: '{"route":"go"}',
      upstream: null,
      upstream_source: null,
      upstream_model: null,
      router: null,
      tps: (25 / (550 - 400)) * 1000,
      recorded_at: NOW,
    })
    expect(recorder.pendingFor("s1")).toBeUndefined()
  })

  test("leaves tokens per second null without a streaming window", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 500,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" }, started: 400 },
    })
    recorder.handleEvent({
      type: "session.step.ended",
      created: 900,
      data: { sessionID: "s1", assistantMessageID: "a1", finish: "stop", tokens: { input: 10, output: 20, reasoning: 5 } },
    })
    expect(stepRow(db).tps).toBeNull()
  })

  test("falls back to the last selected model when the step start was missed", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.model.selected",
      created: 100,
      data: { sessionID: "s1", model: { providerID: "github-copilot", id: "gpt-5" }, previous: { providerID: "opencode", id: "m1" } },
    })
    recorder.handleEvent({
      type: "session.step.ended",
      created: 200,
      data: { sessionID: "s1", assistantMessageID: "a1", finish: "stop", tokens: { input: 1, output: 2 } },
    })
    const row = stepRow(db)
    expect(row.provider_id).toBe("github-copilot")
    expect(row.model_id).toBe("gpt-5")
    expect(row.created_at).toBeNull()
    expect(row.completed_at).toBe(200)
    const event = db.query("SELECT kind, data FROM events WHERE kind = 'model-selected'").get() as Record<string, unknown>
    expect(JSON.parse(event.data as string)).toEqual({ model: { providerID: "github-copilot", id: "gpt-5" }, previous: { providerID: "opencode", id: "m1" } })
  })

  test("records failed steps with their error", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 100,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" } },
    })
    recorder.handleEvent({
      type: "session.step.failed",
      created: 200,
      data: { sessionID: "s1", assistantMessageID: "a1", error: { message: "rate limited" }, finish: "content-filter" },
    })
    expect(stepRow(db).finish).toBe("content-filter")
    const event = db.query("SELECT data FROM events WHERE kind = 'step-failed'").get() as Record<string, unknown>
    expect(JSON.parse(event.data as string)).toEqual({ error: "rate limited", finish: "content-filter", rawFinish: undefined })
  })
})

describe("recorder upstream discovery", () => {
  test("applies compaction provenance to the session's existing steps", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.created", created: 10, data: { sessionID: "s1" } })
    recorder.handleEvent({
      type: "session.step.started",
      created: 50,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    recorder.handleEvent({
      type: "session.compaction.ended",
      created: 120,
      data: {
        sessionID: "s1",
        reason: "auto",
        model: { providerID: "opencode", id: "m1" },
        providerContext: { provenance: { provider: "deepinfra", modelID: "m1" } },
      },
    })
    const row = stepRow(db)
    expect(row.upstream).toBe("DeepInfra")
    expect(row.upstream_source).toBe("provenance")
    const compaction = db.query("SELECT data FROM events WHERE kind = 'compaction'").get() as Record<string, unknown>
    expect(JSON.parse(compaction.data as string)).toMatchObject({ reason: "auto" })
  })

  test("applies header evidence to the step in flight and to later steps", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 50,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" } },
    })
    recorder.handleHttpResponse({
      sessionID: "s1",
      kind: "primary",
      model: { providerID: "opencode", id: "m1" },
      request: { method: "POST", url: "https://gateway.example/inference/go/v1/chat/completions" },
      response: { status: 200, headers: { "x-served-by": "together-vllm" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    // A later step of the same session inherits the learned operator.
    recorder.handleEvent({
      type: "session.step.started",
      created: 90,
      data: { sessionID: "s1", assistantMessageID: "a2", model: { providerID: "opencode", id: "m1" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 99, data: { sessionID: "s1", assistantMessageID: "a2", tokens: { input: 1 } } })
    const rows = db.query("SELECT message_id, upstream, upstream_source FROM steps ORDER BY message_id").all() as Record<string, unknown>[]
    expect(rows).toEqual([
      { message_id: "a1", upstream: "Together", upstream_source: "header:x-served-by" },
      { message_id: "a2", upstream: "Together", upstream_source: "header:x-served-by" },
    ])
  })

  test("captures redacted headers only when asked", () => {
    const { db, recorder } = harness({ captureHeaders: true })
    recorder.handleHttpResponse({
      sessionID: "s1",
      kind: "primary",
      request: { method: "POST", url: "https://gateway.example/inference/go/v1/chat/completions?x=1" },
      response: { status: 200, headers: { authorization: "Bearer secret", "x-served-by": "groq" } },
    })
    const row = db.query("SELECT method, path, status, headers FROM http_responses").get() as Record<string, unknown>
    expect(row.method).toBe("POST")
    expect(row.path).toBe("/inference/go/v1/chat/completions")
    expect(row.status).toBe(200)
    expect(JSON.parse(row.headers as string)).toEqual({ "x-served-by": "groq" })
  })

  test("ignores responses without evidence", () => {
    const { db, recorder } = harness({ captureHeaders: false })
    recorder.handleHttpResponse({ sessionID: "s1", kind: "primary", response: { status: 200, headers: { "content-type": "text/event-stream" } } })
    const count = db.query("SELECT COUNT(*) AS n FROM http_responses").get() as { n: number }
    expect(count.n).toBe(0)
  })

  // Regression: `server: cloudflare` is the CDN in front of the gateway, and it
  // used to win over the gateway's own header naming the real operator.
  test("reads the gateway's operator header, never the CDN", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 50,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "deepseek-v4.1-flash" } },
    })
    recorder.handleHttpResponse({
      sessionID: "s1",
      kind: "primary",
      model: { providerID: "opencode", id: "deepseek-v4.1-flash" },
      request: { method: "POST", url: "https://opencode.ai/zen/v1/chat/completions" },
      response: {
        status: 200,
        headers: {
          server: "cloudflare",
          "cf-ray": "a4afa2c39f164d29-PHL",
          "content-type": "text/event-stream",
          "x-opencode-endpoint-id": "orcarouter-dsv4.1flash",
          "x-opencode-log-id": "78cd3e7f-b42c-4903-a28a-a177727dfd73",
          "x-opencode-upstream-model-id": "deepseek/deepseek-v4.1-flash",
          "x-zen-model": "deepseek-v4.1-flash",
        },
      },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    const row = stepRow(db)
    expect(row.upstream).toBe("DeepSeek")
    expect(row.upstream_source).toBe("header:x-opencode-upstream-model-id")
    expect(row.upstream_model).toBe("deepseek/deepseek-v4.1-flash")
    expect(row.router).toBe("orcarouter-dsv4.1flash")
  })

  test("CDN headers alone never name an operator", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 50,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" } },
    })
    recorder.handleHttpResponse({
      sessionID: "s1",
      kind: "primary",
      request: { method: "POST", url: "https://opencode.ai/zen/v1/chat/completions" },
      response: { status: 200, headers: { server: "cloudflare", via: "1.1 cloudflare", "cf-ray": "abc123" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    const row = stepRow(db)
    expect(row.upstream).toBeNull()
    expect(row.router).toBe("opencode")
  })

  test("names the operator of the endpoint the request went to", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 50,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "fireworks", id: "llama" } },
    })
    recorder.handleHttpResponse({
      sessionID: "s1",
      kind: "primary",
      request: { method: "POST", url: "https://api.fireworks.ai/inference/v1/chat/completions" },
      response: { status: 200, headers: { "content-type": "text/event-stream" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    const row = stepRow(db)
    expect(row.upstream).toBe("Fireworks")
    expect(row.upstream_source).toBe("endpoint:api.fireworks.ai")
  })

  test("falls back to the provider package when nothing else names an operator", () => {
    const { db, recorder } = harness({ providerPackage: (providerID) => (providerID === "fireworks" ? "@opencode/ai/providers/fireworks" : undefined) })
    recorder.handleEvent({
      type: "session.step.started",
      created: 50,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "fireworks", id: "llama" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    const row = stepRow(db)
    expect(row.upstream).toBe("Fireworks")
    expect(row.upstream_source).toBe("package:@opencode/ai/providers/fireworks")
  })
})

describe("recorder robustness", () => {
  test("ignores unknown events and malformed payloads", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.text.delta", created: 1, data: { sessionID: "s1" } })
    recorder.handleEvent({ type: "session.step.ended", created: 2, data: {} })
    recorder.handleEvent({ type: "session.inbox.enqueued", created: 3, data: { sessionID: "s1", item: { type: "user" } } })
    recorder.handleEvent({ type: "session.created", created: 4 })
    const steps = db.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }
    const prompts = db.query("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }
    expect(steps.n).toBe(0)
    expect(prompts.n).toBe(0)
  })

  test("records execution outcomes and auxiliary usage", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.execution.succeeded", created: 10, data: { sessionID: "s1" } })
    recorder.handleEvent({ type: "session.execution.failed", created: 20, data: { sessionID: "s1" } })
    recorder.handleEvent({ type: "session.usage.recorded", created: 30, data: { sessionID: "s1", source: "title", tokens: { input: 5 }, cost: 0.001 } })
    const events = db.query("SELECT kind, data FROM events ORDER BY at").all() as { kind: string; data: string }[]
    expect(events.map((event) => event.kind)).toEqual(["execution", "execution", "usage-recorded"])
    expect(JSON.parse(events[0]!.data)).toEqual({ outcome: "succeeded" })
    expect(JSON.parse(events[2]!.data)).toMatchObject({ source: "title", cost: 0.001 })
  })
})
