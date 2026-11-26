import type { Database } from "bun:sqlite"
import { cacheDrop, stepGap, tokensPerSecond, type AssistantMessage } from "../core"

/**
 * Read side of the stats engine: every function takes an open database and
 * returns plain rows for the TUI panel, the report script and the NDJSON
 * exports. Aggregations stay in SQL; comparisons and percentiles that would
 * need window functions or custom SQLite builds are computed in JS.
 */

/** Event kind written by the recorder when a compaction completes. */
export const COMPACTION_KIND = "compaction"

/**
 * Idle gap above which a cache reuse loss is attributed to provider-side
 * expiry rather than to a mid-session event. Heuristic: the empirical TTL
 * evidence view narrows this down with real observations.
 */
export const DEFAULT_TTL_HINT_MS = 10 * 60 * 1000

export type Range = {
  from?: number | undefined
  to?: number | undefined
}

/**
 * Panel filters. They narrow every aggregation to one model, one provider or
 * one session, and are applied with the same `WHERE` builder the range uses so
 * a filtered view and a drill-down agree.
 */
export type Filters = {
  /** Model id, variant excluded. */
  modelID?: string | undefined
  /**
   * One model *and* its variant, as `modelKey` builds it (`m1#max`). A variant
   * is a different model to the provider, so a drill-down into one variant must
   * not pick up its family.
   */
  modelKey?: string | undefined
  /**
   * The provider the model ran through, as OpenCode configured it
   * (`opencode-go`, `deepseek`, `deepinfra`). It is the identity every view
   * groups by: a gateway may re-route the request, but the upstream that
   * actually ran it is not observable.
   */
  provider?: string | undefined
  /**
   * One session, exactly. Used by the `session` range and by the overview's
   * "this session" block, which must not pick up the steps of every other
   * session that happened to run after it started.
   */
  sessionID?: string | undefined
}

export type Usage = {
  steps: number
  input: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
  cost: number
  /** List-price estimate for steps the host reported as costing nothing. */
  listCost: number
}

/**
 * What the selection costs: charged money plus the list-price estimate of the
 * steps the host reported as free. Display code marks the estimated part.
 */
export function spend(usage: Pick<Usage, "cost" | "listCost">): number {
  return usage.cost + usage.listCost
}

/** True when at least one step in the aggregate is an estimate. */
export function hasEstimate(usage: Pick<Usage, "listCost">): boolean {
  return usage.listCost > 0
}

/**
 * The list-price estimate of one session, from the steps the plugin recorded.
 * The live line uses it for the `sess` segment; a session with no recorded
 * estimate (or a database without the column) answers 0.
 */
export function sessionListCost(db: Database, sessionID: string): number {
  const row = db
    .query("SELECT COALESCE(SUM(list_cost), 0) AS listCost FROM steps WHERE session_id = ?")
    .get(sessionID) as { listCost: number | null } | null
  return row?.listCost ?? 0
}

/**
 * Money the host reported with no assistant step behind it: a compaction
 * summary or a generated title. It is part of the session's own cost, so the
 * totals that claim to describe a session include it.
 */
export type OtherUsage = {
  /** Host usage records behind the number. */
  entries: number
  cost: number
}

export const EMPTY_OTHER: OtherUsage = { entries: 0, cost: 0 }

/** True when the database has the table the non-step usage lives in. */
function hasUsageTable(db: Database): boolean {
  try {
    return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage'").get() !== null
  } catch {
    return false
  }
}

/**
 * `WHERE` for non-step usage. A model or provider filter cannot be honored:
 * the host usage record carries neither, so including it under a filter would
 * attribute money to a model that did not earn it. A session filter can: the
 * row is the session's.
 */
