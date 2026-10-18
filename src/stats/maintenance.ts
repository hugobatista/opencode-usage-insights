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
 * Rows deleted per transaction. A single delete of a long history holds the
 * write lock for the whole scan — measured at 1.3 s for 123k steps — and the
 * recorder writes on the agent's event path, so it would wait that long. In
 * batches the lock is taken and released per batch and the recorder
 * interleaves. Each batch is atomic; the prune as a whole is not, which is
 * fine for "delete what is older than this": a prune that is interrupted
 * leaves fewer rows deleted, and the next one finishes the job.
 */
const PRUNE_BATCH = 5_000

function deleteBatched(db: Database, table: "steps" | "prompts" | "events", where: string, cutoff: number): number {
  // Table names and the WHERE clause are constants of this module: no value
  // from outside is ever interpolated into the statement.
  const statement = db.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${PRUNE_BATCH})`)
  let removed = 0
  for (;;) {
    const changes = statement.run(cutoff).changes
    removed += changes
    if (changes < PRUNE_BATCH) break
  }
  return removed
}

/**
 * Delete recorded usage older than `cutoff`. Steps, their prompts and the
 * compaction events that explain their cache losses go together: a compaction
 * that no step references answers nothing.
 */
export function pruneOlderThan(db: Database, cutoff: number): PruneResult {
  return {
    steps: deleteBatched(db, "steps", `${STEP_TIME} < ?`, cutoff),
    prompts: deleteBatched(db, "prompts", "created_at IS NOT NULL AND created_at < ?", cutoff),
    events: deleteBatched(db, "events", "at IS NOT NULL AND at < ?", cutoff),
  }
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
