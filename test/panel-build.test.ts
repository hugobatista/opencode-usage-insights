import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { buildPanel, defaultSort, detailLabel, nextSort, sortKeys, type PanelRequest } from "../src/panel-build"
import { PANEL_VIEWS, sanitizeSettings, type PanelLine, type PanelView } from "../src/panel-data"
import { openStatsDb, recordPrompt, recordStep, upsertSession } from "../src/stats/db"
import { dbInfo, type DbInfo } from "../src/stats/maintenance"

/**
 * Every view, built from a seeded in-memory database. The panel component only
 * paints these lines, so these assertions are the panel's contract — and the
 * CLI report prints the very same ones.
 */

const BASE = 1_800_000_000_000
const MIN = 60_000

function seed(): Database {
  const db = openStatsDb(":memory:")
  upsertSession(db, { sessionID: "s1", title: "Main session", directory: "/code/app", startedAt: BASE })
  upsertSession(db, { sessionID: "s2", parentID: "s1", title: "Subagent", directory: "/code/app", startedAt: BASE + MIN })
  upsertSession(db, { sessionID: "s3", title: "Docs pass", directory: "/code/docs", startedAt: BASE + 2 * MIN })

  const steps = [
    { messageID: "m1", sessionID: "s1", providerID: "opencode", modelID: "model-a", createdAt: BASE, streamedAt: BASE + 1_000, completedAt: BASE + 30_000, input: 1_000, cacheRead: 100_000, cacheWrite: 500, output: 300, cost: 0.10, router: "router-1", finish: "stop" },
    { messageID: "m2", sessionID: "s1", providerID: "opencode", modelID: "model-a", createdAt: BASE + 5 * MIN, streamedAt: BASE + 5 * MIN + 1_000, completedAt: BASE + 5 * MIN + 20_000, input: 1_200, cacheRead: 90_000, output: 200, cost: 0.08, router: "router-2", finish: "stop" },
    { messageID: "m3", sessionID: "s1", providerID: "anthropic", modelID: "model-b", createdAt: BASE + 40 * MIN, streamedAt: BASE + 40 * MIN + 2_000, completedAt: BASE + 41 * MIN, input: 12_000, cacheRead: 0, cacheWrite: 9_000, output: 900, reasoning: 400, cost: 1.20, router: "router-3", finish: "stop" },
    { messageID: "m4", sessionID: "s2", providerID: "opencode", modelID: "model-a", createdAt: BASE + 2 * MIN, streamedAt: BASE + 2 * MIN + 800, completedAt: BASE + 2 * MIN + 8_000, input: 500, cacheRead: 40_000, output: 100, cost: 0.02, router: "router-1", finish: "stop" },
    { messageID: "m5", sessionID: "s3", providerID: "opencode", modelID: "model-a", createdAt: BASE + 70 * MIN, streamedAt: BASE + 70 * MIN + 900, completedAt: BASE + 70 * MIN + 15_000, input: 800, cacheRead: 60_000, cacheWrite: 200, output: 250, cost: 0.05, router: "router-1", finish: "stop" },
  ]
  for (const step of steps) recordStep(db, step as never)
  recordPrompt(db, { sessionID: "s1", messageID: "p1", createdAt: BASE - 1_000 })
  recordPrompt(db, { sessionID: "s1", messageID: "p2", createdAt: BASE + 5 * MIN - 1_000 })
  recordStep(db, {
    messageID: "m6",
    sessionID: "s1",
    providerID: "opencode",
    modelID: "model-a",
    createdAt: BASE + 80 * MIN,
    streamedAt: BASE + 80 * MIN + 1_000,
    completedAt: BASE + 80 * MIN + 10_000,
    input: 700,
    cacheRead: 61_000,
    output: 120,
    cost: 0.04,
    router: "router-1",
    finish: "tool-calls",
  })
  return db
}

function request(db: Database, overrides: Partial<PanelRequest> = {}): PanelRequest {
  return {
    db,
    view: "overview",
    range: "all",
    filters: {},
    granularity: "day",
    turnsScope: "session",
    sort: "",
    sortDesc: true,
    sessionID: "s1",
    sessionStart: BASE,
    now: BASE + 90 * MIN,
    width: 120,
    ...overrides,
  }
}

const text = (lines: readonly PanelLine[]): string => lines.map((line) => line.text).join("\n")

/** The db view's payload, as the panel assembles it. */
const dbInfoOf = (db: Database): DbInfo => dbInfo(db, ":memory:", BASE + 90 * MIN)
const find = (lines: readonly PanelLine[], needle: string): PanelLine | undefined => lines.find((line) => line.text.includes(needle))

