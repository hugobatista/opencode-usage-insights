import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { UpstreamInfo } from "../upstream"

/**
 * Persistent usage store. One SQLite database holds every recorded step,
 * prompt, event, session row and (in discovery mode) upstream HTTP response.
 *
 * The database is opened in WAL mode with a busy timeout so the server
 * recorder process and the TUI reader process can share it safely.
 */

export const SCHEMA_VERSION = 4

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
  provider_state TEXT,
  upstream TEXT,
  upstream_source TEXT,
  upstream_model TEXT,
  router TEXT,
  tps REAL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_session ON steps(session_id, created_at);
CREATE INDEX IF NOT EXISTS steps_model ON steps(provider_id, model_id, variant);
CREATE INDEX IF NOT EXISTS steps_completed ON steps(completed_at);
CREATE INDEX IF NOT EXISTS steps_upstream ON steps(upstream);

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

CREATE TABLE IF NOT EXISTS http_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  method TEXT,
  path TEXT,
  status INTEGER,
  headers TEXT
);
CREATE INDEX IF NOT EXISTS http_responses_at ON http_responses(at);
`

/** Tables carried by `exportNdjson` / `importNdjson`, in import-safe order. */
export const TABLES = ["sessions", "prompts", "events", "steps", "http_responses"] as const

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
  /** Raw `providerState` of the assistant message, stringified when needed. */
  providerState?: unknown
  upstream?: string | undefined
  upstreamSource?: string | undefined
  /** Upstream model id reported by the gateway (`deepseek/deepseek-v4.1-flash`). */
  upstreamModel?: string | undefined
  /** Gateway routing endpoint that served the request (`orcarouter-dsv4.1flash`). */
  router?: string | undefined
  /** Tokens per second of the step: `(output + reasoning)` over `created → streamed`. */
  tps?: number | undefined
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

export type HttpResponseRecord = {
  at: number
  method?: string | undefined
  path?: string | undefined
  status?: number | undefined
  headers?: unknown
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
  ["upstream_model", "ALTER TABLE steps ADD COLUMN upstream_model TEXT"],
  ["router", "ALTER TABLE steps ADD COLUMN router TEXT"],
  [
    "tps",
    "ALTER TABLE steps ADD COLUMN tps REAL",
    // Tokens per second are derivable from what is already stored, so the
    // history gains the column too: (output + reasoning) over the streaming
    // window (created → streamed).
    `UPDATE steps
        SET tps = (output_tokens + reasoning_tokens) * 1000.0 / (streamed_at - created_at)
      WHERE tps IS NULL
        AND streamed_at IS NOT NULL
        AND created_at IS NOT NULL
        AND streamed_at > created_at
        AND (output_tokens + reasoning_tokens) > 0`,
  ],
]

/**
 * Data migrations keyed by the schema version that introduced them. They run
 * once per database, in order, and are what lets a derived column change its
 * meaning without leaving stale values behind.
 */
const DATA_MIGRATIONS: ReadonlyArray<readonly [number, string]> = [
  [
    4,
    `UPDATE steps
        SET tps = CASE
              WHEN streamed_at IS NOT NULL
               AND created_at IS NOT NULL
               AND streamed_at > created_at
               AND (output_tokens + reasoning_tokens) > 0
              THEN (output_tokens + reasoning_tokens) * 1000.0 / (streamed_at - created_at)
              ELSE NULL
            END`,
  ],
]

function schemaVersion(db: Database): number {
  const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null
  const parsed = row === null ? Number.NaN : Number.parseInt(row.value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function migrate(db: Database): void {
  const steps = db.query("PRAGMA table_info(steps)").all() as { name: string }[]
  const existing = new Set(steps.map((column) => column.name))
  for (const [name, statement, backfill] of MIGRATIONS) {
    if (existing.has(name)) continue
    db.exec(statement)
    if (backfill !== undefined) db.exec(backfill)
  }
  const version = schemaVersion(db)
  for (const [target, statement] of DATA_MIGRATIONS) {
    if (version >= target) continue
    db.exec(statement)
  }
}

/** Open (creating when needed) the stats database and apply the schema. */
export function openStatsDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec(SCHEMA)
  migrate(db)
  db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(SCHEMA_VERSION),
  )
  return db
}

/**
 * Insert or refresh an assistant step. Idempotent by message ID so replayed
 * events, restarts and NDJSON imports never duplicate usage. Non-null fields
 * discovered later (upstream operator name, provider state) survive a
 * re-record with `NULL` through COALESCE.
 */
export function recordStep(db: Database, record: StepRecord): void {
  db.query(
    `INSERT INTO steps (
       message_id, session_id, parent_id, provider_id, model_id, variant,
       input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, cost,
       created_at, streamed_at, completed_at, finish, provider_state,
       upstream, upstream_source, upstream_model, router, tps, recorded_at
     ) VALUES (
       $messageID, $sessionID, $parentID, $providerID, $modelID, $variant,
       $input, $output, $reasoning, $cacheRead, $cacheWrite, $cost,
       $createdAt, $streamedAt, $completedAt, $finish, $providerState,
       $upstream, $upstreamSource, $upstreamModel, $router, $tps, $recordedAt
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
       provider_state = COALESCE(excluded.provider_state, steps.provider_state),
       upstream = COALESCE(excluded.upstream, steps.upstream),
       upstream_source = COALESCE(excluded.upstream_source, steps.upstream_source),
       upstream_model = COALESCE(excluded.upstream_model, steps.upstream_model),
       router = COALESCE(excluded.router, steps.router),
       tps = COALESCE(excluded.tps, steps.tps),
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
    $finish: record.finish ?? null,
    $providerState: jsonText(record.providerState),
    $upstream: record.upstream ?? null,
    $upstreamSource: record.upstreamSource ?? null,
    $upstreamModel: record.upstreamModel ?? null,
    $router: record.router ?? null,
    $tps: record.tps ?? null,
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
    $kind: record.kind,
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
    $directory: record.directory ?? null,
    $title: record.title ?? null,
    $startedAt: record.startedAt ?? null,
    $updatedAt: record.updatedAt ?? null,
  })
}

