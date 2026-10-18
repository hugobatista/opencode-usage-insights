import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { EndpointInfo } from "../endpoint"
import { ensureRegularFile } from "./paths"
import { normalizeToken, sanitizeLabel, TEXT_LIMIT } from "../text"

/**
 * Persistent usage store. One SQLite database holds every recorded step,
 * prompt, event and session row — and nothing else: the recorder only writes
 * what a view reads.
 *
 * The database is opened in WAL mode with a busy timeout so the server
 * recorder process and the TUI reader process can share it safely. The two
 * sides open it differently on purpose:
 *
 * - `openStatsDb` writes: schema, migrations and recording (the server).
 * - `openStatsDbReadOnly` only reads (the TUI), so no view can change the file
 *   and no reader pays for a schema write.
 * - `openStatsDbWrite` is a short-lived maintenance connection (prune, vacuum)
 *   that gives up quickly instead of holding the recorder up.
 */

export const SCHEMA_VERSION = 7

/** Longest title or path kept: a label on a line, not a document. */
const LABEL_LIMIT = 4 * TEXT_LIMIT

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  parent_id TEXT,
  directory TEXT,
  title TEXT,
  started_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS prompts (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (session_id, message_id)
);
CREATE INDEX IF NOT EXISTS prompts_created ON prompts(created_at);

CREATE TABLE IF NOT EXISTS steps (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  variant TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER,
  streamed_at INTEGER,
  completed_at INTEGER,
  finish TEXT,
  router TEXT,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_session ON steps(session_id, created_at);
CREATE INDEX IF NOT EXISTS steps_model ON steps(provider_id, model_id, variant);
CREATE INDEX IF NOT EXISTS steps_completed ON steps(completed_at);
CREATE INDEX IF NOT EXISTS steps_router ON steps(router);
-- Every range filter and every ordering compares the step's own clock, which
-- falls back to the recording time for a step that was already in flight when
-- the plugin loaded. The index has to cover that expression, or every ranged
-- view is a full table scan.
CREATE INDEX IF NOT EXISTS steps_at ON steps(COALESCE(created_at, recorded_at));
CREATE INDEX IF NOT EXISTS steps_session_at ON steps(session_id, COALESCE(created_at, recorded_at));

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message_id TEXT,
  at INTEGER,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at);