describe("buildPanel", () => {
  test("overview: totals, this session and the data coverage", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "overview" }))
    expect(lines[0]!.text).toContain("all time")
    expect(lines[0]!.text).toContain("6 steps")
    expect(text(lines)).toContain("this session")
    expect(text(lines)).toContain("data coverage")
    expect(text(lines)).toContain("endpoints")
    expect(find(lines, "activity")).toBeDefined()
    db.close()
  })

  test("this session is that session, not every session recorded since it started", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "overview", sessionID: "s1", sessionStart: BASE }))
    const body = text(lines)
    const block = body.slice(body.indexOf("this session"))
    // s1 alone: m1, m2, m3 and the unfinished m6 — 4 steps, 24.4k uncached
    // (14.9k fresh + 9.5k written) and a 275.4k prompt.
    expect(block).toContain("in         24.4k")
    expect(block).toContain("prompt     275.4k")
    // The sibling that started later (s3) is only in the all-time block above.
    expect(body.slice(0, body.indexOf("this session"))).toContain("in         25.9k")
    expect(block).toContain("subagents")
    expect(block).toContain("their own sessions")
    db.close()
  })

  test("the session range covers the session, not the window after it started", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "overview", range: "session", sessionID: "s1", sessionStart: BASE }))
    expect(lines[0]!.text).toBe("this session · 4 steps · 1 session · 2 prompts")
    db.close()
  })

  test("the session scope is ignored when there is no session to scope to", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "overview", range: "session", sessionID: "", sessionStart: undefined }))
    expect(lines[0]!.text).toContain("6 steps")
    db.close()
  })

  test("models: one row per model, with the cache and where it was served, and a cursor", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "models" }))
    const rows = lines.filter((line) => line.row?.kind === "model")
    expect(rows.map((line) => line.row!.value).sort()).toEqual(["model-a", "model-b"])
    const modelA = rows.find((line) => line.row!.value === "model-a")!
    expect(modelA.text).toContain("model-a")
    expect(modelA.text).toContain("router-1, router-2")
    expect(text(lines)).not.toContain("via Fireworks")
    expect(text(lines)).toContain("1 identity change")
    db.close()
  })

  test("endpoints: one row per endpoint, with the models it served", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "endpoints" }))
    expect(lines[0]!.text).toContain("endpoint")
    expect(lines[0]!.text).toContain("models")
    expect(text(lines)).toContain("router-1")
    expect(text(lines)).toContain("router-3")
    // The reported operator and the configured provider are not surfaced.
    expect(text(lines)).not.toContain("AWS Bedrock")
    expect(text(lines)).not.toContain("anthropic")
    expect(lines.filter((line) => line.row?.kind === "endpoint").length).toBeGreaterThan(0)
    db.close()
  })

  test("affinity: counts the changes per model and names the transitions", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "affinity" }))
    expect(lines[0]!.tone).toBe("warning")
    expect(lines[0]!.text).toContain("identity change")
    expect(text(lines)).toContain("endpoint")
    expect(text(lines)).toContain("top transitions")
    expect(text(lines)).toContain("router-1 → router-2")
    db.close()
  })

  test("cache: losses by reason, reuse by model, survival against idle time and the TTL bounds", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "cache" }))
    expect(text(lines)).toContain("reuse losses")
    expect(text(lines)).toContain("reuse by model")
    expect(text(lines)).toContain("cache survival against idle time")
    expect(text(lines)).toContain("observed cache TTL bounds")
    expect(text(lines)).toContain("gap")
    db.close()
  })

  test("periods: bucket label, totals row and the granularity switch", () => {
    const db = seed()
    const days = buildPanel(request(db, { view: "periods", granularity: "day" }))
    expect(days[0]!.text).toContain("per day")
    expect(text(days)).toContain("total")
    expect(days.filter((line) => line.row?.kind === "period").length).toBe(1)
    const months = buildPanel(request(db, { view: "periods", granularity: "month" }))
    expect(months[0]!.text).toContain("per month")
    expect(text(months)).toContain("steps")
    db.close()
  })

  test("latency: overall percentiles and a breakdown by the group that matters", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "latency" }))
    expect(text(lines)).toContain("throughput")
    expect(text(lines)).toContain("by group")
    expect(text(lines)).toContain("model-a")
    const scoped = buildPanel(request(db, { view: "latency", filters: { modelID: "model-b" } }))
    expect(text(scoped)).not.toContain("model-a")
    db.close()
  })

  test("sessions: one row per session, subagents indented and rolled up", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "sessions" }))
    expect(text(lines)).toContain("Main session")
    expect(text(lines)).toContain("↳ Subagent")
    expect(text(lines)).toContain("subagents")
    expect(text(lines)).toContain("hit")
    db.close()
  })

  test("turns: the open session by default, every session when asked", () => {
    const db = seed()
    const session = buildPanel(request(db, { view: "turns" }))
    expect(session[0]!.text).toContain("turn")
    expect(text(session)).not.toContain("Docs pass")
    const all = buildPanel(request(db, { view: "turns", turnsScope: "all" }))
    expect(text(all)).toContain("Docs pass")
    db.close()
  })

  test("keeps the panel's own chrome out of the view builders", () => {
    // The header, the view tabs, the key hints and the help overlay belong to
    // the component; the builders only produce the view itself.
    const db = seed()
    const lines = buildPanel(request(db, { view: "overview" }))
    expect(text(lines)).not.toContain("usage insights")
    expect(text(lines)).not.toContain("? help")
    db.close()
  })
})

