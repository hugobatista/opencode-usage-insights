import type { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { TABLES, type TableName } from "./db"

/**
 * Database maintenance: what the file holds, how much of it is worth keeping,
 * and the two operations that give the space back.
 *
 * Everything is explicit — nothing here runs on its own. The panel's `db` view
 * and `bun run report` are the only callers.
 */

export type TableSize = {
  name: string
  rows: number
}

export type DbInfo = {
  path: string
  /** Size of the database file, in bytes. */
  bytes: number
  /** Size of its write-ahead log, when one exists. */
  walBytes: number | undefined
  schemaVersion: number
  tables: TableSize[]
  /** Oldest and newest recorded step, the window the views can answer for. */
  firstAt: number | undefined
  lastAt: number | undefined
  /** Steps a prune at each cutoff would remove, for the panel to offer choices. */
  removable: Array<{ days: number; steps: number }>
}

const STEP_TIME = "COALESCE(created_at, recorded_at)"
const DAY = 24 * 60 * 60 * 1000

function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function dbInfo(db: Database, path: string, now = Date.now()): DbInfo {
  const tables: TableSize[] = TABLES.map((table) => ({
    name: table,
    rows: (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  }))
  const window = db.query(`SELECT MIN(${STEP_TIME}) AS first, MAX(${STEP_TIME}) AS last FROM steps`).get() as {
    first: number | null
    last: number | null
  }
  const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null
  return {
    path,
    bytes: size(path),
    walBytes: path === ":memory:" ? undefined : size(`${path}-wal`) || undefined,
    schemaVersion: version === null ? 0 : Number.parseInt(version.value, 10),
    tables,
    firstAt: window.first ?? undefined,
    lastAt: window.last ?? undefined,
    removable: [30, 90, 365].map((days) => ({
      days,
      steps: (db.query(`SELECT COUNT(*) AS n FROM steps WHERE ${STEP_TIME} < ?`).get(now - days * DAY) as { n: number }).n,
    })),
  }
}

export type PruneResult = {
  steps: number
  prompts: number
  events: number
}

/**
 * Delete recorded usage older than `cutoff`. Steps, their prompts and the
 * compaction events that explain their cache losses go together: a compaction
 * that no step references answers nothing.
 */
export function pruneOlderThan(db: Database, cutoff: number): PruneResult {
  const steps = db.query(`DELETE FROM steps WHERE ${STEP_TIME} < ?`).run(cutoff).changes
  const prompts = db.query("DELETE FROM prompts WHERE created_at IS NOT NULL AND created_at < ?").run(cutoff).changes
  const events = db.query("DELETE FROM events WHERE at IS NOT NULL AND at < ?").run(cutoff).changes
  return { steps, prompts, events }
}

/** Everything the database occupies: the main file plus its write-ahead log. */
function footprint(path: string): number {
  return size(path) + size(`${path}-wal`)
}

/** Reclaim the space a prune freed. Returns the bytes the database lost. */
export function vacuum(db: Database, path: string): { before: number; after: number; freed: number } {
  const before = footprint(path)
  // A checkpoint first: with WAL the freed pages live in the log until the
  // database is written back into the main file.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.exec("VACUUM")
  const after = footprint(path)
  return { before, after, freed: Math.max(0, before - after) }
}

export type { TableName }
