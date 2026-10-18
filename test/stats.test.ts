import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  SCHEMA_VERSION,
  exportNdjson,
  importNdjson,
  openStatsDb,
  recordEvent,
  recordPrompt,
  recordStep,
  setStepRouter,
  upsertSession,
  type StepRecord,
} from "../src/stats/db"
import { cacheDropsOf, cachePairs, latencyOf, stepRows, ttlEvidenceOf } from "../src/stats/aggregates"
import {
  cacheHitRatio,
  models,
  overview,
  percentile,
  routerBefore,
  routerForSteps,
  sessions,
  timeline,
  turns,
  type Range,
} from "../src/stats/queries"

function freshDb(): Database {
  return openStatsDb(":memory:")
}

const s1Steps: StepRecord[] = [
  {
    messageID: "a1",
    sessionID: "s1",
    providerID: "opencode",
    modelID: "m1",
    createdAt: 1_000_000,
    streamedAt: 1_000_300,
    completedAt: 1_001_200,
    cacheRead: 100_000,
    cacheWrite: 1_200,
    input: 500,
    output: 200,
    cost: 0.01,
    finish: "stop",
  },
  { messageID: "a2", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 1_010_000, streamedAt: 1_010_200, completedAt: 1_011_000, cacheRead: 99_000, input: 300, output: 100, cost: 0.005 },
  { messageID: "a3", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 2_000_000, streamedAt: 2_000_400, completedAt: 2_001_000, cacheRead: 50_000, input: 400, output: 150, cost: 0.006 },
  { messageID: "a4", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 2_600_000, streamedAt: 2_600_200, completedAt: 2_610_000, cacheRead: 0, input: 1_000, output: 800, reasoning: 100, cost: 0.02 },
]

const s2Steps: StepRecord[] = [
  { messageID: "b1", sessionID: "s2", parentID: "s1", providerID: "github-copilot", modelID: "m2", createdAt: 1_500_000, streamedAt: 1_500_300, completedAt: 1_505_000, cacheRead: 20_000, input: 100, output: 50, cost: 0.001 },
  { messageID: "b2", sessionID: "s2", parentID: "s1", providerID: "github-copilot", modelID: "m2", createdAt: 1_506_000, streamedAt: 1_506_200, completedAt: 1_507_000, cacheRead: 19_500, input: 200, output: 100, cost: 0.002 },
  { messageID: "b3", sessionID: "s2", parentID: "s1", providerID: "github-copilot", modelID: "m2", createdAt: 1_509_000, streamedAt: 1_509_300, completedAt: 1_510_000, cacheRead: 25_000, input: 50, output: 20, cost: 0.0005 },
]

function seed(): Database {
  const db = freshDb()
  upsertSession(db, { sessionID: "s1", title: "Session one", directory: "/tmp/s1", startedAt: 900_000, updatedAt: 2_610_000 })
  upsertSession(db, { sessionID: "s2", parentID: "s1", directory: "/tmp/s1" })
  const prompts: [string, string, number][] = [
    ["s1", "p1", 900_000],
    ["s1", "p2", 1_005_000],
    ["s1", "p3", 1_990_000],
    ["s1", "p4", 2_500_000],
    ["s2", "p5", 1_400_000],
  ]
  for (const [sessionID, messageID, createdAt] of prompts) recordPrompt(db, { sessionID, messageID, createdAt })
  for (const step of [...s1Steps, ...s2Steps]) recordStep(db, step)
  recordEvent(db, { sessionID: "s1", kind: "compaction", at: 2_500_000, data: { reason: "auto" } })
  return db
}

