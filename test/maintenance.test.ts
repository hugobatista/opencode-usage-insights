import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStatsDb, recordEvent, recordPrompt, recordStep, upsertSession } from "../src/stats/db"
import { backfillListCost, dbInfo, pruneOlderThan, vacuum } from "../src/stats/maintenance"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function seed(): Database {
  const db = openStatsDb(":memory:")
  upsertSession(db, { sessionID: "s1", title: "Session one", startedAt: NOW - 200 * DAY })
  for (const [id, age] of [
    ["old_1", 200],
    ["old_2", 60],
    ["recent", 2],
  ] as const) {
    recordStep(db, { messageID: id, sessionID: "s1", providerID: "opencode", modelID: "m1", input: 100, cacheRead: 1_000, output: 10, createdAt: NOW - age * DAY, completedAt: NOW - age * DAY + 1_000 })
  }
  recordPrompt(db, { sessionID: "s1", messageID: "p_old", createdAt: NOW - 150 * DAY })
  recordPrompt(db, { sessionID: "s1", messageID: "p_new", createdAt: NOW - DAY })
  recordEvent(db, { sessionID: "s1", kind: "compaction", at: NOW - 120 * DAY })
  recordEvent(db, { sessionID: "s1", kind: "compaction", at: NOW - DAY })
  return db
}

