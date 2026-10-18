import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createRecorder, type Recorder } from "../src/recorder"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStatsDb, openStatsDbWrite } from "../src/stats/db"

const NOW = 1_000_000

const MODEL = { providerID: "opencode", id: "m1" }

function harness(): { db: Database; recorder: Recorder } {
  const db = openStatsDb(":memory:")
  const recorder = createRecorder(db, { now: () => NOW })
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
      router: null,
      recorded_at: NOW,
    })
    expect(recorder.pendingFor("s1")).toBeUndefined()
  })

  test("keeps the streaming window even when nothing was generated", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 500,
      data: { sessionID: "s1", assistantMessageID: "a1", finish: "stop", tokens: { input: 10 } },
    })
    recorder.handleEvent({
      type: "session.step.ended",
      created: 900,
      data: { sessionID: "s1", assistantMessageID: "a1", finish: "stop", tokens: { input: 10, output: 20, reasoning: 5 } },
    })
    const row = stepRow(db)
    expect(row.streamed_at).toBeNull()
    expect(row.completed_at).toBe(900)
  })

  test("records a failed step with its outcome on the step itself", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.started", created: NOW, data: { sessionID: "s1", assistantMessageID: "a1", started: NOW - 10, model: MODEL } })
    recorder.handleEvent({ type: "session.step.failed", created: NOW, data: { sessionID: "s1", assistantMessageID: "a1", finish: "error" } })
    expect(stepRow(db).finish).toBe("error")
    // Nothing is written for the failure event: no view reads one.
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 })
    db.close()
  })
})

describe("recorder endpoint discovery", () => {
  test("applies the endpoint to the step in flight and to later steps", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.started", created: 50, data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" } } })
    recorder.handleHttpResponse({
      sessionID: "s1",
      model: { providerID: "opencode", id: "m1" },
      request: { url: "https://opencode.ai/zen/v1/chat" },
      response: { status: 200, headers: { "x-opencode-endpoint-id": "thesean-dsv4.1flash" } },
    })
    // The step in flight learns it, and so does the next one.
    recorder.handleHttpResponse({ sessionID: "s1", model: { providerID: "opencode", id: "m1" }, request: { url: "https://opencode.ai/zen/v1/chat" }, response: { headers: {} } })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    recorder.handleEvent({ type: "session.step.started", created: 90, data: { sessionID: "s1", assistantMessageID: "a2", model: { providerID: "opencode", id: "m1" } } })
    recorder.handleEvent({ type: "session.step.ended", created: 99, data: { sessionID: "s1", assistantMessageID: "a2", tokens: { input: 1 } } })
    const rows = db.query("SELECT message_id, router FROM steps ORDER BY message_id").all() as Record<string, unknown>[]
    expect(rows).toEqual([
      { message_id: "a1", router: "thesean-dsv4.1flash" },
      { message_id: "a2", router: "thesean-dsv4.1flash" },
    ])
    db.close()
  })

  test("learns the endpoint from the host when no header names one", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.started", created: 50, data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "fireworks", id: "m1" } } })
    recorder.handleHttpResponse({
      sessionID: "s1",
      model: { providerID: "fireworks", id: "m1" },
      request: { url: "https://api.fireworks.ai/inference/v1/chat/completions" },
      response: { status: 200, headers: { "x-served-by": "fireworks" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).router).toBe("fireworks")
    db.close()
  })

  test("stores nothing about an exchange that names no endpoint", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.started", created: 50, data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" } } })
    recorder.handleHttpResponse({
      sessionID: "s1",
      model: { providerID: "opencode", id: "m1" },
      request: { url: "https://example.com/v1/chat" },
      // Operator and CDN headers only: neither is the endpoint.
      response: { status: 200, headers: { "x-served-by": "together", server: "cloudflare", "cf-ray": "abc" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).router).toBeNull()
    db.close()
  })

  test("keeps the endpoint learned for a session across steps of the same model", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.started", created: 10, data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode", id: "m1" } } })
    recorder.handleEvent({ type: "session.step.ended", created: 20, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    recorder.handleHttpResponse({
      sessionID: "s1",
      model: { providerID: "opencode", id: "m1" },
      request: { url: "https://opencode.ai/zen/v1/chat" },
      response: { headers: { "x-opencode-endpoint-id": "luminal-dsv4.1flash" } },
    })
    expect(stepRow(db).router).toBe("luminal-dsv4.1flash")
    db.close()
  })
})