describe("stats db", () => {
  test("creates the schema in memory", () => {
    const db = freshDb()
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["events", "meta", "prompts", "sessions", "steps"]))
    // Only what a view reads is created.
    expect(tables.map((t) => t.name)).not.toContain("http_responses")
  })

  test("recordStep is idempotent by message id", () => {
    const db = freshDb()
    recordStep(db, { messageID: "a1", sessionID: "s1", input: 10, output: 1, createdAt: 5 })
    recordStep(db, { messageID: "a1", sessionID: "s1", input: 20, output: 2, createdAt: 6 })
    const rows = db.query("SELECT message_id, input_tokens, output_tokens, created_at FROM steps").all() as Record<string, unknown>[]
    expect(rows).toEqual([{ message_id: "a1", input_tokens: 20, output_tokens: 2, created_at: 6 }])
  })

  test("recordStep keeps the endpoint when re-recorded empty", () => {
    const db = freshDb()
    recordStep(db, { messageID: "a1", sessionID: "s1", router: "orcarouter-dsv4.1flash" })
    recordStep(db, { messageID: "a1", sessionID: "s1", input: 5 })
    const row = db.query("SELECT input_tokens, router FROM steps").get() as Record<string, unknown>
    expect(row).toEqual({ input_tokens: 5, router: "orcarouter-dsv4.1flash" })
  })

  test("setStepRouter attaches the endpoint after the fact", () => {
    const db = freshDb()
    recordStep(db, { messageID: "a1", sessionID: "s1" })
    setStepRouter(db, "a1", { router: "opencode", source: "endpoint:opencode.ai" })
    const row = db.query("SELECT router FROM steps").get() as Record<string, unknown>
    expect(row).toEqual({ router: "opencode" })
  })

  test("drops the columns and tables no view reads", () => {
    const db = freshDb()
    const columns = (db.query("PRAGMA table_info(steps)").all() as { name: string }[]).map((column) => column.name)
    for (const gone of ["provider_state", "upstream", "upstream_source", "upstream_model", "tps"]) {
      expect(columns).not.toContain(gone)
    }
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name)
    expect(tables).not.toContain("http_responses")
    db.close()
  })

  test("recordPrompt is idempotent per session", () => {
    const db = freshDb()
    recordPrompt(db, { sessionID: "s1", messageID: "p1", createdAt: 1 })
    recordPrompt(db, { sessionID: "s1", messageID: "p1", createdAt: 2 })
    recordPrompt(db, { sessionID: "s2", messageID: "p1", createdAt: 3 })
    const count = db.query("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }
    expect(count.n).toBe(2)
  })

  test("upsertSession keeps existing values when new ones are missing", () => {
    const db = freshDb()
    upsertSession(db, { sessionID: "s1", title: "First", directory: "/tmp" })
    upsertSession(db, { sessionID: "s1", updatedAt: 42 })
    const row = db.query("SELECT title, directory, updated_at FROM sessions").get() as Record<string, unknown>
    expect(row).toEqual({ title: "First", directory: "/tmp", updated_at: 42 })
  })

  test("export/import round-trips every table", () => {
    const source = seed()
    const dump = exportNdjson(source)
    expect(dump.split("\n").filter(Boolean)).toHaveLength(15)

    const target = freshDb()
    const imported = importNdjson(target, dump)
    expect(imported).toBe(15)
    for (const table of ["sessions", "prompts", "steps", "events"]) {
      const before = source.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      const after = target.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      expect(after.n).toBe(before.n)
    }
    // Importing twice is harmless.
    importNdjson(target, dump)
    const steps = target.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }
    expect(steps.n).toBe(7)
  })
})