function otherWhere(
  range: Range | undefined,
  filters?: Filters | undefined,
): { where: string; params: (string | number)[] } | undefined {
  if (filters?.modelID !== undefined && filters.modelID !== "") return undefined
  if (filters?.modelKey !== undefined && filters.modelKey !== "") return undefined
  if (filters?.provider !== undefined && filters.provider !== "") return undefined
  const span = rangeWhere(range, "at")
  const clauses = span.where === "" ? [] : [span.where.slice("WHERE ".length)]
  const params: (string | number)[] = [...span.params]
  if (filters?.sessionID !== undefined && filters.sessionID !== "") {
    clauses.push("session_id = ?")
    params.push(filters.sessionID)
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

/** Non-step usage in the selection. */
export function otherUsage(db: Database, range?: Range | undefined, filters?: Filters | undefined): OtherUsage {
  const filter = otherWhere(range, filters)
  if (filter === undefined || !hasUsageTable(db)) return { ...EMPTY_OTHER }
  try {
    const row = db
      .query(`SELECT COUNT(*) AS entries, COALESCE(SUM(cost), 0) AS cost FROM usage ${filter.where}`)
      .get(...filter.params) as { entries: number | null; cost: number | null } | null
    return { entries: row?.entries ?? 0, cost: row?.cost ?? 0 }
  } catch {
    return { ...EMPTY_OTHER }
  }
}

/** Non-step usage per session, for the session rows. */
export function otherUsageBySession(db: Database, range?: Range | undefined, filters?: Filters | undefined): Map<string, OtherUsage> {
  const out = new Map<string, OtherUsage>()
  const filter = otherWhere(range, filters)
  if (filter === undefined || !hasUsageTable(db)) return out
  try {
    const rows = db
      .query(
        `SELECT session_id AS sessionID, COUNT(*) AS entries, COALESCE(SUM(cost), 0) AS cost
           FROM usage ${filter.where}
          GROUP BY session_id`,
      )
      .all(...filter.params) as Array<{ sessionID: string; entries: number | null; cost: number | null }>
    for (const row of rows) out.set(row.sessionID, { entries: row.entries ?? 0, cost: row.cost ?? 0 })
  } catch {
    // An older database has no usage table: step totals alone are still valid.
  }
  return out
}

export type OtherUsageRow = {
  sessionID: string
  at: number
  cost: number
}

/**
 * Non-step usage as one row per host record, so calendar buckets can fold it
 * into their periods with the same local-time rule the steps use.
 */
export function otherUsageRows(db: Database, range?: Range | undefined, filters?: Filters | undefined): OtherUsageRow[] {
  const filter = otherWhere(range, filters)
  if (filter === undefined || !hasUsageTable(db)) return []
  const where = filter.where === "" ? "WHERE at IS NOT NULL" : `${filter.where} AND at IS NOT NULL`
  try {
    return db
      .query(`SELECT session_id AS sessionID, at, cost FROM usage ${where} ORDER BY at`)
      .all(...filter.params) as OtherUsageRow[]
  } catch {
    return []
  }
}

type UsageRow = {
  steps: number | null
  input: number | null
  cached: number | null
  cacheWrite: number | null
  output: number | null
  reasoning: number | null
  cost: number | null
  listCost: number | null
}

export const STEP_TIME = "COALESCE(created_at, recorded_at)"

/**
 * The identity of a model *and* its variant, in SQL: `modelKey` says a variant
 * is a different model to the provider, so a variant never shares a row with
 * its family. The JS twin is `modelKey` below; both have to agree.
 */
export const MODEL_KEY_SQL = "COALESCE(model_id, '(unknown)') || '#' || COALESCE(variant, '')"

/** `modelKey(modelID, variant)`: the family, with the variant as a suffix. */
export function modelKey(modelID: string, variant: string | undefined): string {
  return `${modelID}#${variant ?? ""}`
}

/** Human label of a model key or a model id and variant. */
export function modelLabel(modelID: string, variant: string | undefined): string {
  return variant === undefined ? modelID : `${modelID} ${variant}`
}
const USAGE_SELECT = `COUNT(*) AS steps,
       COALESCE(SUM(input_tokens), 0) AS input,
       COALESCE(SUM(cache_read), 0) AS cached,
       COALESCE(SUM(cache_write), 0) AS cacheWrite,
       COALESCE(SUM(output_tokens), 0) AS output,
       COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
       COALESCE(SUM(cost), 0) AS cost,
       COALESCE(SUM(list_cost), 0) AS listCost`

function usageFrom(row: UsageRow): Usage {
  return {
    steps: row.steps ?? 0,
    input: row.input ?? 0,
    cached: row.cached ?? 0,
    cacheWrite: row.cacheWrite ?? 0,
    output: row.output ?? 0,
    reasoning: row.reasoning ?? 0,
    cost: row.cost ?? 0,
    listCost: row.listCost ?? 0,
  }
}

function rangeWhere(range: Range | undefined, column = STEP_TIME): { where: string; params: number[] } {
  const clauses: string[] = []
  const params: number[] = []
  if (range?.from !== undefined) {
    clauses.push(`${column} >= ?`)
    params.push(range.from)
  }
  if (range?.to !== undefined) {
    clauses.push(`${column} < ?`)
    params.push(range.to)
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

/**
 * `WHERE` for a range plus the panel filters. Shared with the analysis layer so
 * a filtered view and a drill-down agree on what is in scope.
 */
export function buildWhere(
  range: Range | undefined,
  filters?: Filters | undefined,
  column = STEP_TIME,
): { where: string; params: (string | number)[] } {
  const rangeClause = rangeWhere(range, column)
  const clauses = rangeClause.where === "" ? [] : [rangeClause.where.slice("WHERE ".length)]
  const params: (string | number)[] = [...rangeClause.params]
  if (filters?.modelID !== undefined && filters.modelID !== "") {
    clauses.push("model_id = ?")
    params.push(filters.modelID)
  }
  if (filters?.modelKey !== undefined && filters.modelKey !== "") {
    clauses.push(`${MODEL_KEY_SQL} = ?`)
    params.push(filters.modelKey)
  }
  if (filters?.provider !== undefined && filters.provider !== "") {
    clauses.push("provider_id = ?")
    params.push(filters.provider)
  }
  if (filters?.sessionID !== undefined && filters.sessionID !== "") {
    clauses.push("session_id = ?")
    params.push(filters.sessionID)
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params }
}

/**
 * Share of the whole prompt that came from the cache. The denominator is what
 * the provider saw: cache reads, fresh input and cache writes.
 */
export function cacheHitRatio(usage: Pick<Usage, "input" | "cached" | "cacheWrite">): number | undefined {
  const total = usage.cached + usage.input + usage.cacheWrite
  return total > 0 ? usage.cached / total : undefined
}

export type Overview = Usage & {
  sessions: number
  prompts: number
  /** Compaction/title money included in `cost`, when the range has any. */
  otherCost?: number | undefined
  firstAt: number | undefined
  lastAt: number | undefined
  cacheHitRatio: number | undefined
  /**
   * Tokens generated per second of streaming, over the whole selection: the
   * produced tokens divided by the summed streaming windows. A weighted average,
   * not the mean of the per-step rates the latency view reports as p50.
   */
  tps: number | undefined
}

export function overview(db: Database, range?: Range, filters?: Filters): Overview {
  const steps = buildWhere(range, filters)
  const row = db
    .query(
      `SELECT ${USAGE_SELECT},
              COUNT(DISTINCT session_id) AS sessions,
              MIN(${STEP_TIME}) AS firstAt,
              MAX(COALESCE(completed_at, ${STEP_TIME})) AS lastAt,
              COALESCE(SUM(CASE WHEN streamed_at > created_at THEN output_tokens + reasoning_tokens ELSE 0 END), 0) AS produced,
              COALESCE(SUM(CASE WHEN streamed_at > created_at THEN streamed_at - created_at ELSE 0 END), 0) AS window
       FROM steps ${steps.where}`,
    )
    .get(...steps.params) as
    | (UsageRow & { sessions: number | null; firstAt: number | null; lastAt: number | null; produced: number | null; window: number | null })
    | null

  const prompts = rangeWhere(range, "created_at")
  const promptClauses = prompts.where === "" ? [] : [prompts.where.slice("WHERE ".length)]
  const promptParams: (string | number)[] = [...prompts.params]
  // The session block asks for one session: a prompt has no model, so the
  // session filter is the one that can be honored here. Ignoring it counted
  // every prompt in the range, including those of other sessions.
  if (filters?.sessionID !== undefined && filters.sessionID !== "") {
    promptClauses.push("session_id = ?")
    promptParams.push(filters.sessionID)
  }
  const promptWhere = promptClauses.length > 0 ? `WHERE ${promptClauses.join(" AND ")}` : ""
  const promptRow = db.query(`SELECT COUNT(*) AS prompts FROM prompts ${promptWhere}`).get(...promptParams) as {
    prompts: number
  } | null

  const usage = usageFrom(row ?? { steps: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, listCost: 0 })
  const other = otherUsage(db, range, filters)
  return {
    ...usage,
    // The host's session cost includes compactions and titles; a total that
    // claims to describe the selection has to include them too. Tokens stay
    // step-based so the cache views keep comparing like with like.
    cost: usage.cost + other.cost,
    sessions: row?.sessions ?? 0,
    prompts: promptRow?.prompts ?? 0,
    otherCost: other.cost,
    firstAt: row?.firstAt ?? undefined,
    lastAt: row?.lastAt ?? undefined,
    cacheHitRatio: cacheHitRatio(usage),
    tps: row === null ? undefined : tokensPerSecond(row.produced ?? 0, 0, row.window ?? 0),
  }
}

export type ProviderUsage = Usage & {
  providerID: string
  firstAt: number | undefined
  lastAt: number | undefined
}

export type ModelUsage = {
  modelID: string
  variant: string | undefined
  providers: ProviderUsage[]
  totals: Usage
}

type ModelRow = UsageRow & {
  provider_id: string | null
  model_id: string | null
  variant: string | null
  first_at: number | null
  last_at: number | null
}

/**
 * Usage per model, each with the providers that served it. This is the view
 * that answers "through which provider is this model actually coming, over the
 * selected period".
 */
export function models(db: Database, range?: Range, filters?: Filters): ModelUsage[] {
  const filter = buildWhere(range, filters)
  const rows = db
    .query(
      `SELECT provider_id, model_id, variant,
              ${USAGE_SELECT},
              MIN(${STEP_TIME}) AS first_at,
              MAX(COALESCE(completed_at, recorded_at)) AS last_at
       FROM steps ${filter.where}
       GROUP BY provider_id, model_id, variant
       ORDER BY steps DESC, cached DESC`,
    )
    .all(...filter.params) as ModelRow[]

  const models = new Map<string, ModelUsage>()
  for (const row of rows) {
    const modelID = row.model_id ?? "(unknown)"
    const variant = row.variant ?? undefined
    const key = `${modelID}#${variant ?? ""}`
    let model = models.get(key)
    if (!model) {
      model = { modelID, variant, providers: [], totals: emptyUsage() }
      models.set(key, model)
    }
    const usage = usageFrom(row)
    model.providers.push({
      ...usage,
      providerID: row.provider_id ?? "(unknown)",
      firstAt: row.first_at ?? undefined,
      lastAt: row.last_at ?? undefined,
    })
    addUsage(model.totals, usage)
  }
  return [...models.values()].sort((a, b) => billedTokens(b.totals) - billedTokens(a.totals))
}

function emptyUsage(): Usage {
  return { steps: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0, listCost: 0 }
}

function addUsage(target: Usage, source: Usage): void {
  target.steps += source.steps
  target.input += source.input
  target.cached += source.cached
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.reasoning += source.reasoning
  target.cost += source.cost
  target.listCost += source.listCost
}

/**
 * Every bucket a provider bills for: the whole prompt (fresh input, cache
 * reads and writes) plus visible output and reasoning. Leaving `cacheWrite`
 * or `reasoning` out ranked a model with heavy cache writes or thinking below
 * one with more visible output, which is not what "most tokens" means.
 */
function billedTokens(usage: Pick<Usage, "input" | "cached" | "cacheWrite" | "output" | "reasoning">): number {
  return usage.input + usage.cached + usage.cacheWrite + usage.output + usage.reasoning
}

export type TimelineBucket = { at: number } & Usage

/** Usage aggregated into fixed time buckets (for example one hour or day). */
export function timeline(db: Database, range: Range | undefined, bucketMs: number): TimelineBucket[] {
  const filter = rangeWhere(range)
  const rows = db
    .query(
      `SELECT CAST(${STEP_TIME} / ? AS INTEGER) * ? AS bucket, ${USAGE_SELECT}
       FROM steps ${filter.where}
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all(bucketMs, bucketMs, ...filter.params) as (UsageRow & { bucket: number })[]
  return rows.map((row) => ({ at: row.bucket, ...usageFrom(row) }))
}

export type DropReason = "compaction" | "expired" | "unknown"

export type CacheDropRow = {
  sessionID: string
  messageID: string
  providerID: string | undefined
  modelID: string | undefined
  variant: string | undefined
  at: number
  tokens: number
  gapMs: number | undefined
  prevCached: number
  reason: DropReason
}

export type TtlEvidenceRow = {
  providerID: string
  modelID: string
  samples: number
  /** Largest idle gap that still hit the cache. */
  maxHitGapMs: number | undefined
  /** Smallest idle gap after which reuse was lost. */
  minDropGapMs: number | undefined
}

export type LatencyStats = {
  count: number
  p50: number | undefined
  p90: number | undefined
  p99: number | undefined
}

export type LatencyReport = {
  /** Milliseconds from request to completed response. */
  wall: LatencyStats
  /** Milliseconds from request to the last streamed chunk (the streaming window). */
  stream: LatencyStats
  /** Output-plus-reasoning tokens per second over that window. */
  tps: LatencyStats
}

/** Nearest-rank percentile over an unsorted sample. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index]
}

export function latencyStats(values: number[]): LatencyStats {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
  }
}

const statsFor = latencyStats

export type SessionUsage = Usage & {
  sessionID: string
  parentID: string | undefined
  title: string | undefined
  directory: string | undefined
  providers: string[]
  models: string[]
  prompts: number
  /** Compaction/title money included in `cost`, when the session has any. */
  otherCost?: number | undefined
  firstAt: number | undefined
  lastAt: number | undefined
  cacheHitRatio: number | undefined
}

export function sessions(
  db: Database,
  options?: { range?: Range; filters?: Filters; limit?: number; sessionIDs?: readonly string[] },
): SessionUsage[] {
  if (options?.sessionIDs !== undefined && options.sessionIDs.length === 0) return []
  const range = options?.range
  const filter = buildWhere(range, options?.filters, "COALESCE(st.created_at, st.recorded_at)")
  const limit = options?.limit ?? 20
  const clauses = filter.where === "" ? [] : [filter.where.slice("WHERE ".length)]
  const params: (number | string)[] = [...filter.params]
  // The session row is for a range, so its prompt count has to be for that
  // range too: a 7-day row must not show the prompts of the session's whole
  // history. The placeholders sit in the SELECT list, before the WHERE ones.
  const promptRange: string[] = []
  const promptParams: number[] = []
  if (range?.from !== undefined) {
    promptRange.push("p.created_at >= ?")
    promptParams.push(range.from)
  }
  if (range?.to !== undefined) {
    promptRange.push("p.created_at < ?")
    promptParams.push(range.to)
  }
  const promptClause = promptRange.length > 0 ? ` AND ${promptRange.join(" AND ")}` : ""
  if (options?.sessionIDs !== undefined) {
    // A specific set of sessions (the subagents of one session): the group by
    // then reads one index range per session instead of every step recorded.
    const ids = options.sessionIDs.slice(0, 500)
    clauses.push(`st.session_id IN (${ids.map(() => "?").join(", ")})`)
    params.push(...ids)
  }
  const rows = db
    .query(
      `SELECT st.session_id, s.title, s.directory, s.parent_id,
              GROUP_CONCAT(DISTINCT st.provider_id) AS providers,
              GROUP_CONCAT(DISTINCT st.model_id) AS models,
              (SELECT COUNT(*) FROM prompts p WHERE p.session_id = st.session_id${promptClause}) AS prompts,
              COUNT(*) AS steps,
              COALESCE(SUM(st.input_tokens), 0) AS input,
              COALESCE(SUM(st.cache_read), 0) AS cached,
              COALESCE(SUM(st.cache_write), 0) AS cacheWrite,
              COALESCE(SUM(st.output_tokens), 0) AS output,
              COALESCE(SUM(st.reasoning_tokens), 0) AS reasoning,
              COALESCE(SUM(st.cost), 0) AS cost,
              COALESCE(SUM(st.list_cost), 0) AS listCost,
              MIN(COALESCE(st.created_at, st.recorded_at)) AS first_at,
              MAX(COALESCE(st.completed_at, st.created_at, st.recorded_at)) AS last_at
       FROM steps st
       LEFT JOIN sessions s ON s.session_id = st.session_id
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       GROUP BY st.session_id
       ORDER BY last_at DESC
       LIMIT ?`,
    )
    .all(
      ...promptParams,
      ...params,
      limit,
    ) as (UsageRow & {
    session_id: string
    title: string | null
    directory: string | null
    parent_id: string | null
    providers: string | null
    models: string | null
    prompts: number | null
    first_at: number | null
    last_at: number | null
  })[]

  // The host's session cost includes compactions and titles; the session row
  // has to include them too, or it disagrees with the line's `sess` segment.
  const other = otherUsageBySession(db, range, options?.filters)
  return rows.map((row) => {
    const usage = usageFrom(row)
    const extra = other.get(row.session_id)?.cost ?? 0
    return {
      ...usage,
      cost: usage.cost + extra,
      sessionID: row.session_id,
      parentID: row.parent_id ?? undefined,
      title: row.title ?? undefined,
      directory: row.directory ?? undefined,
      providers: row.providers ? row.providers.split(",").filter(Boolean) : [],
      models: row.models ? row.models.split(",").filter(Boolean) : [],
      prompts: row.prompts ?? 0,
      otherCost: extra,
      firstAt: row.first_at ?? undefined,
      lastAt: row.last_at ?? undefined,
      cacheHitRatio: cacheHitRatio(usage),
    }
  })
}

/** Sessions whose parent is `parentID`: the subagents of one session. */
export function childSessionIDs(db: Database, parentID: string): string[] {
  return (db.query("SELECT session_id FROM sessions WHERE parent_id = ? ORDER BY session_id").all(parentID) as { session_id: string }[]).map(
    (row) => row.session_id,
  )
}

/** Session usage rows for a specific set of sessions (subagent rollups). */
export function sessionUsageOf(db: Database, sessionIDs: readonly string[]): SessionUsage[] {
  return sessions(db, { sessionIDs, limit: sessionIDs.length })
}

export type TurnDrop = {
  messageID: string
  tokens: number
  gapMs: number | undefined
}

/**
 * One finished turn of a session, built from the recorded steps and prompts. It
 * carries the same buckets the telemetry line uses, so the panel can render the
 * per-prompt history with the line's own formatter.
 */
export type TurnUsage = {
  sessionID: string
  /** Creation time of the prompt that opened the turn, when it was recorded. */
  promptAt: number | undefined
  endAt: number | undefined
  /**
   * Wall time of the turn's execution: the first step's request to the last
   * step's completion. Tool-call gaps inside the turn are included; time spent
   * queued before the first request is not.
   */
  durationMs: number | undefined
  /** Time between the previous finished turn's prompt and this turn's prompt. */
  promptGapMs: number | undefined
  providerID: string | undefined
  modelID: string | undefined
  variant: string | undefined
  providerChanged: boolean
  modelChanged: boolean
  steps: number
  /** Raw buckets of the last step: the prompt the turn ended with. */
  latest: Usage
  /** Raw buckets summed over every step of the turn. */
  totals: Usage
  drops: TurnDrop[]
  /** Finish reason of the turn's last step. */
  finish: string | undefined
  /**
   * Tokens generated per second of streaming over the turn's steps: produced
   * tokens divided by their summed streaming windows. For a one-step turn it is
   * that step's rate.
   */
  tps: number | undefined
}

type TurnStepRow = {
  message_id: string
  session_id: string
  provider_id: string | null
  model_id: string | null
  variant: string | null
  input_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cost: number | null
  list_cost: number | null
  created_at: number | null
  streamed_at: number | null
  recorded_at: number
  completed_at: number | null
  finish: string | null
}

/** A turn is finished when its last step ended without asking for more tools. */
function turnFinished(finish: string | null): boolean {
  return finish !== null && finish !== "" && finish !== "tool-calls"
}

function stepUsage(row: TurnStepRow): Usage {
  return {
    steps: 1,
    input: row.input_tokens ?? 0,
    cached: row.cache_read ?? 0,
    cacheWrite: row.cache_write ?? 0,
    output: row.output_tokens ?? 0,
    reasoning: row.reasoning_tokens ?? 0,
    cost: row.cost ?? 0,
    listCost: row.list_cost ?? 0,
  }
}

/** Structural view of a recorded step, so the shared cache-drop rule applies. */
function stepMessage(row: TurnStepRow): AssistantMessage {
  return {
    type: "assistant",
    id: row.message_id,
    time: { created: row.created_at ?? row.recorded_at, completed: row.completed_at ?? undefined },
    model:
      row.provider_id !== null && row.model_id !== null
        ? { providerID: row.provider_id, id: row.model_id, variant: row.variant ?? undefined }
        : undefined,
    tokens: {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      reasoning: row.reasoning_tokens ?? 0,
      cache: { read: row.cache_read ?? 0, write: row.cache_write ?? 0 },
    },
    finish: row.finish ?? undefined,
  }
}

/**
 * Finished turns, newest first. Steps belong to the newest prompt recorded at or
 * before them; a turn whose last step asked for tools is dropped, because it is
 * still running — the same rule the telemetry line follows.
 *
 * For one session the read is bounded by a window of the newest prompts. The
 * window grows until it holds `limit` finished turns: a prompt can be empty
 * (the host records a synthetic system-reminder next to the user prompt) and
 * the newest turn can still be running, so a fixed one-prompt margin is not
 * enough. `complete` means the window covers every prompt of the session.
 */
export function turns(
  db: Database,
  options?: { sessionID?: string | undefined; range?: Range | undefined; filters?: Filters | undefined; limit?: number | undefined },
): TurnUsage[] {
  const requested = options?.limit ?? 50
  const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 50
  const filter = buildWhere(options?.range, options?.filters)
  const baseClauses = filter.where === "" ? [] : [filter.where.slice("WHERE ".length)]
  const baseParams: (number | string)[] = [...filter.params]
  if (options?.sessionID !== undefined) {
    baseClauses.push("session_id = ?")
    baseParams.push(options.sessionID)
  }

  /** Read the turns inside the given prompt window, newest first. */
  function read(promptCount: number): { rows: TurnUsage[]; complete: boolean } {
    const clauses = [...baseClauses]
    const params = [...baseParams]
    const floor = options?.sessionID === undefined ? undefined : promptFloor(db, options.sessionID, promptCount)
    if (floor !== undefined) {
      clauses.push(`${STEP_TIME} >= ?`)
      params.push(floor)
    }
    const steps = db
      .query(
        `SELECT message_id, session_id, provider_id, model_id, variant,
                input_tokens, cache_read, cache_write, output_tokens, reasoning_tokens, cost, list_cost,
                created_at, streamed_at, recorded_at, completed_at, finish
           FROM steps ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
          ORDER BY session_id, ${STEP_TIME}, message_id`,
      )
      .all(...params) as TurnStepRow[]

    const promptClause = options?.sessionID === undefined ? "" : `WHERE session_id = ?${floor === undefined ? "" : " AND created_at >= ?"}`
    const promptParams = options?.sessionID === undefined ? [] : floor === undefined ? [options.sessionID] : [options.sessionID, floor]
    const promptRows = db
      .query(`SELECT session_id, created_at FROM prompts ${promptClause} ORDER BY session_id, created_at`)
      .all(...promptParams) as { session_id: string; created_at: number | null }[]

    const promptsBySession = new Map<string, number[]>()
    for (const row of promptRows) {
      if (row.created_at === null) continue
      const list = promptsBySession.get(row.session_id) ?? []
      list.push(row.created_at)
      promptsBySession.set(row.session_id, list)
    }

    const result: TurnUsage[] = []
    let sessionID: string | undefined
    let bucket: TurnStepRow[] = []
    let promptIndex = -2
    let promptAt: number | undefined

    function close(): void {
      const last = bucket[bucket.length - 1]
      if (last === undefined || !turnFinished(last.finish)) {
        bucket = []
        return
      }
      const totals = emptyUsage()
      for (const row of bucket) addUsage(totals, stepUsage(row))
      const drops: TurnDrop[] = []
      let reference: AssistantMessage | undefined
      for (const row of bucket) {
        const message = stepMessage(row)
        const drop = cacheDrop(reference, message)
        if (drop !== undefined) {
          drops.push({ messageID: row.message_id, tokens: drop, gapMs: stepGap(reference, message) })
        }
        reference = message
      }
      const providerID = last.provider_id ?? undefined
      const modelID = last.model_id ?? undefined
      const variant = last.variant ?? undefined
      let produced = 0
      let window = 0
      for (const row of bucket) {
        if (row.created_at === null || row.streamed_at === null || row.streamed_at <= row.created_at) continue
        produced += (row.output_tokens ?? 0) + (row.reasoning_tokens ?? 0)
        window += row.streamed_at - row.created_at
      }
      const previous = result.length > 0 && result[result.length - 1]!.sessionID === last.session_id ? result[result.length - 1] : undefined
      const endAt = last.completed_at ?? last.created_at ?? last.recorded_at
      // A turn starts when the first request goes out; a step recorded without
      // its own start stamp falls back to the prompt that opened the turn.
      const firstAt = bucket[0]?.created_at ?? promptAt
      result.push({
        sessionID: last.session_id,
        promptAt,
        endAt,
        durationMs: firstAt !== undefined && endAt > firstAt ? endAt - firstAt : undefined,
        // The gap is against the previous *turn*, not the previous prompt row:
        // a synthetic system-reminder prompt can sit between two user turns.
        promptGapMs: promptAt !== undefined && previous?.promptAt !== undefined ? Math.max(0, promptAt - previous.promptAt) : undefined,
        providerID,
        modelID,
        variant,
        providerChanged: previous?.providerID !== undefined && providerID !== undefined && previous.providerID !== providerID,
        modelChanged:
          previous !== undefined &&
          previous.providerID === providerID &&
          `${previous.modelID ?? ""}#${previous.variant ?? ""}` !== `${modelID ?? ""}#${variant ?? ""}`,
        steps: bucket.length,
        latest: stepUsage(last),
        totals,
        drops,
        finish: last.finish ?? undefined,
        tps: tokensPerSecond(produced, 0, window),
      })
      bucket = []
    }

    for (const row of steps) {
      if (row.session_id !== sessionID) {
        close()
        sessionID = row.session_id
        promptIndex = -2
        promptAt = undefined
      }
      const time = row.created_at ?? row.recorded_at
      const prompts = promptsBySession.get(row.session_id) ?? []
      let index = -1
      for (let candidate = prompts.length - 1; candidate >= 0; candidate -= 1) {
        if ((prompts[candidate] ?? Number.POSITIVE_INFINITY) <= time) {
          index = candidate
          break
        }
      }
      if (index !== promptIndex) {
        close()
        promptIndex = index
        promptAt = index >= 0 ? prompts[index] : undefined
      }
      bucket.push(row)
    }
    close()

    // Once the window reaches a prompt at or before the range's start, no older
    // prompt can be the newest one before a step inside the range: the window
    // already covers every turn the range can contain.
    const reachedRangeStart = options?.range?.from !== undefined && floor !== undefined && floor <= options.range.from
    return { rows: result.reverse(), complete: floor === undefined || reachedRangeStart }
  }

  let promptCount = Math.max(1, limit + 1)
  for (;;) {
    const { rows, complete } = read(promptCount)
    if (rows.length >= limit || complete) return rows.slice(0, limit)
    const next = promptCount * 2 + 1
    if (!Number.isFinite(next) || next <= promptCount) return rows.slice(0, limit)
    promptCount = next
  }
}

/**
 * Creation time of the `count`-th newest prompt of a session, or undefined
 * when it has fewer. Used to bound the steps a `turns` read has to load.
 */
function promptFloor(db: Database, sessionID: string, count: number): number | undefined {
  const rows = db
    .query("SELECT created_at FROM prompts WHERE session_id = ? AND created_at IS NOT NULL ORDER BY created_at DESC LIMIT ?")
    .all(sessionID, count) as { created_at: number }[]
  return rows.length === count ? rows[count - 1]!.created_at : undefined
}

// ---------------------------------------------------------------------------
// Filter pickers
// ---------------------------------------------------------------------------

export type FilterOption = { value: string; steps: number }

/** Distinct models and providers, most used first. */
export function filterOptions(db: Database): { models: FilterOption[]; providers: FilterOption[] } {
  const pick = (column: string): FilterOption[] =>
    (
      db
        .query(`SELECT ${column} AS value, COUNT(*) AS steps FROM steps WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY steps DESC`)
        .all() as { value: string; steps: number }[]
    ).map((row) => ({ value: row.value, steps: row.steps }))
  return { models: pick("model_id"), providers: pick("provider_id") }
}