describe("filters and detail", () => {
  test("a model filter narrows every view", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "models", filters: { modelID: "model-b" } }))
    const rows = lines.filter((line) => line.row?.kind === "model")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.row!.value).toBe("model-b")
    db.close()
  })

  test("an endpoint filter narrows every view", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "models", filters: { router: "router-1" } }))
    // Only model-a was served through router-1: model-b came through router-3.
    const rows = lines.filter((line) => line.row?.kind === "model")
    expect(rows.map((line) => line.row!.value)).toEqual(["model-a"])
    db.close()
  })

  test("an endpoint filter narrows the endpoint rows", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "endpoints", filters: { router: "router-3" } }))
    expect(text(lines)).toContain("router-3")
    expect(text(lines)).not.toContain("router-1")
    db.close()
  })

  test("drilling into a model shows its providers and its affinity", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "models", detail: { kind: "model", value: "model-a" } }))
    expect(lines[0]!.text).toBe("model model-a")
    expect(text(lines)).toContain("hit")
    expect(text(lines)).toContain("router-1")
    expect(text(lines)).toContain("backspace")
    db.close()
  })

  test("drilling into an endpoint shows its models and its latency", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "endpoints", detail: { kind: "endpoint", value: "router-1" } }))
    expect(lines[0]!.text).toBe("endpoint router-1")
    expect(text(lines)).toContain("model-a")
    expect(text(lines)).toContain("by group")
    db.close()
  })

  test("drilling into a period lists the models that were active", () => {
    const db = seed()
    const days = buildPanel(request(db, { view: "periods" }))
    const key = days.find((line) => line.row?.kind === "period")!.row!.value
    const lines = buildPanel(request(db, { view: "periods", detail: { kind: "period", value: key } }))
    expect(lines[0]!.text).toBe(`period ${key}`)
    expect(text(lines)).toContain("router-1")
    expect(text(lines)).toContain("models")
    db.close()
  })

  test("drilling into a session lists its turns", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "sessions", detail: { kind: "session", value: "s3" } }))
    expect(lines[0]!.text).toBe("session s3")
    expect(text(lines)).toContain("newest first")
    db.close()
  })
})

describe("the db view", () => {
  test("shows where the file lives, what it holds and what each prune would remove", () => {
    const db = seed()
    const lines = buildPanel(
      request(db, {
        view: "db",
        database: dbInfoOf(db),
      }),
    )
    const body = text(lines)
    expect(body).toContain("steps")
    expect(body).toContain("schema v")
    expect(body).toContain("clean up")
    expect(lines.filter((line) => line.row?.kind === "prune").length).toBe(3)
    expect(body).toContain("365 days")
    db.close()
  })

  test("without the file behind it, the view says so instead of inventing one", () => {
    const db = seed()
    const lines = buildPanel(request(db, { view: "db" }))
    expect(lines[0]!.tone).toBe("warning")
    expect(text(lines)).toContain("unavailable")
    db.close()
  })
})