describe("stats queries", () => {
  test("overview aggregates the whole store", () => {
    const usage = overview(seed())
    expect(usage).toMatchObject({
      steps: 7,
      sessions: 2,
      prompts: 5,
      input: 2_550,
      cached: 313_500,
      cacheWrite: 1_200,
      output: 1_420,
      reasoning: 100,
    })
    expect(usage.cost).toBeCloseTo(0.0445, 10)
    expect(usage.firstAt).toBe(1_000_000)
    expect(usage.lastAt).toBe(2_610_000)
    // The ratio counts the whole prompt: reads + fresh input + writes.
    expect(usage.cacheHitRatio).toBeCloseTo(313_500 / (313_500 + 2_550 + 1_200), 10)
  })

  test("overview reports the weighted streaming rate", () => {
    const db = freshDb()
    recordStep(db, { messageID: "r1", sessionID: "s", output: 100, createdAt: 0, streamedAt: 1_000, completedAt: 1_100 })
    recordStep(db, { messageID: "r2", sessionID: "s", output: 300, reasoning: 100, createdAt: 2_000, streamedAt: 3_000, completedAt: 3_100 })
    // A step with no streaming window contributes neither tokens nor time.
    recordStep(db, { messageID: "r3", sessionID: "s", output: 50 })
    // (100 + 400) tokens over (1s + 1s): the weighted rate, not the mean of rates.
    expect(overview(db).tps).toBeCloseTo(250, 6)
    db.close()
  })

  test("overview has no rate when nothing streamed", () => {
    const db = freshDb()
    recordStep(db, { messageID: "r1", sessionID: "s", output: 50 })
    expect(overview(db).tps).toBeUndefined()
    db.close()
  })

  test("overview respects the range", () => {
    const usage = overview(seed(), { from: 0, to: 1_600_000 })
    expect(usage).toMatchObject({ steps: 5, sessions: 2, prompts: 3, input: 1_150, cached: 263_500, output: 470 })
  })

  test("cacheHitRatio counts the whole prompt, cache writes included", () => {
    expect(cacheHitRatio({ input: 0, cached: 0, cacheWrite: 0 })).toBeUndefined()
    expect(cacheHitRatio({ input: 50, cached: 50, cacheWrite: 0 })).toBe(0.5)
    // A write is prompt the provider saw but did not reuse.
    expect(cacheHitRatio({ input: 50, cached: 50, cacheWrite: 100 })).toBe(0.25)
  })

  test("models names the providers behind each model", () => {
    const rows = models(seed())
    expect(rows).toHaveLength(2)
    const [first, second] = rows
    expect(first!.modelID).toBe("m1")
    expect(first!.totals.steps).toBe(4)
    expect(first!.totals.input).toBe(2_200)
    expect(first!.totals.cached).toBe(249_000)
    expect(first!.providers).toHaveLength(1)
    expect(first!.providers[0]!.providerID).toBe("opencode")
    expect(second!.modelID).toBe("m2")
    expect(second!.providers[0]!.providerID).toBe("github-copilot")
    expect(second!.totals.steps).toBe(3)
  })

  test("models reports the endpoints grouped per provider", () => {
    const db = seed()
    setStepRouter(db, "a1", { router: "orcarouter-dsv4.1flash", source: "header:x-opencode-endpoint-id" })
    const rows = models(db)
    expect(rows[0]!.providers[0]!.routers).toEqual(["orcarouter-dsv4.1flash"])
  })

  test("timeline buckets usage by fixed windows", () => {
    const buckets = timeline(seed(), undefined, 100_000)
    expect(buckets.map((b) => b.at)).toEqual([1_000_000, 1_500_000, 2_000_000, 2_600_000])
    expect(buckets[0]).toMatchObject({ steps: 2, input: 800, cached: 199_000, output: 300 })
    expect(buckets[1]).toMatchObject({ steps: 3, input: 350, cached: 64_500, output: 170 })
    expect(buckets[2]).toMatchObject({ steps: 1, cached: 50_000 })
  })

  test("cacheDrops classifies reuse loss", () => {
    const db = seed()
    const drops = cacheDropsOf(db, cachePairs(db))
    expect(drops).toHaveLength(4)
    expect(drops.map((d) => d.messageID)).toEqual(["a2", "b2", "a3", "a4"])

    const byMessage = new Map(drops.map((d) => [d.messageID, d]))
    expect(byMessage.get("a2")).toMatchObject({ tokens: 1_000, gapMs: 8_800, reason: "unknown", sessionID: "s1" })
    expect(byMessage.get("a3")).toMatchObject({ tokens: 49_000, gapMs: 989_000, reason: "expired" })
    expect(byMessage.get("b2")).toMatchObject({ tokens: 500, gapMs: 1_000, reason: "unknown", sessionID: "s2" })
  })

  test("cacheDrops calls a loss after a compaction a compaction", () => {
    const db = seed()
    const drops = cacheDropsOf(db, cachePairs(db), { ttlHintMs: 600_000 })
    const a4 = drops.find((d) => d.messageID === "a4")!
    expect(a4).toMatchObject({ tokens: 50_000, gapMs: 599_000, reason: "compaction" })
  })

  test("cacheDrops respects the range on the loss itself", () => {
    const db = seed()
    const range: Range = { from: 500_000, to: 1_600_000 }
    const drops = cacheDropsOf(db, cachePairs(db, { range }))
    expect(drops.map((d) => d.messageID)).toEqual(["a2", "b2"])
  })

  test("cacheTtlEvidence bounds the provider cache TTL", () => {
    const db = seed()
    const evidence = ttlEvidenceOf(cachePairs(db))
    const m1 = evidence.find((row) => row.modelID === "m1")!
    expect(m1).toMatchObject({ providerID: "opencode", samples: 3, minDropGapMs: 8_800 })
    expect(m1.maxHitGapMs).toBeUndefined()

    const m2 = evidence.find((row) => row.modelID === "m2")!
    expect(m2).toMatchObject({ providerID: "github-copilot", samples: 2, maxHitGapMs: 2_000, minDropGapMs: 1_000 })
  })

  test("latency percentiles", () => {
    const db = seed()
    const report = latencyOf(stepRows(db))
    expect(report.wall).toEqual({ count: 7, p50: 1_000, p90: 10_000, p99: 10_000 })
    expect(report.stream).toEqual({ count: 7, p50: 300, p90: 400, p99: 400 })
    expect(report.tps.count).toBe(7)
    // Throughput is measured over the streaming window (request to last
    // chunk), not over the tool calls a step made after it.
    expect(report.tps.p50!).toBeCloseTo(500, 6)
    expect(report.tps.p90!).toBeCloseTo(4_500, 6)
  })

  test("percentile uses nearest rank", () => {
    expect(percentile([], 50)).toBeUndefined()
    expect(percentile([7], 50)).toBe(7)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
    expect(percentile([10, 1, 5], 100)).toBe(10)
  })

  test("sessions summarises the newest sessions first", () => {
    const rows = sessions(seed())
    expect(rows.map((row) => row.sessionID)).toEqual(["s1", "s2"])
    expect(rows[0]).toMatchObject({
      title: "Session one",
      directory: "/tmp/s1",
      steps: 4,
      input: 2_200,
      cached: 249_000,
      output: 1_250,
      prompts: 4,
      providers: ["opencode"],
      models: ["m1"],
      firstAt: 1_000_000,
      lastAt: 2_610_000,
    })
    expect(rows[1]).toMatchObject({ sessionID: "s2", steps: 3, prompts: 1, providers: ["github-copilot"], models: ["m2"] })
  })

  test("sessions respects the limit and range", () => {
    const rows = sessions(seed(), { range: { from: 1_400_000, to: 1_600_000 }, limit: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sessionID).toBe("s2")
    expect(rows[0]!.steps).toBe(3)
  })

  test("routerBefore finds the endpoint of the turn before this one", () => {
    const db = freshDb()
    recordStep(db, { messageID: "r1", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 1_000, router: "router-a", recordedAt: 1_000 })
    recordStep(db, { messageID: "r2", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 3_000, router: "router-b", recordedAt: 3_000 })
    expect(routerBefore(db, "s1", 2_000)).toBe("router-a")
    expect(routerBefore(db, "s1", 4_000)).toBe("router-b")
    expect(routerBefore(db, "s1", 500)).toBeUndefined()
    expect(routerBefore(db, "s1", undefined)).toBeUndefined()
    expect(routerBefore(db, "s2", 4_000)).toBeUndefined()
  })

  test("routerForSteps reports the endpoint of the turn's own steps", () => {
    const db = freshDb()
    recordStep(db, {
      messageID: "t1a",
      sessionID: "s1",
      providerID: "opencode",
      modelID: "m1",
      createdAt: 1_000,
      router: "orcarouter-dsv4.1flash",
      recordedAt: 1_000,
    })
    recordStep(db, { messageID: "t1b", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 1_100, router: "siliconflow", recordedAt: 1_100 })
    // The next turn of the same provider and model was not named by a gateway.
    recordStep(db, { messageID: "t2a", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 2_000, recordedAt: 2_000 })

    // Newest endpoint among the steps of one turn.
    expect(routerForSteps(db, "s1", ["t1a", "t1b"])).toBe("siliconflow")
    expect(routerForSteps(db, "s1", ["t1a"])).toBe("orcarouter-dsv4.1flash")
    // A turn the gateway did not name stays unknown instead of borrowing the
    // endpoint of an older turn of the same session and model.
    expect(routerForSteps(db, "s1", ["t2a"])).toBeUndefined()
    expect(routerForSteps(db, "s1", [])).toBeUndefined()
    expect(routerForSteps(db, "s1", ["missing"])).toBeUndefined()
    expect(routerForSteps(db, "s2", ["t1a"])).toBeUndefined()
  })
})

describe("turns", () => {
  function seedTurns(): Database {
    const db = freshDb()
    upsertSession(db, { sessionID: "s1", title: "Turns", directory: "/tmp/s1", startedAt: 900 })
    recordPrompt(db, { sessionID: "s1", messageID: "p1", createdAt: 1_000 })
    recordPrompt(db, { sessionID: "s1", messageID: "p2", createdAt: 5_000 })
    recordPrompt(db, { sessionID: "s1", messageID: "p3", createdAt: 9_000 })
    // Turn 1: a tool call and the final answer.
    recordStep(db, { messageID: "a1", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 1_100, completedAt: 1_200, finish: "tool-calls", cacheRead: 1_000, input: 20, output: 10, router: "router-a", recordedAt: 1_200 })
    recordStep(db, { messageID: "a2", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 1_500, completedAt: 1_600, finish: "stop", cacheRead: 900, input: 100, output: 50, router: "router-a", recordedAt: 1_600 })
    // Turn 2: a single step, served by another endpoint.
    recordStep(db, { messageID: "a3", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 5_100, completedAt: 5_200, finish: "stop", cacheRead: 200, input: 300, output: 60, router: "router-b", recordedAt: 5_200 })
    // Turn 3: still running (asked for tools), so it is not history yet.
    recordStep(db, { messageID: "a4", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: 9_100, completedAt: 9_200, finish: "tool-calls", cacheRead: 100, recordedAt: 9_200 })
    // Another session, to prove the session filter.
    recordPrompt(db, { sessionID: "s2", messageID: "p4", createdAt: 20_000 })
    recordStep(db, { messageID: "b1", sessionID: "s2", providerID: "deepseek", modelID: "deepseek-flash", createdAt: 20_100, completedAt: 20_200, finish: "stop", cacheRead: 50, input: 10, recordedAt: 20_200 })
    return db
  }

  test("groups steps at prompt boundaries, newest first, dropping the running turn", () => {
    const rows = turns(seedTurns())
    expect(rows.map((row) => [row.sessionID, row.steps, row.finish])).toEqual([
      ["s2", 1, "stop"],
      ["s1", 1, "stop"],
      ["s1", 2, "stop"],
    ])
    const single = rows.find((row) => row.promptAt === 5_000)!
    expect(single.promptGapMs).toBe(4_000)
    expect(single.endAt).toBe(5_200)
    expect(single.latest).toMatchObject({ input: 300, cached: 200, output: 60 })
    const loop = rows.find((row) => row.promptAt === 1_000)!
    expect(loop.steps).toBe(2)
    expect(loop.promptGapMs).toBeUndefined()
    expect(loop.endAt).toBe(1_600)
    expect(loop.totals).toMatchObject({ input: 120, cached: 1_900, output: 60, steps: 2 })
    expect(loop.latest).toMatchObject({ input: 100, cached: 900 })
    expect(loop.drops).toEqual([{ messageID: "a2", tokens: 100, gapMs: 300 }])
  })

  test("reports the turn's weighted rate over its steps", () => {
    const db = freshDb()
    recordPrompt(db, { sessionID: "s", messageID: "p1", createdAt: 0 })
    recordStep(db, { messageID: "t1", sessionID: "s", output: 100, createdAt: 100, streamedAt: 1_100, completedAt: 1_200, finish: "tool-calls" })
    recordStep(db, { messageID: "t2", sessionID: "s", output: 300, createdAt: 2_000, streamedAt: 2_600, completedAt: 2_700, finish: "stop" })
    // (100 + 300) tokens over (1000 + 600) ms: the turn's weighted rate.
    expect(turns(db)[0]!.tps).toBeCloseTo((400 / 1_600) * 1000, 6)
    db.close()
  })

  test("has no rate for a turn that never streamed", () => {
    expect(turns(seedTurns())[0]!.tps).toBeUndefined()
  })

  test("marks where the routing endpoint or the provider changed", () => {
    const rows = turns(seedTurns())
    const single = rows.find((row) => row.promptAt === 5_000)!
    expect(single.router).toBe("router-b")
    expect(single.routerChanged).toBe(true)
    expect(single.providerChanged).toBe(false)
    const loop = rows.find((row) => row.promptAt === 1_000)!
    expect(loop.router).toBe("router-a")
    expect(loop.routerChanged).toBe(false)
  })

  test("filters by session, range and limit", () => {
    const db = seedTurns()
    expect(turns(db, { sessionID: "s1" })).toHaveLength(2)
    expect(turns(db, { sessionID: "s1", range: { from: 5_000 } }).map((row) => row.promptAt)).toEqual([5_000])
    expect(turns(db, { limit: 1 })).toHaveLength(1)
    expect(turns(db, { limit: 1 })[0]!.sessionID).toBe("s2")
  })
})

describe("stats db migrations", () => {
  /** A database shaped like the release that still wrote the unused columns. */
  function legacyDb(path: string): void {
    const db = new Database(path)
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, started_at INTEGER, updated_at INTEGER);
      CREATE TABLE prompts (session_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (session_id, message_id));
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, message_id TEXT, at INTEGER, data TEXT);
      CREATE TABLE http_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, method TEXT, path TEXT, status INTEGER, headers TEXT);
      CREATE TABLE steps (
        message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, provider_id TEXT, model_id TEXT, variant TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0,
        created_at INTEGER, streamed_at INTEGER, completed_at INTEGER, finish TEXT, provider_state TEXT,
        upstream TEXT, upstream_source TEXT, upstream_model TEXT, router TEXT, tps REAL, recorded_at INTEGER NOT NULL
      );
      CREATE INDEX steps_upstream ON steps(upstream);
    `)
    db.query("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run()
    db.query(
      `INSERT INTO steps (message_id, session_id, output_tokens, reasoning_tokens, created_at, streamed_at, completed_at, provider_state, upstream, upstream_source, upstream_model, tps, router, recorded_at)
       VALUES ('old_1', 's1', 100, 50, 500, 1000, 1500, '{"route":"go"}', 'DeepInfra', 'header:x-served-by', 'deepinfra/x', 300, 'orcarouter-dsv4.1flash', 1500)`,
    ).run()
    for (const kind of ["execution", "step-failed", "model-selected", "usage-recorded", "compaction"]) {
      db.query("INSERT INTO events (session_id, kind, at) VALUES ('s1', $kind, 10)").run({ $kind: kind })
    }
    db.query("INSERT INTO http_responses (at, status, headers) VALUES (10, 200, '{\"server\":\"cloudflare\"}')").run()
    db.close()
  }

  test("an older database loses the columns, the table and the events no view reads", () => {
    const directory = mkdtempSync(join(tmpdir(), "usage-insights-legacy-"))
    const path = join(directory, "stats.db")
    try {
      legacyDb(path)
      const db = openStatsDb(path)

      const columns = (db.query("PRAGMA table_info(steps)").all() as { name: string }[]).map((column) => column.name)
      for (const gone of ["provider_state", "upstream", "upstream_source", "upstream_model", "tps"]) expect(columns).not.toContain(gone)
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name)
      expect(tables).not.toContain("http_responses")

      // The step survives with everything the views read, endpoint included.
      const row = db.query("SELECT message_id, output_tokens, router FROM steps").get() as Record<string, unknown>
      expect(row).toEqual({ message_id: "old_1", output_tokens: 100, router: "orcarouter-dsv4.1flash" })

      // Only the compaction event is kept: it is the one the cache view reads.
      const kinds = (db.query("SELECT kind FROM events").all() as { kind: string }[]).map((event) => event.kind)
      expect(kinds).toEqual(["compaction"])

      const version = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value
      expect(version).toBe(String(SCHEMA_VERSION))
      db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keeps the timing a rate is derived from, without storing the rate", () => {
    const db = freshDb()
    recordStep(db, { messageID: "t1", sessionID: "s1", output: 300, reasoning: 100, streamedAt: 2_000, completedAt: 3_000 })
    const row = db.query("SELECT output_tokens, reasoning_tokens, streamed_at, completed_at FROM steps WHERE message_id = 't1'").get()
    expect(row).toEqual({ output_tokens: 300, reasoning_tokens: 100, streamed_at: 2_000, completed_at: 3_000 })
    // The rate is derived where it is shown, from the window above.
    const cached = db.query("SELECT streamed_at, completed_at FROM steps WHERE message_id = 't1'").get() as { streamed_at: number; completed_at: number }
    expect(((300 + 100) / (cached.completed_at - cached.streamed_at)) * 1000).toBe(400)
    db.close()
  })
})