describe("dbInfo", () => {
  test("reports the tables, the window and what a prune would remove", () => {
    const db = seed()
    const info = dbInfo(db, ":memory:", NOW)
    expect(info.tables.find((table) => table.name === "steps")!.rows).toBe(3)
    expect(info.tables.find((table) => table.name === "prompts")!.rows).toBe(2)
    expect(info.firstAt).toBe(NOW - 200 * DAY)
    expect(info.lastAt).toBe(NOW - 2 * DAY)
    expect(info.removable).toEqual([
      { days: 30, steps: 2 },
      { days: 90, steps: 1 },
      { days: 365, steps: 0 },
    ])
    expect(info.schemaVersion).toBeGreaterThan(0)
    // The seed records every step at $0 with no estimate.
    expect(info.unpriced).toBe(3)
    db.close()
  })

  test("reports the size of the file and its write-ahead log", () => {
    const directory = mkdtempSync(join(tmpdir(), "usage-insights-db-"))
    const path = join(directory, "usage.db")
    try {
      const db = openStatsDb(path)
      recordStep(db, { messageID: "a1", sessionID: "s1", input: 10, createdAt: NOW, completedAt: NOW + 1 })
      const info = dbInfo(db, path, NOW)
      expect(info.bytes).toBe(statSync(path).size)
      expect(info.bytes).toBeGreaterThan(0)
      db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("pruneOlderThan", () => {
  test("removes the steps, prompts and compactions older than the cutoff", () => {
    const db = seed()
    const result = pruneOlderThan(db, NOW - 30 * DAY)
    expect(result).toEqual({ steps: 2, prompts: 1, events: 1 })
    const steps = (db.query("SELECT message_id FROM steps").all() as { message_id: string }[]).map((row) => row.message_id)
    expect(steps).toEqual(["recent"])
    const prompts = (db.query("SELECT message_id FROM prompts").all() as { message_id: string }[]).map((row) => row.message_id)
    expect(prompts).toEqual(["p_new"])
    const events = (db.query("SELECT at FROM events").all() as { at: number }[]).map((row) => row.at)
    expect(events).toEqual([NOW - DAY])
    db.close()
  })

  test("removes more rows than one batch, in batches", () => {
    const db = openStatsDb(":memory:")
    upsertSession(db, { sessionID: "s1", startedAt: NOW })
    // More rows than a batch holds: the delete has to loop to finish the job.
    for (let index = 0; index < 5_200; index += 1) {
      recordStep(db, { messageID: `bulk_${index}`, sessionID: "s1", providerID: "opencode", modelID: "m1", input: 1, createdAt: NOW - 40 * DAY, recordedAt: NOW })
    }
    recordStep(db, { messageID: "kept", sessionID: "s1", providerID: "opencode", modelID: "m1", input: 1, createdAt: NOW, recordedAt: NOW })
    const result = pruneOlderThan(db, NOW - 30 * DAY)
    expect(result.steps).toBe(5_200)
    expect(db.query("SELECT message_id FROM steps").all()).toEqual([{ message_id: "kept" }])
    // A second pass finds nothing: the loop stops on an empty batch.
    expect(pruneOlderThan(db, NOW - 30 * DAY)).toEqual({ steps: 0, prompts: 0, events: 0 })
    db.close()
  })

  test("is a no-op when nothing is older than the cutoff", () => {
    const db = seed()
    expect(pruneOlderThan(db, NOW - 400 * DAY)).toEqual({ steps: 0, prompts: 0, events: 0 })
    db.close()
  })
})

describe("backfillListCost", () => {
  test("prices only the $0 steps without an estimate, and never overwrites one", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "a", sessionID: "s", providerID: "opencode-go", modelID: "m1", input: 1_000_000, cost: 0, createdAt: NOW })
    recordStep(db, { messageID: "b", sessionID: "s", providerID: "opencode-go", modelID: "m1", input: 2_000_000, cost: 0, listCost: 0.5, createdAt: NOW })
    recordStep(db, { messageID: "c", sessionID: "s", providerID: "opencode-go", modelID: "m1", input: 1_000_000, cost: 0.02, createdAt: NOW })
    recordStep(db, { messageID: "d", sessionID: "s", providerID: "opencode-go", modelID: "unknown", input: 1_000_000, cost: 0, createdAt: NOW })
    recordStep(db, { messageID: "f", sessionID: "s", providerID: "opencode-go", modelID: "free", input: 1_000_000, cost: 0, createdAt: NOW })
    const prices = {
      "opencode-go/m1": 0.01,
      "opencode-go/free": 0,
    } as Record<string, number>
    const result = backfillListCost(db, (ref) => (ref.providerID === undefined || ref.modelID === undefined ? undefined : prices[`${ref.providerID}/${ref.modelID}`]))
    expect(result).toEqual({ candidates: 3, updated: 2 })
    const rows = db.query("SELECT message_id, list_cost FROM steps ORDER BY message_id").all()
    expect(rows).toEqual([
      { message_id: "a", list_cost: 0.01 },
      { message_id: "b", list_cost: 0.5 },
      { message_id: "c", list_cost: null },
      { message_id: "d", list_cost: null },
      { message_id: "f", list_cost: 0 },
    ])
    // The free row is priced as known free and leaves the candidate set; only
    // the unknown model still needs a price.
    expect(dbInfo(db, ":memory:").unpriced).toBe(1)
    // A second run has nothing left to do for the priced and free rows; the
    // unknown model remains a candidate.
    expect(backfillListCost(db, () => 0.02)).toEqual({ candidates: 1, updated: 1 })
    expect(db.query("SELECT list_cost FROM steps WHERE message_id = 'd'").get()).toEqual({ list_cost: 0.02 })
    db.close()
  })

  test("does not count steps without an identity or without tokens", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "no-model", sessionID: "s", cost: 0, createdAt: NOW })
    recordStep(db, { messageID: "empty", sessionID: "s", providerID: "p", modelID: "m", cost: 0, createdAt: NOW })
    expect(dbInfo(db, ":memory:", NOW).unpriced).toBe(0)
    expect(backfillListCost(db, () => 0.01)).toEqual({ candidates: 0, updated: 0 })
    db.close()
  })

  test("is a no-op on a database without the list-price column", () => {
    const db = new Database(":memory:")
    db.exec("CREATE TABLE steps (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0)")
    expect(backfillListCost(db, () => 1)).toEqual({ candidates: 0, updated: 0 })
    db.close()
  })
})

describe("vacuum", () => {
  test("gives the space a prune freed back to the filesystem", () => {
    const directory = mkdtempSync(join(tmpdir(), "usage-insights-vacuum-"))
    const path = join(directory, "usage.db")
    try {
      const db = openStatsDb(path)
      for (let index = 0; index < 400; index += 1) {
        recordStep(db, {
          messageID: `m${index}`,
          sessionID: "s1",
          providerID: "opencode",
          modelID: "m1",
          input: 1_000,
          cacheRead: 100_000,
          createdAt: NOW - 200 * DAY,
          completedAt: NOW - 200 * DAY + 1,
          // Padding, so the rows are big enough for the difference to be visible.
          finish: "stop".repeat(200),
        })
      }
      pruneOlderThan(db, NOW - 30 * DAY)
      const result = vacuum(db, path)
      // The space the pruned rows occupied comes back.
      expect(result.freed).toBeGreaterThan(0)
      expect(result.after).toBeLessThan(result.before)
      expect(statSync(path).size).toBeLessThanOrEqual(result.after)
      // The database still opens and answers.
      expect((db.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }).n).toBe(0)
      db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