`

/** Tables carried by `exportNdjson` / `importNdjson`, in import-safe order. */
export const TABLES = ["sessions", "prompts", "events", "steps"] as const

export type TableName = (typeof TABLES)[number]

export type StepRecord = {
  messageID: string
  sessionID: string
  parentID?: string | undefined
  providerID?: string | undefined
  modelID?: string | undefined
  variant?: string | undefined
  input?: number | undefined
  output?: number | undefined
  reasoning?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
  cost?: number | undefined
  createdAt?: number | undefined
  streamedAt?: number | undefined
  completedAt?: number | undefined
  finish?: string | undefined
  /** Gateway routing endpoint that served the request (`orcarouter-dsv4.1flash`). */
  router?: string | undefined
  /** Clock of the recording itself, defaults to `Date.now()`. */
  recordedAt?: number | undefined
}

export type PromptRecord = {
  sessionID: string
  messageID: string
  createdAt?: number | undefined
}

export type EventRecord = {
  sessionID: string
  kind: string
  messageID?: string | undefined
  at?: number | undefined
  data?: unknown
}

export type SessionRecord = {
  sessionID: string
  parentID?: string | undefined
  directory?: string | undefined
  title?: string | undefined
  startedAt?: number | undefined
  updatedAt?: number | undefined
}

function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/**
 * Columns added after the first release, applied to an existing database, with
 * an optional statement that backfills them.
 */
const MIGRATIONS: ReadonlyArray<readonly [string, string, string?]> = [
  ["router", "ALTER TABLE steps ADD COLUMN router TEXT"],
]

/**
 * Columns and tables the recorder used to write and no view ever read. They are
 * dropped from an existing database, together with the rows of the events that
 * followed the same fate, so a long-lived file shrinks instead of carrying dead
 * weight forever.
 */
const REMOVED_COLUMNS = ["provider_state", "upstream", "upstream_source", "upstream_model", "tps"] as const
const REMOVED_EVENT_KINDS = ["execution", "step-failed", "model-selected", "usage-recorded"] as const

function dropUnused(db: Database): void {
  const objects = db.query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')").all() as {
    name: string
    type: string
  }[]
  const tables = new Set(objects.filter((row) => row.type === "table").map((row) => row.name))
  const indexes = new Set(objects.filter((row) => row.type === "index").map((row) => row.name))

  if (tables.has("http_responses")) db.exec("DROP TABLE http_responses")
  // The index reads a column that is about to go: SQLite refuses to drop an
  // indexed column, so the index goes first.
  if (indexes.has("steps_upstream")) db.exec("DROP INDEX steps_upstream")

  const columns = new Set((db.query("PRAGMA table_info(steps)").all() as { name: string }[]).map((column) => column.name))
  for (const name of REMOVED_COLUMNS) {
    if (columns.has(name)) db.exec(`ALTER TABLE steps DROP COLUMN ${name}`)
  }

  if (tables.has("events")) {
    const kinds = REMOVED_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ")
    db.exec(`DELETE FROM events WHERE kind IN (${kinds})`)
  }
}

function schemaVersion(db: Database): number {
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null
  const parsed = row === null ? Number.NaN : Number.parseInt(row.value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The endpoint identity is a grouping key: two spellings of the same endpoint
 * would split its history and read as a change. Values recorded before the
 * rule existed are folded into the lowercase form.
 */
function normalizeRouters(db: Database): void {
  db.exec("UPDATE steps SET router = lower(router) WHERE router IS NOT NULL AND router <> lower(router)")
}

function migrate(db: Database): void {
  const version = schemaVersion(db)
  const steps = db.query("PRAGMA table_info(steps)").all() as { name: string }[]
  const existing = new Set(steps.map((column) => column.name))
  for (const [name, statement, backfill] of MIGRATIONS) {
    if (existing.has(name)) continue
    db.exec(statement)
    if (backfill !== undefined) db.exec(backfill)
  }
  // Anything the recorder used to write and no view ever read is dropped here.
  // It is cheap and idempotent, so it also heals a database a half-applied
  // migration left behind.
  dropUnused(db)
  if (version < 7) normalizeRouters(db)
}

/**
 * The file holds session titles, project directories and usage history, so it
 * is created for the user alone. Windows takes its access from the parent
 * directory's ACL, which is not something a plugin should rewrite.
 */
const POSIX = process.platform !== "win32"

function hardenDirectory(path: string): void {
  if (!POSIX) return
  try {
    chmodSync(path, 0o700)
  } catch {
    // A shared or read-only directory: the database is still usable.
  }
}

function hardenFiles(path: string): void {
  if (!POSIX || path === ":memory:") return
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, 0o600)
    } catch {
      // The WAL and the shared-memory file are created on the first write and
      // removed on the last close, so one of them is often simply absent.
    }
  }
}

/** Directory for a database path, created private on POSIX. */
function prepareDirectory(path: string): void {
  if (path === ":memory:") return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  hardenDirectory(dirname(path))
}

/** Open (creating when needed) the stats database and apply the schema. */
export function openStatsDb(path: string): Database {
  if (path !== ":memory:") ensureRegularFile(path)
  prepareDirectory(path)
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec(SCHEMA)
  migrate(db)
  db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(SCHEMA_VERSION),
  )
  // The schema write is what creates the WAL and its shared-memory file.
  hardenFiles(path)
  return db
}

/**
 * Reader connection for the TUI: no schema, no migration, no write. It throws
 * when the database is absent or was never written by the recorder, so the
 * caller can say so instead of showing an empty panel.
 */
export function openStatsDbReadOnly(path: string): Database {
  ensureRegularFile(path)
  const db = new Database(path, { readonly: true })
  try {
    db.query("SELECT 1 FROM steps LIMIT 1").get()
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

/**
 * Short-lived write connection for maintenance. The busy timeout is short on
 * purpose: a prune or a vacuum that cannot take the lock must fail in front of
 * the user, not hold the recorder's response path for seconds.
 */
export function openStatsDbWrite(path: string): Database {
  if (path !== ":memory:") ensureRegularFile(path)
  prepareDirectory(path)
  const db = new Database(path, { create: true })
  db.exec("PRAGMA busy_timeout = 250")
  db.exec("PRAGMA synchronous = NORMAL")
  hardenFiles(path)
  return db
}

/**
 * Insert or refresh an assistant step. Idempotent by message ID so replayed
 * events, restarts and NDJSON imports never duplicate usage. Non-null fields
 * discovered later (the routing endpoint) survive a re-record with `NULL`
 * through COALESCE.
 */
export function recordStep(db: Database, record: StepRecord): void {
  db.query(
    `INSERT INTO steps (
       message_id, session_id, parent_id, provider_id, model_id, variant,
       input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, cost,
       created_at, streamed_at, completed_at, finish, router, recorded_at
     ) VALUES (
       $messageID, $sessionID, $parentID, $providerID, $modelID, $variant,
       $input, $output, $reasoning, $cacheRead, $cacheWrite, $cost,
       $createdAt, $streamedAt, $completedAt, $finish, $router, $recordedAt
     )
     ON CONFLICT(message_id) DO UPDATE SET
       session_id = excluded.session_id,
       parent_id = COALESCE(excluded.parent_id, steps.parent_id),
       provider_id = COALESCE(excluded.provider_id, steps.provider_id),
       model_id = COALESCE(excluded.model_id, steps.model_id),
       variant = COALESCE(excluded.variant, steps.variant),
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       reasoning_tokens = excluded.reasoning_tokens,
       cache_read = excluded.cache_read,
       cache_write = excluded.cache_write,
       cost = excluded.cost,
       created_at = COALESCE(excluded.created_at, steps.created_at),
       streamed_at = COALESCE(excluded.streamed_at, steps.streamed_at),
       completed_at = COALESCE(excluded.completed_at, steps.completed_at),
       finish = COALESCE(excluded.finish, steps.finish),
       router = COALESCE(excluded.router, steps.router),
       recorded_at = excluded.recorded_at`,
  ).run({
    $messageID: record.messageID,
    $sessionID: record.sessionID,
    $parentID: record.parentID ?? null,
    $providerID: record.providerID ?? null,
    $modelID: record.modelID ?? null,
    $variant: record.variant ?? null,
    $input: record.input ?? 0,
    $output: record.output ?? 0,
    $reasoning: record.reasoning ?? 0,
    $cacheRead: record.cacheRead ?? 0,
    $cacheWrite: record.cacheWrite ?? 0,
    $cost: record.cost ?? 0,
    $createdAt: record.createdAt ?? null,
    $streamedAt: record.streamedAt ?? null,
    $completedAt: record.completedAt ?? null,
    $finish: record.finish === undefined ? null : sanitizeLabel(record.finish, 64),
    $router: record.router === undefined ? null : (normalizeToken(record.router) ?? null),
    $recordedAt: record.recordedAt ?? Date.now(),
  })
}

export function recordPrompt(db: Database, record: PromptRecord): void {
  db.query(
    `INSERT INTO prompts (session_id, message_id, created_at)
     VALUES ($sessionID, $messageID, $createdAt)
     ON CONFLICT(session_id, message_id) DO UPDATE SET created_at = COALESCE(excluded.created_at, prompts.created_at)`,
  ).run({
    $sessionID: record.sessionID,
    $messageID: record.messageID,
    $createdAt: record.createdAt ?? null,
  })
}

export function recordEvent(db: Database, record: EventRecord): void {
  db.query(
    `INSERT INTO events (session_id, kind, message_id, at, data)
     VALUES ($sessionID, $kind, $messageID, $at, $data)`,
  ).run({
    $sessionID: record.sessionID,
    $kind: sanitizeLabel(record.kind, 64),
    $messageID: record.messageID ?? null,
    $at: record.at ?? Date.now(),
    $data: jsonText(record.data),
  })
}

export function upsertSession(db: Database, record: SessionRecord): void {
  db.query(
    `INSERT INTO sessions (session_id, parent_id, directory, title, started_at, updated_at)
     VALUES ($sessionID, $parentID, $directory, $title, $startedAt, $updatedAt)
     ON CONFLICT(session_id) DO UPDATE SET
       parent_id = COALESCE(excluded.parent_id, sessions.parent_id),
       directory = COALESCE(excluded.directory, sessions.directory),
       title = COALESCE(excluded.title, sessions.title),
       started_at = COALESCE(sessions.started_at, excluded.started_at),
       updated_at = COALESCE(excluded.updated_at, sessions.updated_at)`,
  ).run({
    $sessionID: record.sessionID,
    $parentID: record.parentID ?? null,
    // Titles are written by a model and directories come from the host: both
    // are displayed, so neither may carry control characters into a terminal.
    $directory: record.directory === undefined ? null : sanitizeLabel(record.directory, LABEL_LIMIT),
    $title: record.title === undefined ? null : sanitizeLabel(record.title, LABEL_LIMIT),
    $startedAt: record.startedAt ?? null,
    $updatedAt: record.updatedAt ?? null,
  })
}

/**
 * Attach the endpoint discovered after the step was recorded. A step that
 * already carries the same endpoint is left alone: the recorder runs on the
 * request path, and a no-op write there is a cost with no reader.
 */
export function setStepRouter(db: Database, messageID: string, info: EndpointInfo): void {
  const router = info.router === undefined ? undefined : normalizeToken(info.router)
  if (router === undefined) return
  db.query(
    `UPDATE steps
        SET router = $router
      WHERE message_id = $messageID AND router IS NOT $router`,
  ).run({ $router: router, $messageID: messageID })
}

/**
 * Apply the endpoint learned from a compaction to every step of that session
 * and model that still lacks one. Returns the number of rows touched.
 */
export function setStepRouterForSessionModel(
  db: Database,
  sessionID: string,
  modelID: string | undefined,
  info: EndpointInfo,
): number {
  const router = info.router === undefined ? undefined : normalizeToken(info.router)
  if (router === undefined) return 0
  const result = db
    .query(
      `UPDATE steps
          SET router = $router
        WHERE session_id = $sessionID AND router IS NULL AND ($modelID IS NULL OR model_id = $modelID)`,
    )
    .run({ $router: router, $sessionID: sessionID, $modelID: modelID ?? null })
  return result.changes
}

/** Dump every table as NDJSON (`{"table": "...", "row": {...}}` per line). */
export function exportNdjson(db: Database): string {
  const lines: string[] = []
  for (const table of TABLES) {
    const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
    for (const row of rows) lines.push(JSON.stringify({ table, row }))
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

/** Column shape an import has to respect: the type and the NOT NULL rules. */
type ImportColumn = {
  name: string
  /** Declared affinity: `INTEGER`, `REAL`, `TEXT`, `BLOB` or empty. */
  type: string
  notNull: boolean
  primaryKey: boolean
  /** A column with a default may be left out of the import entirely. */
  hasDefault: boolean
}

function numericAffinity(type: string): boolean {
  const upper = type.toUpperCase()
  return upper.includes("INT") || upper.includes("REAL") || upper.includes("NUM") || upper.includes("DEC") || upper.includes("DOUB")
}

/**
 * One imported value, forced into the shape of its column. Text is sanitized
 * and capped like everything else that is displayed; a number that is not a
 * finite number becomes NULL, so a crafted dump cannot store `NaN` or a
 * string where a view does arithmetic.
 */
function importValue(value: unknown, column: ImportColumn): string | number | null {
  if (value === null || value === undefined) return null
  if (numericAffinity(column.type)) {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "object") return sanitizeLabel(JSON.stringify(value) ?? "", LABEL_LIMIT)
  return sanitizeLabel(String(value), LABEL_LIMIT)
}

/**
 * Load an `exportNdjson` dump back in. Rows are inserted with `OR IGNORE`, so
 * importing the same dump twice is harmless. Unknown tables and rows that are
 * not objects are rejected; a row that cannot fill a required column is
 * skipped rather than aborting the rest of the import. A column the row does
 * not carry is left to its default, the same way a hand-written insert is.
 */
export function importNdjson(db: Database, text: string): number {
  const columns = new Map<TableName, ImportColumn[]>()
  for (const table of TABLES) {
    const info = db.query(`PRAGMA table_info(${table})`).all() as {
      name: string
      type: string
      notnull: number
      pk: number
      dflt_value: string | null
    }[]
    columns.set(
      table,
      info.map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notnull === 1,
        primaryKey: column.pk > 0,
        hasDefault: column.dflt_value !== null,
      })),
    )
  }

  let imported = 0
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: { table?: string; row?: Record<string, unknown> }
    try {
      parsed = JSON.parse(trimmed) as { table?: string; row?: Record<string, unknown> }
    } catch {
      continue
    }
    const table = parsed.table as TableName | undefined
    const row = parsed.row
    if (!table || !row || !(TABLES as readonly string[]).includes(table)) continue
    const shape = columns.get(table) ?? []
    if (shape.length === 0) continue
    const names: string[] = []
    const values: (string | number)[] = []
    let importable = true
    for (const column of shape) {
      const value = importValue(row[column.name], column)
      if (value !== null) {
        names.push(column.name)
        values.push(value)
        continue
      }
      // NULL for a column that cannot hold one has no default to fall back on,
      // and a NULL in a text primary key is a key the database cannot use; an
      // INTEGER PRIMARY KEY is a rowid, so leaving it out assigns one.
      const required = (column.notNull || (column.primaryKey && !numericAffinity(column.type))) && !column.hasDefault
      if (required) {
        importable = false
        break
      }
    }
    if (!importable) continue
    const placeholders = names.map(() => "?").join(", ")
    db.query(`INSERT OR IGNORE INTO ${table} (${names.join(", ")}) VALUES (${placeholders})`).run(...values)
    imported += 1
  }
  return imported
}
