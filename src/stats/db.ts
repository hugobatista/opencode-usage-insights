import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { ensureRegularFile } from "./paths"
import { isToken, sanitizeLabel, TEXT_LIMIT } from "../text"

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
 * - `openStatsDbWrite` is a short-lived maintenance connection (prune, wipe, vacuum)
 *   that gives up quickly instead of holding the recorder up.
 */

export const SCHEMA_VERSION = 11

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
  list_cost REAL,
  created_at INTEGER,
  streamed_at INTEGER,
  completed_at INTEGER,
  finish TEXT,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_session ON steps(session_id, created_at);
CREATE INDEX IF NOT EXISTS steps_model ON steps(provider_id, model_id, variant);
CREATE INDEX IF NOT EXISTS steps_completed ON steps(completed_at);
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

-- Usage the host reports with no assistant step of its own: the compaction
-- summarisation and the session-title generation. The host publishes it as
-- session.usage.recorded with a source other than generate, and includes it in
-- the session's own cost/token totals. Primary key is the host event ID, so a
-- replayed event never counts twice.
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  at INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_session_at ON usage(session_id, at);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
`

/** Tables carried by `exportNdjson` / `importNdjson`, in import-safe order. */
export const TABLES = ["sessions", "prompts", "events", "steps", "usage"] as const

export type TableName = (typeof TABLES)[number]

export type StepRecord = {
  messageID: string
  sessionID: string
  parentID?: string | undefined
  /** The provider the model ran through, as OpenCode configured it (`opencode-go`). */
  providerID?: string | undefined
  modelID?: string | undefined
  variant?: string | undefined
  input?: number | undefined
  output?: number | undefined
  reasoning?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
  cost?: number | undefined
  /**
   * List-price estimate for a step the host reported as costing nothing.
   * `0` means a known free model; `NULL` means charged money or an unknown
   * price.
   */
  listCost?: number | undefined
  createdAt?: number | undefined
  streamedAt?: number | undefined
  completedAt?: number | undefined
  finish?: string | undefined
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

/**
 * Usage with no assistant step behind it (a compaction or a title generation).
 * `id` is the host event ID: it is the primary key, so a replay is ignored
 * instead of counted again.
 */
export type UsageRecord = {
  id: string
  sessionID: string
  source: string
  at?: number | undefined
  cost?: number | undefined
  input?: number | undefined
  output?: number | undefined
  reasoning?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
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
 * Numeric fields arrive from the host event stream, which the plugin treats as
 * untrusted: a single `NaN` bound to a NOT NULL column makes SQLite reject the
 * whole statement, and the recorder's defensive catch would then silently lose
 * the step. Every number is therefore forced into a finite, non-negative value
 * before it reaches the database.
 */
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function tokenCount(value: unknown): number {
  return Math.max(0, Math.floor(finite(value)))
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Columns and tables the recorder used to write and no view ever read. They are
 * dropped from an existing database, together with the rows of the events that
 * followed the same fate, so a long-lived file shrinks instead of carrying dead
 * weight forever.
 *
 * `router` is here because the gateway that named the routing endpoint in a
 * response header (`x-opencode-endpoint-id`) stopped naming one: the identity a
 * step is grouped by is the provider the model ran through, and the endpoint a
 * gateway happened to route to is no longer observable at all.
 */
const REMOVED_COLUMNS = ["provider_state", "upstream", "upstream_source", "upstream_model", "tps", "router"] as const
const REMOVED_EVENT_KINDS = ["execution", "step-failed", "model-selected", "usage-recorded"] as const

function dropUnused(db: Database): void {
  const objects = db.query("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')").all() as {
    name: string
    type: string
  }[]
  const tables = new Set(objects.filter((row) => row.type === "table").map((row) => row.name))
  const indexes = new Set(objects.filter((row) => row.type === "index").map((row) => row.name))

  if (tables.has("http_responses")) db.exec("DROP TABLE http_responses")
  // These indexes read a column that is about to go: SQLite refuses to drop an
  // indexed column, so the index goes first.
  if (indexes.has("steps_upstream")) db.exec("DROP INDEX steps_upstream")
  if (indexes.has("steps_router")) db.exec("DROP INDEX steps_router")

  const columns = new Set((db.query("PRAGMA table_info(steps)").all() as { name: string }[]).map((column) => column.name))
  for (const name of REMOVED_COLUMNS) {
    if (columns.has(name)) db.exec(`ALTER TABLE steps DROP COLUMN ${name}`)
  }

  if (tables.has("events")) {
    const kinds = REMOVED_EVENT_KINDS.map((kind) => `'${kind}'`).join(", ")
    db.exec(`DELETE FROM events WHERE kind IN (${kinds})`)
  }
}

/**
 * Add the columns a newer recorder writes. `CREATE TABLE IF NOT EXISTS` does
 * not touch a table that already exists, so a column added to `SCHEMA` after a
 * database was created has to be added here too. The check is idempotent and
 * also heals a database a half-applied run left behind.
 */
function addMissing(db: Database): void {
  const columns = new Set((db.query("PRAGMA table_info(steps)").all() as { name: string }[]).map((column) => column.name))
  if (columns.size > 0 && !columns.has("list_cost")) {
    db.exec("ALTER TABLE steps ADD COLUMN list_cost REAL")
  }
}

/**
 * Older recorders inserted a compaction event on every delivery, and the host
 * replays events on reconnect: the same compaction can be stored several times.
 * Keep one row per exact duplicate before the unique key is installed, so the
 * event count and any future cost aggregation stay honest.
 */
function dedupeEvents(db: Database): void {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()
  if (table === null) return
  db.exec(`DELETE FROM events
            WHERE kind = 'compaction' AND message_id IS NULL
              AND rowid NOT IN (
                SELECT MIN(rowid) FROM events
                 WHERE kind = 'compaction' AND message_id IS NULL
                 GROUP BY session_id, at, data
              )`)
  db.exec(`DELETE FROM events
            WHERE message_id IS NOT NULL
              AND rowid NOT IN (
                SELECT MIN(rowid) FROM events
                 WHERE message_id IS NOT NULL
                 GROUP BY kind, message_id
              )`)
}

/**
 * A host event ID identifies one event: a replay must not insert a second row.
 * The index is partial because historical rows carry no ID.
 */
function addEventKey(db: Database): void {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()
  if (table === null) return
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_kind_message ON events(kind, message_id) WHERE message_id IS NOT NULL")
}

/**
 * Older recorders kept only the compaction event, never `session.usage.recorded`.
 * The event's payload already carries the cost and tokens, so recovering it
 * makes the fix retroactive for compactions. A row gets a stable synthetic ID;
 * `INSERT OR IGNORE` makes the recovery idempotent. Only historical rows
 * (`message_id IS NULL`) are considered: from this version on the recorder
 * stores the usage event itself, and backfilling again would count it twice.
 */
function backfillCompactionUsage(db: Database): void {
  const tables = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name),
  )
  if (!tables.has("events") || !tables.has("usage")) return
  db.exec(`INSERT OR IGNORE INTO usage (
             id, session_id, source, at, cost,
             input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write
           )
           SELECT 'compaction:' || rowid, session_id, 'compaction', at,
                  MAX(0, COALESCE(CAST(json_extract(data, '$.cost') AS REAL), 0)),
                  MAX(0, CAST(COALESCE(json_extract(data, '$.tokens.input'), 0) AS INTEGER)),
                  MAX(0, CAST(COALESCE(json_extract(data, '$.tokens.output'), 0) AS INTEGER)),
                  MAX(0, CAST(COALESCE(json_extract(data, '$.tokens.reasoning'), 0) AS INTEGER)),
                  MAX(0, CAST(COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS INTEGER)),
                  MAX(0, CAST(COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS INTEGER))
             FROM events
            WHERE kind = 'compaction' AND message_id IS NULL AND at IS NOT NULL AND data IS NOT NULL
              AND json_valid(data)`)
}

/**
 * Bring an existing file up to date: drop what no view reads, add what a newer
 * recorder writes, repair the event log a replayed write duplicated, and
 * recover the compaction usage older versions left in the event payload. Every
 * step is idempotent.
 */
function migrate(db: Database): void {
  dropUnused(db)
  addMissing(db)
  dedupeEvents(db)
  backfillCompactionUsage(db)
  addEventKey(db)
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
 * purpose: a prune, wipe or vacuum that cannot take the lock must fail in front of
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
 * events, restarts and NDJSON imports never duplicate usage. A non-null field
 * (the provider, the model, the finish reason) survives a re-record with `NULL`
 * through COALESCE. `list_cost` follows the opposite rule: a step that becomes
 * charged loses its estimate, and an estimate survives a replay that carries
 * no price table.
 *
 * The provider is the identity every view groups by, so it is validated as a
 * token before it is stored: a value that is not a provider id is recorded as
 * absent instead of becoming a grouping key.
 */
export function recordStep(db: Database, record: StepRecord): void {
  const cost = Math.max(0, finite(record.cost))
  const listCost =
    cost <= 0 && typeof record.listCost === "number" && Number.isFinite(record.listCost) && record.listCost >= 0
      ? record.listCost
      : null
  db.query(
    `INSERT INTO steps (
       message_id, session_id, parent_id, provider_id, model_id, variant,
       input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, cost, list_cost,
       created_at, streamed_at, completed_at, finish, recorded_at
     ) VALUES (
       $messageID, $sessionID, $parentID, $providerID, $modelID, $variant,
       $input, $output, $reasoning, $cacheRead, $cacheWrite, $cost, $listCost,
       $createdAt, $streamedAt, $completedAt, $finish, $recordedAt
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
       -- A step that starts being charged loses its estimate; an estimate is
       -- kept when a replayed event arrives without a price table.
       list_cost = CASE WHEN excluded.cost > 0 THEN NULL ELSE COALESCE(excluded.list_cost, steps.list_cost) END,
       created_at = COALESCE(excluded.created_at, steps.created_at),
       streamed_at = COALESCE(excluded.streamed_at, steps.streamed_at),
       completed_at = COALESCE(excluded.completed_at, steps.completed_at),
       finish = COALESCE(excluded.finish, steps.finish),
       recorded_at = excluded.recorded_at`,
  ).run({
    $messageID: record.messageID,
    $sessionID: record.sessionID,
    $parentID: record.parentID ?? null,
    $providerID: record.providerID !== undefined && isToken(record.providerID) ? record.providerID : null,
    $modelID: record.modelID ?? null,
    $variant: record.variant ?? null,
    $input: tokenCount(record.input),
    $output: tokenCount(record.output),
    $reasoning: tokenCount(record.reasoning),
    $cacheRead: tokenCount(record.cacheRead),
    $cacheWrite: tokenCount(record.cacheWrite),
    $cost: cost,
    $listCost: listCost,
    $createdAt: timestamp(record.createdAt),
    $streamedAt: timestamp(record.streamedAt),
    $completedAt: timestamp(record.completedAt),
    $finish: record.finish === undefined ? null : sanitizeLabel(record.finish, 64),
    $recordedAt: timestamp(record.recordedAt) ?? Date.now(),
  })
}

/**
 * Insert usage that has no assistant step of its own. The host event ID is the
 * primary key: a replayed event is ignored, so the totals never double count a
 * compaction or a title generation delivered more than once.
 */
export function recordUsage(db: Database, record: UsageRecord): void {
  if (typeof record.id !== "string" || record.id === "") return
  if (typeof record.sessionID !== "string" || record.sessionID === "") return
  db.query(
    `INSERT INTO usage (
       id, session_id, source, at, cost, input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write
     ) VALUES (
       $id, $sessionID, $source, $at, $cost, $input, $output, $reasoning, $cacheRead, $cacheWrite
     ) ON CONFLICT(id) DO NOTHING`,
  ).run({
    $id: record.id,
    $sessionID: record.sessionID,
    $source: sanitizeLabel(record.source, 64),
    $at: timestamp(record.at) ?? Date.now(),
    $cost: Math.max(0, finite(record.cost)),
    $input: tokenCount(record.input),
    $output: tokenCount(record.output),
    $reasoning: tokenCount(record.reasoning),
    $cacheRead: tokenCount(record.cacheRead),
    $cacheWrite: tokenCount(record.cacheWrite),
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
    $createdAt: timestamp(record.createdAt),
  })
}

export function recordEvent(db: Database, record: EventRecord): void {
  db.query(
    `INSERT OR IGNORE INTO events (session_id, kind, message_id, at, data)
     VALUES ($sessionID, $kind, $messageID, $at, $data)`,
  ).run({
    $sessionID: record.sessionID,
    $kind: sanitizeLabel(record.kind, 64),
    $messageID: record.messageID ?? null,
    $at: timestamp(record.at) ?? Date.now(),
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
    $startedAt: timestamp(record.startedAt),
    $updatedAt: timestamp(record.updatedAt),
  })
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
    // The database's money rule is an invariant, not a convention: a step that
    // was charged has no list estimate. A hand-written or foreign dump may
    // carry both, which every cost total would then add twice. Negative token
    // counts and costs are nonsense and would poison the sums.
    const tokenNames = ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read", "cache_write"]
    for (const name of tokenNames) {
      const index = names.indexOf(name)
      if (index !== -1 && typeof values[index] === "number") values[index] = Math.max(0, Math.floor(values[index] as number))
    }
    const costIndex = names.indexOf("cost")
    if (costIndex !== -1 && typeof values[costIndex] === "number") {
      const cost = Math.max(0, values[costIndex] as number)
      values[costIndex] = cost
      const listIndex = names.indexOf("list_cost")
      if (table === "steps" && cost > 0 && listIndex !== -1) {
        names.splice(listIndex, 1)
        values.splice(listIndex, 1)
      }
    }
    const placeholders = names.map(() => "?").join(", ")
    db.query(`INSERT OR IGNORE INTO ${table} (${names.join(", ")}) VALUES (${placeholders})`).run(...values)
    imported += 1
  }
  return imported
}