/** Attach the upstream evidence discovered after the step was recorded. */
export function setUpstream(db: Database, messageID: string, info: UpstreamInfo): void {
  db.query(
    `UPDATE steps
        SET upstream = COALESCE($upstream, upstream),
            upstream_source = COALESCE($source, upstream_source),
            upstream_model = COALESCE($model, upstream_model),
            router = COALESCE($router, router)
      WHERE message_id = $messageID`,
  ).run({
    $upstream: info.operator ?? null,
    $source: info.source ?? null,
    $model: info.model ?? null,
    $router: info.router ?? null,
    $messageID: messageID,
  })
}

/**
 * Apply provenance learned from a compaction to every step of that session
 * and model that still lacks an operator. Returns the number of rows touched.
 */
export function setUpstreamForSessionModel(
  db: Database,
  sessionID: string,
  modelID: string | undefined,
  info: UpstreamInfo,
): number {
  const result = db
    .query(
      `UPDATE steps
          SET upstream = COALESCE(upstream, $upstream),
              upstream_source = COALESCE(upstream_source, $source),
              upstream_model = COALESCE(upstream_model, $model),
              router = COALESCE(router, $router)
        WHERE session_id = $sessionID AND upstream IS NULL AND ($modelID IS NULL OR model_id = $modelID)`,
    )
    .run({
      $upstream: info.operator ?? null,
      $source: info.source ?? null,
      $model: info.model ?? null,
      $router: info.router ?? null,
      $sessionID: sessionID,
      $modelID: modelID ?? null,
    })
  return result.changes
}

export function recordHttpResponse(db: Database, record: HttpResponseRecord): void {
  db.query(
    `INSERT INTO http_responses (at, method, path, status, headers)
     VALUES ($at, $method, $path, $status, $headers)`,
  ).run({
    $at: record.at,
    $method: record.method ?? null,
    $path: record.path ?? null,
    $status: record.status ?? null,
    $headers: jsonText(record.headers),
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

/**
 * Load an `exportNdjson` dump back in. Rows are inserted with `OR IGNORE`, so
 * importing the same dump twice is harmless. Unknown tables are rejected.
 */
export function importNdjson(db: Database, text: string): number {
  const columns = new Map<TableName, string[]>()
  for (const table of TABLES) {
    const info = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
    columns.set(table, info.map((column) => column.name))
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
    const names = columns.get(table) ?? []
    const values = names.map((name) => row[name] ?? null)
    const placeholders = names.map(() => "?").join(", ")
    db.query(`INSERT OR IGNORE INTO ${table} (${names.join(", ")}) VALUES (${placeholders})`).run(...(values as (string | number | null)[]))
    imported += 1
  }
  return imported
}