describe("recorder under a locked database", () => {
  test("defers the write instead of waiting for the lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "usage-insights-recorder-"))
    const path = join(directory, "stats.db")
    const db = openStatsDb(path)
    // The recorder's connection waits a moment and then gives up: the test
    // should not have to wait five seconds to prove the point.
    db.exec("PRAGMA busy_timeout = 50")
    const recorder = createRecorder(db, { now: () => NOW })
    const blocker = openStatsDbWrite(path)
    try {
      // A maintenance action holds the write lock, as a prune or a vacuum does.
      blocker.exec("BEGIN IMMEDIATE")
      const started = Bun.nanoseconds()
      recorder.handleEvent({ type: "session.step.started", created: 10, data: { sessionID: "s1", assistantMessageID: "a1", model: MODEL } })
      recorder.handleEvent({ type: "session.step.ended", created: 20, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6
      // One short wait, not a stall: the agent's event path stays responsive.
      expect(elapsedMs).toBeLessThan(500)
      // Nothing is lost: the record is queued, not dropped.
      expect((db.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }).n).toBe(0)
      blocker.exec("ROLLBACK")
      blocker.close()
      // The next event lands it.
      recorder.handleEvent({ type: "session.step.streamed", created: 30, data: { sessionID: "s1", assistantMessageID: "a1" } })
      expect((db.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }).n).toBe(1)
      expect(stepRow(db).input_tokens).toBe(1)
    } finally {
      blocker.close()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("recorder robustness", () => {
  test("forgets a session that is gone", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.created", created: 1, data: { sessionID: "s1", model: MODEL } })
    recorder.handleEvent({ type: "session.step.started", created: 2, data: { sessionID: "s1", assistantMessageID: "a1", model: MODEL } })
    recorder.handleHttpResponse({
      sessionID: "s1",
      model: MODEL,
      response: { headers: { "x-opencode-endpoint-id": "gw-1" } },
    })
    // The session is deleted before its step ends: the in-flight entry and the
    // endpoint learned for it go too, so a deleted session leaves nothing.
    recorder.handleEvent({ type: "session.deleted", created: 3, data: { sessionID: "s1" } })
    expect(recorder.pendingFor("s1")).toBeUndefined()
    recorder.handleEvent({ type: "session.step.ended", created: 4, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).router).toBeNull()
    db.close()
  })

  test("a gateway that repeats its endpoint costs no write", () => {
    const { db, recorder } = harness()
    const response = {
      sessionID: "s1",
      model: MODEL,
      request: { url: "https://opencode.ai/zen/v1/chat" },
      response: { headers: { "x-opencode-endpoint-id": "gw-1" } },
    }
    recorder.handleEvent({ type: "session.step.started", created: 10, data: { sessionID: "s1", assistantMessageID: "a1", model: MODEL } })
    recorder.handleHttpResponse(response)
    recorder.handleEvent({ type: "session.step.ended", created: 20, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    // The step carries the endpoint the gateway named, applied when it was
    // written rather than by a second statement on the response path.
    expect(stepRow(db).router).toBe("gw-1")

    // The next response observes the same endpoint for the same model: there
    // is nothing left to apply, and the response path stays a map lookup.
    const changes = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n
    const before = changes()
    recorder.handleHttpResponse(response)
    expect(changes()).toBe(before)
    db.close()
  })

  test("a gateway that re-routes is seen", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.started", created: 10, data: { sessionID: "s1", assistantMessageID: "a1", model: MODEL } })
    recorder.handleHttpResponse({ sessionID: "s1", model: MODEL, response: { headers: { "x-opencode-endpoint-id": "gw-1" } } })
    recorder.handleEvent({ type: "session.step.ended", created: 20, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    recorder.handleEvent({ type: "session.step.started", created: 30, data: { sessionID: "s1", assistantMessageID: "a2", model: MODEL } })
    recorder.handleHttpResponse({ sessionID: "s1", model: MODEL, response: { headers: { "x-opencode-endpoint-id": "gw-2" } } })
    recorder.handleEvent({ type: "session.step.ended", created: 40, data: { sessionID: "s1", assistantMessageID: "a2", tokens: { input: 1 } } })
    // The re-route is not retroactive: a1 keeps the endpoint that served it,
    // and only steps recorded without one are filled in.
    const rows = db.query("SELECT message_id, router FROM steps ORDER BY message_id").all()
    expect(rows).toEqual([
      { message_id: "a1", router: "gw-1" },
      { message_id: "a2", router: "gw-2" },
    ])
    db.close()
  })

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

  test("ignores the events whose rows no view reads", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.execution.succeeded", created: NOW, data: { sessionID: "s1" } })
    recorder.handleEvent({ type: "session.execution.failed", created: NOW, data: { sessionID: "s1" } })
    recorder.handleEvent({ type: "session.usage.recorded", created: NOW, data: { sessionID: "s1", tokens: { input: 5 } } })
    recorder.handleEvent({ type: "session.model.selected", created: NOW, data: { sessionID: "s1", model: MODEL } })
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 })
    db.close()
  })
})
