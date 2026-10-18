import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SCHEMA_VERSION,
  importNdjson,
  openStatsDb,
  openStatsDbReadOnly,
  openStatsDbWrite,
  recordEvent,
  recordStep,
  setStepRouter,
  setStepRouterForSessionModel,
  upsertSession,
} from "../src/stats/db"

const POSIX = process.platform !== "win32"
const MIN = 60_000
const BASE = 1_800_000_000_000

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `usage-insights-${name}-`))
}

describe("schema", () => {
  test("carries an index for the time expression every range filter uses", () => {
    const db = openStatsDb(":memory:")
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining(["steps_at", "steps_session_at"]))
    db.close()
  })

  test("the range filters and the session ordering use them", () => {
    const db = openStatsDb(":memory:")
    const plan = (sql: string) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail).join(" | ")
    const at = `COALESCE(created_at, recorded_at)`
    expect(plan(`SELECT COUNT(*) FROM steps WHERE ${at} >= 0`)).toContain("steps_at")
    expect(plan(`SELECT message_id FROM steps WHERE session_id = 's' ORDER BY ${at}`)).toContain("steps_session_at")
    expect(plan(`SELECT message_id FROM steps WHERE session_id = 's' AND ${at} < 0 ORDER BY ${at} DESC LIMIT 1`)).toContain("steps_session_at")
    db.close()
  })

  test("folds endpoint spellings recorded before the rule into lowercase", () => {
    const directory = tempDir("router-case")
    const path = join(directory, "stats.db")
    try {
      // A database from before the normalization: version 6, mixed-case router.
      const first = openStatsDb(path)
      recordStep(first, { messageID: "s1", sessionID: "ses", modelID: "m", router: "orcarouter-dsv4.1flash", recordedAt: BASE })
      first.query("UPDATE steps SET router = 'OrcaRouter-DSV4.1Flash' WHERE message_id = 's1'").run()
      first.query("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run()
      first.close()

      const second = openStatsDb(path)
      const row = second.query("SELECT router FROM steps WHERE message_id = 's1'").get() as { router: string }
      expect(row.router).toBe("orcarouter-dsv4.1flash")
      const version = (second.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value
      expect(version).toBe(String(SCHEMA_VERSION))
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("opening modes", () => {
  test("the reader never creates the file", () => {
    const directory = tempDir("readonly-missing")
    const path = join(directory, "stats.db")
    try {
      expect(() => openStatsDbReadOnly(path)).toThrow()
      expect(() => statSync(path)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("the reader refuses a database that is not a stats database", () => {
    const directory = tempDir("readonly-foreign")
    const path = join(directory, "other.db")
    try {
      const other = new Database(path, { create: true })
      other.exec("CREATE TABLE things (id INTEGER)")
      other.close()
      expect(() => openStatsDbReadOnly(path)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("the reader reads what the recorder wrote, without writing anything", () => {
    const directory = tempDir("readonly")
    const path = join(directory, "stats.db")
    try {
      const writer = openStatsDb(path)
      recordStep(writer, { messageID: "r1", sessionID: "ses", modelID: "m", input: 10, recordedAt: BASE })
      writer.close()

      const reader = openStatsDbReadOnly(path)
      expect((reader.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }).n).toBe(1)
      // Read-only at the file level: a statement that writes cannot run.
      expect(() => reader.query("INSERT INTO events (session_id, kind) VALUES ('ses', 'x')").run()).toThrow()
      reader.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("the maintenance connection fails fast and does not build the schema", () => {
    const directory = tempDir("write")
    const path = join(directory, "stats.db")
    try {
      const handle = openStatsDbWrite(path)
      expect((handle.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(250)
      const tables = (handle.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name)
      expect(tables).not.toContain("steps")
      handle.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("writes take the lock with a short wait, not five seconds", () => {
    const directory = tempDir("busy")
    const path = join(directory, "stats.db")
    try {
      const writer = openStatsDb(path)
      const blocker = openStatsDb(path)
      blocker.exec("BEGIN IMMEDIATE")
      const maintenance = openStatsDbWrite(path)
      const started = Bun.nanoseconds()
      expect(() => maintenance.exec("VACUUM")).toThrow()
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6
      expect(elapsedMs).toBeLessThan(1_000)
      maintenance.close()
      blocker.exec("ROLLBACK")
      blocker.close()
      writer.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(!POSIX)("the database and its directory are private to the user", () => {
    const directory = tempDir("permissions")
    const path = join(directory, "stats", "stats.db")
    try {
      const db = openStatsDb(path)
      recordStep(db, { messageID: "p1", sessionID: "ses", recordedAt: BASE })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(directory, "stats")).mode & 0o777).toBe(0o700)
      db.close()
      // A database left readable by a previous version is tightened on open.
      chmodSync(path, 0o644)
      const again = openStatsDb(path)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      again.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("writing", () => {
  test("sanitizes what a session or a model wrote", () => {
    const db = openStatsDb(":memory:")
    upsertSession(db, { sessionID: "ses", title: "pwn\u001b]0;x\u0007ed", directory: "/tmp/\u001b[31mred", startedAt: BASE })
    recordStep(db, { messageID: "w1", sessionID: "ses", providerID: "p", modelID: "m", finish: "sto\u0007p", recordedAt: BASE })
    const session = db.query("SELECT title, directory FROM sessions WHERE session_id = 'ses'").get() as { title: string; directory: string }
    expect(session.title).toBe("pwn]0;xed")
    expect(session.directory).toBe("/tmp/[31mred")
    const step = db.query("SELECT finish FROM steps WHERE message_id = 'w1'").get() as { finish: string }
    expect(step.finish).toBe("stop")
    db.close()
  })

  test("stores the endpoint as a validated, lowercase token", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "w2", sessionID: "ses", router: "  GW-1  ", recordedAt: BASE })
    recordStep(db, { messageID: "w3", sessionID: "ses", router: "gw\u001b[31m", recordedAt: BASE })
    const rows = db.query("SELECT message_id, router FROM steps ORDER BY message_id").all() as { message_id: string; router: string | null }[]
    // A value that is not an endpoint id is not stored as one.
    expect(rows).toEqual([
      { message_id: "w2", router: "gw-1" },
      { message_id: "w3", router: null },
    ])
    db.close()
  })

  test("a repeat of the same endpoint costs no write", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "n1", sessionID: "ses", modelID: "m", input: 1, recordedAt: BASE })
    expect(setStepRouterForSessionModel(db, "ses", "m", { router: "gw-1" })).toBe(1)
    // The same observation again: the database already agrees.
    expect(setStepRouterForSessionModel(db, "ses", "m", { router: "gw-1" })).toBe(0)
    setStepRouter(db, "n1", { router: "gw-1" })
    setStepRouter(db, "n1", { router: "Gw-1" })
    const row = db.query("SELECT router FROM steps WHERE message_id = 'n1'").get() as { router: string }
    expect(row.router).toBe("gw-1")
    db.close()
  })

  test("an event kind is a short label", () => {
    const db = openStatsDb(":memory:")
    recordEvent(db, { sessionID: "ses", kind: "compaction\u001b[2J", at: BASE })
    const row = db.query("SELECT kind FROM events").get() as { kind: string }
    expect(row.kind).toBe("compaction[2J")
    db.close()
  })
})

describe("importNdjson", () => {
  function target(): Database {
    return openStatsDb(":memory:")
  }

  test("forces every value into the shape of its column", () => {
    const db = target()
    const lines = [
      JSON.stringify({ table: "sessions", row: { session_id: "imp", title: "a\u001b]0;x\u0007b", started_at: "123", updated_at: null } }),
      JSON.stringify({ table: "steps", row: { message_id: "imp1", session_id: "imp", input_tokens: "42", cost: "not a number", recorded_at: "1000" } }),
    ]
    expect(importNdjson(db, lines.join("\n"))).toBe(2)
    const session = db.query("SELECT title, started_at, updated_at FROM sessions WHERE session_id = 'imp'").get() as {
      title: string
      started_at: number
      updated_at: null
    }
    expect(session).toEqual({ title: "a]0;xb", started_at: 123, updated_at: null })
    const step = db.query("SELECT input_tokens, cost, recorded_at FROM steps WHERE message_id = 'imp1'").get() as {
      input_tokens: number
      cost: number
      recorded_at: number
    }
    expect(step).toEqual({ input_tokens: 42, cost: 0, recorded_at: 1000 })
    db.close()
  })

  test("drops a row that cannot fill a required column, and keeps the rest", () => {
    const db = target()
    const lines = [
      JSON.stringify({ table: "steps", row: { session_id: "imp", recorded_at: BASE } }),
      JSON.stringify({ table: "steps", row: { message_id: "imp2", session_id: "imp", recorded_at: BASE } }),
      JSON.stringify({ table: "sessions", row: { title: "no id" } }),
      JSON.stringify({ table: "meta", row: { key: "x", value: "y" } }),
      JSON.stringify({ table: "steps", row: "not an object" }),
      "not json at all",
      "",
    ]
    expect(importNdjson(db, lines.join("\n"))).toBe(1)
    const ids = (db.query("SELECT message_id FROM steps").all() as { message_id: string }[]).map((row) => row.message_id)
    expect(ids).toEqual(["imp2"])
    db.close()
  })

  test("caps what a hostile dump can store", () => {
    const db = target()
    const huge = "x".repeat(50_000)
    importNdjson(db, JSON.stringify({ table: "sessions", row: { session_id: "imp", title: huge } }))
    const row = db.query("SELECT title FROM sessions WHERE session_id = 'imp'").get() as { title: string }
    expect(row.title.length).toBeLessThan(5_000)
    db.close()
  })

  test("round-trips what the recorder wrote", () => {
    const db = target()
    upsertSession(db, { sessionID: "ses", title: "One", directory: "/tmp/ses", startedAt: BASE })
    recordStep(db, { messageID: "rt1", sessionID: "ses", modelID: "m", input: 10, output: 2, cost: 0.5, createdAt: BASE, recordedAt: BASE })
    const dump = `{"table":"sessions","row":{"session_id":"ses","title":"One","directory":"/tmp/ses","started_at":${BASE},"updated_at":${BASE}}}\n{"table":"steps","row":{"message_id":"rt1","session_id":"ses","model_id":"m","input_tokens":10,"output_tokens":2,"cost":0.5,"created_at":${BASE},"recorded_at":${BASE},"router":null}}`
    const fresh = target()
    expect(importNdjson(fresh, dump)).toBe(2)
    const steps = fresh.query("SELECT message_id, input_tokens, cost FROM steps").all()
    expect(steps).toEqual([{ message_id: "rt1", input_tokens: 10, cost: 0.5 }])
    db.close()
    fresh.close()
  })
})
