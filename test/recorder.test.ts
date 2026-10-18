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

describe("recorder identity", () => {
  test("records the provider and the model the step ran as", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({
      type: "session.step.started",
      created: 50,
      data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } },
    })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).provider_id).toBe("opencode-go")
    expect(stepRow(db).model_id).toBe("deepseek-v4.1-flash")
    db.close()
  })

  test("attributes a step that started before the plugin loaded to the last model selected", () => {
    const { db, recorder } = harness()
    // The session published its model before the plugin was listening.
    recorder.handleEvent({ type: "session.model.selected", created: 10, data: { sessionID: "s1", model: { providerID: "deepseek", id: "deepseek-flash" } } })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).provider_id).toBe("deepseek")
    expect(stepRow(db).model_id).toBe("deepseek-flash")
    db.close()
  })

  test("keeps the provider of the step itself, not of the session's newest model", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.started", created: 50, data: { sessionID: "s1", assistantMessageID: "a1", model: { providerID: "opencode-go", id: "m1" } } })
    // The user switches provider while the step is still streaming.
    recorder.handleEvent({ type: "session.model.selected", created: 60, data: { sessionID: "s1", model: { providerID: "deepseek", id: "m2" } } })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).provider_id).toBe("opencode-go")
    db.close()
  })

  test("a session that is gone takes its remembered model with it", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.created", created: 10, data: { sessionID: "s1", model: { providerID: "opencode", id: "m1" } } })
    recorder.handleEvent({ type: "session.deleted", created: 20, data: { sessionID: "s1" } })
    recorder.handleEvent({ type: "session.step.ended", created: 80, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).provider_id).toBeNull()
    db.close()
  })
})

describe("recorder under a locked database", () => {
  test("defers the write instead of waiting for the lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "usage-insights-recorder-"))
    const path = join(directory, "usage.db")
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
    // The session is deleted before its step ends: the in-flight entry and the
    // model remembered for it go too, so a deleted session leaves nothing.
    recorder.handleEvent({ type: "session.deleted", created: 3, data: { sessionID: "s1" } })
    expect(recorder.pendingFor("s1")).toBeUndefined()
    recorder.handleEvent({ type: "session.step.ended", created: 4, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).provider_id).toBeNull()
    db.close()
  })

  test("records a step whose model was never observed without an identity", () => {
    const { db, recorder } = harness()
    recorder.handleEvent({ type: "session.step.ended", created: 20, data: { sessionID: "s1", assistantMessageID: "a1", tokens: { input: 1 } } })
    expect(stepRow(db).provider_id).toBeNull()
    expect(stepRow(db).model_id).toBeNull()
    expect(stepRow(db).input_tokens).toBe(1)
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
