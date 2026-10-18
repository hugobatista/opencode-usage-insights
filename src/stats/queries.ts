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
 * Panel filters. They narrow every aggregation to one model, one endpoint or
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
   * The routing endpoint that served the request (`router`). It is the one
   * identity that answers "who ran this inference": the provider you configured
   * says where the request came from, which is evidence, not an answer.
   */
  router?: string | undefined
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
}

type UsageRow = {
  steps: number | null
  input: number | null
  cached: number | null
  cacheWrite: number | null
  output: number | null
  reasoning: number | null
  cost: number | null
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
       COALESCE(SUM(cost), 0) AS cost`

function usageFrom(row: UsageRow): Usage {
  return {
    steps: row.steps ?? 0,
    input: row.input ?? 0,
    cached: row.cached ?? 0,
    cacheWrite: row.cacheWrite ?? 0,
    output: row.output ?? 0,
    reasoning: row.reasoning ?? 0,
    cost: row.cost ?? 0,
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
  if (filters?.router !== undefined && filters.router !== "") {
    clauses.push("router = ?")
    params.push(filters.router)
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
  firstAt: number | undefined
  lastAt: number | undefined
  cacheHitRatio: number | undefined
}

export function overview(db: Database, range?: Range, filters?: Filters): Overview {
  const steps = buildWhere(range, filters)
  const row = db
    .query(
      `SELECT ${USAGE_SELECT},
              COUNT(DISTINCT session_id) AS sessions,
              MIN(${STEP_TIME}) AS firstAt,
              MAX(COALESCE(completed_at, ${STEP_TIME})) AS lastAt
       FROM steps ${steps.where}`,
    )
    .get(...steps.params) as (UsageRow & { sessions: number | null; firstAt: number | null; lastAt: number | null }) | null

  const prompts = rangeWhere(range, "created_at")
  const promptRow = db.query(`SELECT COUNT(*) AS prompts FROM prompts ${prompts.where}`).get(...prompts.params) as { prompts: number } | null

  const usage = usageFrom(row ?? { steps: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 })
  return {
    ...usage,
    sessions: row?.sessions ?? 0,
    prompts: promptRow?.prompts ?? 0,
    firstAt: row?.firstAt ?? undefined,
    lastAt: row?.lastAt ?? undefined,
    cacheHitRatio: cacheHitRatio(usage),
  }
}

export type ProviderUsage = Usage & {
  providerID: string
  /** Gateway routing endpoints that served the requests. */
  routers: string[]
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
  router_list: string | null
  first_at: number | null
  last_at: number | null
}

/**
 * Usage per model, each with the providers that served it. This is the view
 * that answers "which inference providers is this model actually coming from
 * over the selected period".
 */
export function models(db: Database, range?: Range, filters?: Filters): ModelUsage[] {
  const filter = buildWhere(range, filters)
  const rows = db
    .query(
      `SELECT provider_id, model_id, variant,
              GROUP_CONCAT(DISTINCT router) AS router_list,
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
      routers: row.router_list ? row.router_list.split(",").filter(Boolean) : [],
      firstAt: row.first_at ?? undefined,
      lastAt: row.last_at ?? undefined,
    })
    addUsage(model.totals, usage)
  }
  return [...models.values()].sort((a, b) => billedTokens(b.totals) - billedTokens(a.totals))
}

function emptyUsage(): Usage {
  return { steps: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 }
}

function addUsage(target: Usage, source: Usage): void {
  target.steps += source.steps
  target.input += source.input
  target.cached += source.cached
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.reasoning += source.reasoning
  target.cost += source.cost
}

