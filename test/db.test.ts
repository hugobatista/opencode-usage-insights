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
  recordUsage,
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

  test("drops the router column and its index from a database that carries them", () => {
    const directory = tempDir("router-drop")
    const path = join(directory, "usage.db")
    try {
      // A database from before the endpoint identity was removed: schema 8, a
      // router column, its index, and a value in it.
      const first = openStatsDb(path)
      recordStep(first, { messageID: "s1", sessionID: "ses", providerID: "opencode", modelID: "m", recordedAt: BASE })
      first.exec("ALTER TABLE steps ADD COLUMN router TEXT")
      first.exec("CREATE INDEX steps_router ON steps(router)")
      first.query("UPDATE steps SET router = 'orcarouter-dsv4.1flash' WHERE message_id = 's1'").run()
      first.query("UPDATE meta SET value = '8' WHERE key = 'schema_version'").run()
      first.close()

      const second = openStatsDb(path)
      const columns = (second.query("PRAGMA table_info(steps)").all() as { name: string }[]).map((column) => column.name)
      expect(columns).not.toContain("router")
      const indexes = (second.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((row) => row.name)
      expect(indexes).not.toContain("steps_router")
      // What a view reads — the provider and the model — survives the drop.
      const row = second.query("SELECT provider_id, model_id FROM steps WHERE message_id = 's1'").get() as { provider_id: string; model_id: string }
      expect(row.provider_id).toBe("opencode")
      expect(row.model_id).toBe("m")
      const version = (second.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value
      expect(version).toBe(String(SCHEMA_VERSION))
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("list-price migration", () => {
  test("adds list_cost to a database created before it existed", () => {
    const directory = tempDir("list-cost-migration")
    const path = join(directory, "usage.db")
    try {
      const first = openStatsDb(path)
      recordStep(first, { messageID: "old", sessionID: "ses", cost: 0, recordedAt: BASE })
      // Shape the file like schema 9: no list_cost, and the old version stamp.
      first.exec("ALTER TABLE steps DROP COLUMN list_cost")
      first.query("UPDATE meta SET value = '9' WHERE key = 'schema_version'").run()
      first.close()

      const second = openStatsDb(path)
      const columns = (second.query("PRAGMA table_info(steps)").all() as { name: string }[]).map((column) => column.name)
      expect(columns).toContain("list_cost")
      expect((second.query("SELECT list_cost FROM steps WHERE message_id = 'old'").get() as { list_cost: null }).list_cost).toBeNull()
      expect((second.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe(String(SCHEMA_VERSION))
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("opening modes", () => {
  test("the reader never creates the file", () => {
    const directory = tempDir("readonly-missing")
    const path = join(directory, "usage.db")
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
    const path = join(directory, "usage.db")
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
    const path = join(directory, "usage.db")
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

  test("writes refuse a locked database instead of waiting the lock out", () => {
    const directory = tempDir("busy")
    const path = join(directory, "usage.db")
    try {
      const writer = openStatsDb(path)
      const blocker = openStatsDb(path)
      blocker.exec("BEGIN IMMEDIATE")
      const maintenance = openStatsDbWrite(path)
      // The 250 ms busy timeout asserted above is what makes the refusal
      // quick. The wall clock is not asserted: a shared CI machine stretches
      // any millisecond budget without the connection misbehaving.
      let refused = false
      try {
        maintenance.exec("VACUUM")
      } catch (error) {
        refused = (error as { code?: string }).code === "SQLITE_BUSY"
      }
      expect(refused).toBe(true)
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
    const path = join(directory, "opencode-usage-insights", "usage.db")
    try {
      const db = openStatsDb(path)
      recordStep(db, { messageID: "p1", sessionID: "ses", recordedAt: BASE })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(directory, "opencode-usage-insights")).mode & 0o777).toBe(0o700)
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

  test("stores the provider as a token and drops what is not one", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "w2", sessionID: "ses", providerID: "opencode-go", recordedAt: BASE })
    recordStep(db, { messageID: "w3", sessionID: "ses", providerID: "not a provider", recordedAt: BASE })
    recordStep(db, { messageID: "w4", sessionID: "ses", providerID: "DeepSeek", recordedAt: BASE })
    const rows = db.query("SELECT message_id, provider_id FROM steps ORDER BY message_id").all() as { message_id: string; provider_id: string | null }[]
    // A value that is not a provider id is not stored as one; case is kept, so
    // the provider reads the way it is configured.
    expect(rows).toEqual([
      { message_id: "w2", provider_id: "opencode-go" },
      { message_id: "w3", provider_id: null },
      { message_id: "w4", provider_id: "DeepSeek" },
    ])
    db.close()
  })

  test("stores an estimate only for a step that was not charged", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "e1", sessionID: "ses", cost: 0, listCost: 0.0042, recordedAt: BASE })
    recordStep(db, { messageID: "e2", sessionID: "ses", cost: 0.02, listCost: 0.0042, recordedAt: BASE })
    recordStep(db, { messageID: "e3", sessionID: "ses", cost: 0, listCost: 0, recordedAt: BASE })
    const rows = db.query("SELECT message_id, cost, list_cost FROM steps ORDER BY message_id").all()
    expect(rows).toEqual([
      { message_id: "e1", cost: 0, list_cost: 0.0042 },
      { message_id: "e2", cost: 0.02, list_cost: null },
      { message_id: "e3", cost: 0, list_cost: 0 },
    ])
    db.close()
  })

  test("keeps an estimate when a replay omits it, and drops it when the step becomes charged", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "r1", sessionID: "ses", cost: 0, listCost: 0.1, recordedAt: BASE })
    // A replay without a price table does not erase the estimate.
    recordStep(db, { messageID: "r1", sessionID: "ses", cost: 0, recordedAt: BASE })
    expect((db.query("SELECT list_cost FROM steps WHERE message_id = 'r1'").get() as { list_cost: number }).list_cost).toBe(0.1)
    // The step is later reported as charged: the estimate no longer applies.
    recordStep(db, { messageID: "r1", sessionID: "ses", cost: 0.2, recordedAt: BASE })
    expect((db.query("SELECT list_cost FROM steps WHERE message_id = 'r1'").get() as { list_cost: null }).list_cost).toBeNull()
    db.close()
  })

  test("an event kind is a short label", () => {
    const db = openStatsDb(":memory:")
    recordEvent(db, { sessionID: "ses", kind: "compaction\u001b[2J", at: BASE })
    const row = db.query("SELECT kind FROM events").get() as { kind: string }
    expect(row.kind).toBe("compaction[2J")
    db.close()
  })

  test("keeps a step whose numbers are not finite", () => {
    const db = openStatsDb(":memory:")
    // A NaN bound to a NOT NULL column would make SQLite reject the whole row;
    // the recorder would swallow the error and lose the step's tokens, model
    // and timing with it. The values are sanitized, not the row dropped.
    recordStep(db, {
      messageID: "n1",
      sessionID: "ses",
      cost: Number.NaN,
      input: Number.NaN,
      output: -5,
      cacheRead: Number.POSITIVE_INFINITY,
      createdAt: Number.NaN,
      recordedAt: BASE,
    })
    expect(db.query("SELECT cost, input_tokens, output_tokens, cache_read, created_at FROM steps WHERE message_id = 'n1'").get()).toEqual({
      cost: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read: 0,
      created_at: null,
    })
    db.close()
  })

  test("records non-step usage once per host event", () => {
    const db = openStatsDb(":memory:")
    recordUsage(db, { id: "u1", sessionID: "ses", source: "compaction", at: BASE, cost: 0.02, input: 10, output: 2 })
    // A replay carries the same host event ID: it must not add a second row.
    recordUsage(db, { id: "u1", sessionID: "ses", source: "compaction", at: BASE, cost: 0.02, input: 10, output: 2 })
    recordUsage(db, { id: "u2", sessionID: "ses", source: "title", at: BASE + 1, cost: 0.01 })
    expect(db.query("SELECT id, source, cost FROM usage ORDER BY id").all()).toEqual([
      { id: "u1", source: "compaction", cost: 0.02 },
      { id: "u2", source: "title", cost: 0.01 },
    ])
    db.close()
  })

  test("ignores a replayed event with the same host ID", () => {
    const db = openStatsDb(":memory:")
    recordEvent(db, { sessionID: "ses", kind: "compaction", messageID: "ev1", at: BASE })
    recordEvent(db, { sessionID: "ses", kind: "compaction", messageID: "ev1", at: BASE })
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 })
    db.close()
  })
})

describe("event migration", () => {
  test("keeps one copy of a compaction an older recorder stored on every replay", () => {
    const directory = tempDir("event-dedupe")
    const path = join(directory, "usage.db")
    try {
      const first = openStatsDb(path)
      // Older recorders had no event ID and inserted a row on every delivery.
      for (let index = 0; index < 3; index += 1) {
        first
          .query("INSERT INTO events (session_id, kind, at, data) VALUES ('ses', 'compaction', ?, ?)")
          .run(BASE, '{"reason":"auto","cost":0.02,"tokens":{"input":10,"output":2}}')
      }
      // A row written by this version already has its `usage` record: the
      // migration must not backfill it a second time.
      first
        .query("INSERT INTO events (session_id, kind, message_id, at, data) VALUES ('ses', 'compaction', 'new', ?, ?)")
        .run(BASE + 1, '{"reason":"auto","cost":0.05,"tokens":{"input":20,"output":4}}')
      // A malformed payload must not make the migration (and plugin startup)
      // fail: the recovery skips it, the event itself is kept.
      first.query("INSERT INTO events (session_id, kind, at, data) VALUES ('ses', 'compaction', ?, 'not json')").run(BASE + 2)
      first.close()
      const second = openStatsDb(path)
      expect(second.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 3 })
      const indexes = (second.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((row) => row.name)
      expect(indexes).toContain("events_kind_message")
      // The old compaction payload carried its cost and tokens: the migration
      // recovers them for the totals instead of leaving them in the event only.
      // The row that already has a host ID is not recovered again.
      expect(second.query("SELECT source, cost, input_tokens, output_tokens FROM usage").all()).toEqual([
        { source: "compaction", cost: 0.02, input_tokens: 10, output_tokens: 2 },
      ])
      // Reopening is idempotent: the synthetic ID is stable.
      second.close()
      const third = openStatsDb(path)
      expect(third.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 1 })
      third.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

  test("enforces the charged/estimated invariant and non-negative counters", () => {
    const db = target()
    const dump = [
      JSON.stringify({ table: "steps", row: { message_id: "i1", session_id: "imp", cost: 0.5, list_cost: 9, input_tokens: -3, recorded_at: BASE } }),
      JSON.stringify({ table: "usage", row: { id: "u1", session_id: "imp", source: "compaction", at: BASE, cost: -1, input_tokens: -2 } }),
    ].join("\n")
    expect(importNdjson(db, dump)).toBe(2)
    expect(db.query("SELECT cost, list_cost, input_tokens FROM steps WHERE message_id = 'i1'").get()).toEqual({
      cost: 0.5,
      list_cost: null,
      input_tokens: 0,
    })
    expect(db.query("SELECT cost, input_tokens FROM usage WHERE id = 'u1'").get()).toEqual({ cost: 0, input_tokens: 0 })
    db.close()
  })

  test("round-trips what the recorder wrote", () => {
    const db = target()
    upsertSession(db, { sessionID: "ses", title: "One", directory: "/tmp/ses", startedAt: BASE })
    recordStep(db, { messageID: "rt1", sessionID: "ses", providerID: "opencode-go", modelID: "m", input: 10, output: 2, cost: 0, listCost: 0.0042, createdAt: BASE, recordedAt: BASE })
    const dump = `{"table":"sessions","row":{"session_id":"ses","title":"One","directory":"/tmp/ses","started_at":${BASE},"updated_at":${BASE}}}\n{"table":"steps","row":{"message_id":"rt1","session_id":"ses","provider_id":"opencode-go","model_id":"m","input_tokens":10,"output_tokens":2,"cost":0,"list_cost":0.0042,"created_at":${BASE},"recorded_at":${BASE}}}`
    const fresh = target()
    expect(importNdjson(fresh, dump)).toBe(2)
    // A dump written before the endpoint was dropped still imports: the row's
    // own columns are the ones the table has, and an unknown one is ignored.
    const older = `{"table":"steps","row":{"message_id":"old1","session_id":"ses","router":"gw-1","model_id":"m","recorded_at":${BASE}}}`
    expect(importNdjson(fresh, older)).toBe(1)
    const steps = fresh.query("SELECT message_id, provider_id, input_tokens, cost, list_cost FROM steps ORDER BY message_id").all()
    expect(steps).toEqual([
      { message_id: "old1", provider_id: null, input_tokens: 0, cost: 0, list_cost: null },
      { message_id: "rt1", provider_id: "opencode-go", input_tokens: 10, cost: 0, list_cost: 0.0042 },
    ])
    db.close()
    fresh.close()
  })
})