describe("view plumbing", () => {
  test("keeps the documented view order", () => {
    expect([...PANEL_VIEWS]).toEqual(["overview", "models", "endpoints", "affinity", "cache", "periods", "latency", "sessions", "turns", "db"])
  })

  test("cycles the sort keys of a view", () => {
    const keys = sortKeys("models")
    expect(keys[0]).toBe("steps")
    expect(nextSort("models", "steps", 1)).toBe("cached")
    expect(nextSort("models", keys[keys.length - 1]!, 1)).toBe("steps")
    expect(nextSort("overview", "steps", 1)).toBe("steps")
    expect(defaultSort("turns")).toBe("time")
  })

  test("labels a drill-down target", () => {
    expect(detailLabel({ kind: "model", value: "m", variant: "max" })).toBe("model m max")
    expect(detailLabel({ kind: "session", value: "s" })).toBe("session s")
    expect(detailLabel({ kind: "endpoint", value: "orcarouter" })).toBe("endpoint orcarouter")
  })

  test("never throws: an unreadable database becomes a line", () => {
    const db = seed()
    db.close()
    const lines = buildPanel(request(db, { view: "models" }))
    expect(lines[0]!.tone).toBe("warning")
    expect(lines[0]!.text).toContain("stats query failed")
  })

  test("sanitizes state that came from an older version", () => {
    const settings = sanitizeSettings({ view: "nope", range: "nope", granularity: "nope", turnsScope: "all", modelID: "m" } as never)
    expect(settings.view).toBe("overview")
    expect(settings.range).toBe("all")
    expect(settings.granularity).toBe("day")
    expect(settings.turnsScope).toBe("all")
    expect(settings.modelID).toBe("m")
  })
})

describe("what a view pays for", () => {
  /** The narrow step projection every analysis view reads. */
  const STEP_QUERY = "message_id AS messageID"
  /** The step before the range, loaded for the pair-based reports. */
  const BOUNDARY_QUERY = "ORDER BY COALESCE(created_at, recorded_at) DESC, message_id DESC LIMIT 1"
  /** What the file holds, read by `dbInfo` for the db view alone. */
  const DBINFO_QUERY = "FROM meta"

  /** The database, with every prepared statement remembered. */
  function watched(db: Database): { handle: Database; sql: string[] } {
    const sql: string[] = []
    const handle = new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === "query") {
          return (text: string) => {
            sql.push(text)
            return target.query(text)
          }
        }
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as Database
    return { handle, sql }
  }

  const count = (sql: readonly string[], marker: string) => sql.filter((text) => text.includes(marker)).length

  test("waits for the rows of one view at a time", () => {
    const db = seed()
    const { handle, sql } = watched(db)
    buildPanel(request(handle, { view: "models" }))
    // Two reads at most: the grouped query and the reuse per model.
    expect(count(sql, STEP_QUERY)).toBeLessThanOrEqual(2)
    db.close()
  })

  test("sessions, turns and db never read the steps themselves", () => {
    for (const view of ["sessions", "turns", "db"] as PanelView[]) {
      const db = seed()
      const { handle, sql } = watched(db)
      buildPanel(request(handle, { view, ...(view === "db" ? { database: dbInfoOf(db) } : {}) }))
      expect(count(sql, STEP_QUERY)).toBe(0)
      db.close()
    }
  })

  test("nothing asks SQLite for a window function", () => {
    const db = seed()
    const { handle, sql } = watched(db)
    for (const view of ["overview", "models", "endpoints", "affinity", "cache", "periods", "latency"] as PanelView[]) {
      buildPanel(request(handle, { view }))
    }
    // Percentiles and pair comparisons are folded in JS over narrow rows: a
    // window function here would cost more than the fold it replaces.
    expect(sql.filter((text) => text.includes("OVER (")).length).toBe(0)
    db.close()
  })

  test("only a ranged pair report loads the step before the range", () => {
    const db = seed()
    const { handle, sql } = watched(db)
    // All time has no boundary to look for.
    buildPanel(request(handle, { view: "cache" }))
    expect(count(sql, BOUNDARY_QUERY)).toBe(0)
    // A range that starts before the seeded steps, so the seek runs.
    buildPanel(request(handle, { view: "cache", range: "today", now: BASE + 10 * MIN }))
    expect(count(sql, BOUNDARY_QUERY)).toBeGreaterThan(0)
    db.close()
  })

  test("the file's own numbers are asked for by the db view, not by others", () => {
    const db = seed()
    const { handle, sql } = watched(db)
    buildPanel(request(handle, { view: "overview" }))
    expect(count(sql, DBINFO_QUERY)).toBe(0)
    // The panel passes the payload it assembled for the db view.
    expect(text(buildPanel(request(handle, { view: "db", database: dbInfoOf(db) })))).toContain("what it holds")
    db.close()
  })
})

describe("each view builds", () => {
  for (const view of PANEL_VIEWS) {
    test(`${view} renders something`, () => {
      const db = seed()
      const lines = buildPanel(request(db, { view: view as PanelView }))
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.some((line) => line.text.trim() !== "")).toBe(true)
      db.close()
    })
  }
})