function billedTokens(usage: Pick<Usage, "input" | "cached" | "output">): number {
  return usage.input + usage.cached + usage.output
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
              (SELECT COUNT(*) FROM prompts p WHERE p.session_id = st.session_id) AS prompts,
              COUNT(*) AS steps,
              COALESCE(SUM(st.input_tokens), 0) AS input,
              COALESCE(SUM(st.cache_read), 0) AS cached,
              COALESCE(SUM(st.cache_write), 0) AS cacheWrite,
              COALESCE(SUM(st.output_tokens), 0) AS output,
              COALESCE(SUM(st.reasoning_tokens), 0) AS reasoning,
              COALESCE(SUM(st.cost), 0) AS cost,
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

  return rows.map((row) => {
    const usage = usageFrom(row)
    return {
      ...usage,
      sessionID: row.session_id,
      parentID: row.parent_id ?? undefined,
      title: row.title ?? undefined,
      directory: row.directory ?? undefined,
      providers: row.providers ? row.providers.split(",").filter(Boolean) : [],
      models: row.models ? row.models.split(",").filter(Boolean) : [],
      prompts: row.prompts ?? 0,
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
  /** Time between the previous prompt of the session and this turn's prompt. */
  promptGapMs: number | undefined
  providerID: string | undefined
  modelID: string | undefined
  variant: string | undefined
  router: string | undefined
  /** The displayed identity differs from the previous turn of the session. */
  routerChanged: boolean
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
  created_at: number | null
  recorded_at: number
  completed_at: number | null
  finish: string | null
  router: string | null
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
 * For one session the read is bounded by a window: only the steps at or after
 * the `limit`-th newest prompt are loaded, so a session with tens of thousands
 * of steps costs the same as a short one. The extra prompt is kept as the
 * reference the oldest returned turn measures its gap against.
 */
export function turns(
  db: Database,
  options?: { sessionID?: string | undefined; range?: Range | undefined; filters?: Filters | undefined; limit?: number | undefined },
): TurnUsage[] {
  const limit = options?.limit ?? 50
  const filter = buildWhere(options?.range, options?.filters)
  const clauses = filter.where === "" ? [] : [filter.where.slice("WHERE ".length)]
  const params: (number | string)[] = [...filter.params]
  if (options?.sessionID !== undefined) {
    clauses.push("session_id = ?")
    params.push(options.sessionID)
  }
  const floor = options?.sessionID === undefined ? undefined : promptFloor(db, options.sessionID, limit + 1)
  if (floor !== undefined) {
    clauses.push(`${STEP_TIME} >= ?`)
    params.push(floor)
  }
  const steps = db
    .query(
      `SELECT message_id, session_id, provider_id, model_id, variant,
              input_tokens, cache_read, cache_write, output_tokens, reasoning_tokens, cost,
              created_at, recorded_at, completed_at, finish, router
         FROM steps ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY session_id, ${STEP_TIME}`,
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
  let previousPromptAt: number | undefined

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
    const lastWith = <Value>(pick: (row: TurnStepRow) => Value | null): Value | undefined => {
      for (let index = bucket.length - 1; index >= 0; index -= 1) {
        const value = pick(bucket[index]!)
        if (value !== null) return value
      }
      return undefined
    }
    const providerID = last.provider_id ?? undefined
    const modelID = last.model_id ?? undefined
    const variant = last.variant ?? undefined
    const router = lastWith((row) => row.router)
    const previous = result.length > 0 && result[result.length - 1]!.sessionID === last.session_id ? result[result.length - 1] : undefined
    result.push({
      sessionID: last.session_id,
      promptAt,
      endAt: last.completed_at ?? last.created_at ?? last.recorded_at,
      promptGapMs: promptAt !== undefined && previousPromptAt !== undefined ? Math.max(0, promptAt - previousPromptAt) : undefined,
      providerID,
      modelID,
      variant,
      router,
      routerChanged: previous?.router !== undefined && router !== undefined && previous.router !== router,
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
    })
    bucket = []
  }

  for (const row of steps) {
    if (row.session_id !== sessionID) {
      close()
      sessionID = row.session_id
      promptIndex = -2
      promptAt = undefined
      previousPromptAt = undefined
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
      previousPromptAt = index >= 1 ? prompts[index - 1] : undefined
    }
    bucket.push(row)
  }
  close()

  return result.reverse().slice(0, limit)
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

/**
 * Routing endpoint of the newest step recorded before `at`. The TUI compares
 * it with the endpoint of the turn it is about to render, because the same
 * provider and model can be routed to a different endpoint per request.
 */
export function routerBefore(db: Database, sessionID: string, at: number | undefined): string | undefined {
  if (at === undefined) return undefined
  const row = db
    .query(
      `SELECT router FROM steps
        WHERE session_id = $sessionID AND router IS NOT NULL AND COALESCE(created_at, recorded_at) < $at
        ORDER BY COALESCE(created_at, recorded_at) DESC LIMIT 1`,
    )
    .get({ $sessionID: sessionID, $at: at }) as { router: string | null } | null
  return row?.router ?? undefined
}

/**
 * Routing endpoint of the newest step recorded for a session+model pair. The
 * TUI reads this for the telemetry line because the line renders from the TUI
 * process while the recorder (the server process) is still writing the step
 * that just finished.
 */
export function latestRouter(db: Database, sessionID: string, modelID: string): string | undefined {
  const row = db
    .query(
      `SELECT router FROM steps
        WHERE session_id = $sessionID AND model_id = $modelID AND router IS NOT NULL
        ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get({ $sessionID: sessionID, $modelID: modelID }) as { router: string | null } | null
  return row?.router ?? undefined
}

// ---------------------------------------------------------------------------
// Filter pickers
// ---------------------------------------------------------------------------

export type FilterOption = { value: string; steps: number }

/** Distinct models and endpoints, most used first. */
export function filterOptions(db: Database): { models: FilterOption[]; endpoints: FilterOption[] } {
  const pick = (column: string): FilterOption[] =>
    (
      db
        .query(`SELECT ${column} AS value, COUNT(*) AS steps FROM steps WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY steps DESC`)
        .all() as { value: string; steps: number }[]
    ).map((row) => ({ value: row.value, steps: row.steps }))
  return { models: pick("model_id"), endpoints: pick("router") }
}
