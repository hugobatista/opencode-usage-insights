import type { Database } from "bun:sqlite"
import { cacheDrop, stepGap, tokensPerSecond, type AssistantMessage } from "../core"
import type { UpstreamInfo } from "../upstream"

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

const STEP_TIME = "COALESCE(created_at, recorded_at)"
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

/** Tokens that would have been billed as fresh input without cache reuse. */
export function cacheHitRatio(usage: Pick<Usage, "input" | "cached">): number | undefined {
  const total = usage.cached + usage.input
  return total > 0 ? usage.cached / total : undefined
}

export type Overview = Usage & {
  sessions: number
  prompts: number
  firstAt: number | undefined
  lastAt: number | undefined
  cacheHitRatio: number | undefined
}

export function overview(db: Database, range?: Range): Overview {
  const steps = rangeWhere(range)
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
  /** Inference operators observed behind this provider. */
  upstreams: string[]
  /** Upstream model ids the gateway reported (e.g. `deepseek/deepseek-v4.1-flash`). */
  upstreamModels: string[]
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
  upstream_list: string | null
  upstream_model_list: string | null
  router_list: string | null
  first_at: number | null
  last_at: number | null
}

/**
 * Usage per model, each with the providers that served it. This is the view
 * that answers "which inference providers is this model actually coming from
 * over the selected period".
 */
export function models(db: Database, range?: Range): ModelUsage[] {
  const filter = rangeWhere(range)
  const rows = db
    .query(
      `SELECT provider_id, model_id, variant,
              GROUP_CONCAT(DISTINCT upstream) AS upstream_list,
              GROUP_CONCAT(DISTINCT upstream_model) AS upstream_model_list,
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
      upstreams: row.upstream_list ? row.upstream_list.split(",").filter(Boolean) : [],
      upstreamModels: row.upstream_model_list ? row.upstream_model_list.split(",").filter(Boolean) : [],
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

type StepRow = {
  message_id: string
  session_id: string
  provider_id: string | null
  model_id: string | null
  variant: string | null
  cache_read: number | null
  created_at: number | null
  completed_at: number | null
  recorded_at: number
}

function stepLike(row: StepRow): AssistantMessage {
  const model =
    row.model_id !== null
      ? { providerID: row.provider_id ?? "", id: row.model_id, ...(row.variant !== null ? { variant: row.variant } : {}) }
      : undefined
  return {
    type: "assistant",
    id: row.message_id,
    model,
    tokens: { cache: { read: row.cache_read ?? 0 } },
    time: {
      ...(row.created_at !== null ? { created: row.created_at } : {}),
      ...(row.completed_at !== null ? { completed: row.completed_at } : {}),
    },
  }
}

type StepSequences = {
  bySession: Map<string, StepRow[]>
  compactions: Map<string, number[]>
}

/**
 * Fetch every step belonging to the sessions that were active in the range,
 * plus their compaction times. The predecessor of the range's first step is
 * needed to judge reuse, so the fetch deliberately ignores the range bounds
 * once a session is selected.
 */
function loadSequences(db: Database, range?: Range): StepSequences {
  const filter = rangeWhere(range)
  const sessionRows = db.query(`SELECT DISTINCT session_id FROM steps ${filter.where}`).all(...filter.params) as { session_id: string }[]
  const sessionIDs = sessionRows.map((row) => row.session_id)
  const bySession = new Map<string, StepRow[]>()
  const compactions = new Map<string, number[]>()
  if (sessionIDs.length === 0) return { bySession, compactions }

  const placeholders = sessionIDs.map(() => "?").join(", ")
  const rows = db
    .query(
      `SELECT message_id, session_id, provider_id, model_id, variant, cache_read, created_at, completed_at, recorded_at
       FROM steps WHERE session_id IN (${placeholders})
       ORDER BY session_id, ${STEP_TIME}, message_id`,
    )
    .all(...sessionIDs) as StepRow[]
  for (const row of rows) {
    const list = bySession.get(row.session_id)
    if (list) list.push(row)
    else bySession.set(row.session_id, [row])
  }

  const compactionRows = db
    .query(`SELECT session_id, at FROM events WHERE kind = ? AND session_id IN (${placeholders}) ORDER BY at`)
    .all(COMPACTION_KIND, ...sessionIDs) as { session_id: string; at: number | null }[]
  for (const row of compactionRows) {
    if (row.at === null) continue
    const list = compactions.get(row.session_id)
    if (list) list.push(row.at)
    else compactions.set(row.session_id, [row.at])
  }

  return { bySession, compactions }
}

/**
 * Cache reuse losses with a best-effort reason: a compaction in between,
 * an idle gap long enough to be provider-side expiry, or unknown.
 */
export function cacheDrops(db: Database, options?: { range?: Range; ttlHintMs?: number }): CacheDropRow[] {
  const ttlHint = options?.ttlHintMs ?? DEFAULT_TTL_HINT_MS
  const { bySession, compactions } = loadSequences(db, options?.range)
  const from = options?.range?.from
  const to = options?.range?.to
  const drops: CacheDropRow[] = []

  for (const [sessionID, steps] of bySession) {
    for (let index = 1; index < steps.length; index += 1) {
      const previous = steps[index - 1]!
      const current = steps[index]!
      const lost = cacheDrop(stepLike(previous), stepLike(current))
      if (lost === undefined) continue
      const at = current.created_at ?? current.recorded_at
      if (from !== undefined && at < from) continue
      if (to !== undefined && at >= to) continue

      const gapMs = stepGap(stepLike(previous), stepLike(current))
      const endOfPrevious = previous.completed_at ?? previous.created_at ?? previous.recorded_at
      const compacted = (compactions.get(sessionID) ?? []).some((time) => time >= endOfPrevious && time <= at)
      const reason: DropReason = compacted ? "compaction" : gapMs !== undefined && gapMs >= ttlHint ? "expired" : "unknown"

      drops.push({
        sessionID,
        messageID: current.message_id,
        providerID: current.provider_id ?? undefined,
        modelID: current.model_id ?? undefined,
        variant: current.variant ?? undefined,
        at,
        tokens: lost,
        gapMs,
        prevCached: previous.cache_read ?? 0,
        reason,
      })
    }
  }
  return drops.sort((a, b) => a.at - b.at)
}

/**
 * Empirical bounds on the provider cache TTL: the longest idle gap that
 * still reused the cache, and the shortest gap that lost it. Comparing the
 * two per provider turns TTL guesses into observations.
 */
export function cacheTtlEvidence(db: Database, range?: Range): TtlEvidenceRow[] {
  const { bySession } = loadSequences(db, range)
  const evidence = new Map<string, TtlEvidenceRow>()

  for (const steps of bySession.values()) {
    for (let index = 1; index < steps.length; index += 1) {
      const previous = steps[index - 1]!
      const current = steps[index]!
      if (previous.model_id === null || current.model_id === null) continue
      const key = `${current.provider_id ?? ""}/${current.model_id}`
      const before = `${previous.provider_id ?? ""}/${previous.model_id}#${previous.variant ?? ""}`
      const after = `${current.provider_id ?? ""}/${current.model_id}#${current.variant ?? ""}`
      if (before !== after) continue

      const row = evidence.get(key) ?? {
        providerID: current.provider_id ?? "(unknown)",
        modelID: current.model_id,
        samples: 0,
        maxHitGapMs: undefined,
        minDropGapMs: undefined,
      }
      row.samples += 1
      const gapMs = stepGap(stepLike(previous), stepLike(current))
      if (gapMs !== undefined) {
        const lost = cacheDrop(stepLike(previous), stepLike(current))
        if (lost === undefined) {
          row.maxHitGapMs = row.maxHitGapMs === undefined ? gapMs : Math.max(row.maxHitGapMs, gapMs)
        } else {
          row.minDropGapMs = row.minDropGapMs === undefined ? gapMs : Math.min(row.minDropGapMs, gapMs)
        }
      }
      evidence.set(key, row)
    }
  }
  return [...evidence.values()].sort((a, b) => b.samples - a.samples)
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

function statsFor(values: number[]): LatencyStats {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
  }
}

export function latency(db: Database, range?: Range): LatencyReport {
  const filter = rangeWhere(range)
  const rows = db
    .query(`SELECT created_at, streamed_at, completed_at, output_tokens, reasoning_tokens FROM steps ${filter.where}`)
    .all(...filter.params) as { created_at: number | null; streamed_at: number | null; completed_at: number | null; output_tokens: number | null; reasoning_tokens: number | null }[]

  const wall: number[] = []
  const stream: number[] = []
  const tps: number[] = []
  for (const row of rows) {
    if (row.created_at !== null && row.completed_at !== null) wall.push(row.completed_at - row.created_at)
    if (row.created_at !== null && row.streamed_at !== null && row.streamed_at > row.created_at) stream.push(row.streamed_at - row.created_at)
    const produced = (row.output_tokens ?? 0) + (row.reasoning_tokens ?? 0)
    const rate = tokensPerSecond(produced, row.streamed_at ?? undefined, row.completed_at ?? undefined)
    if (rate !== undefined) tps.push(rate)
  }
  return { wall: statsFor(wall), stream: statsFor(stream), tps: statsFor(tps) }
}

export type SessionUsage = Usage & {
  sessionID: string
  title: string | undefined
  directory: string | undefined
  providers: string[]
  models: string[]
  prompts: number
  firstAt: number | undefined
  lastAt: number | undefined
}

export function sessions(db: Database, options?: { range?: Range; limit?: number }): SessionUsage[] {
  const filter = rangeWhere(options?.range, "COALESCE(st.created_at, st.recorded_at)")
  const limit = options?.limit ?? 20
  const rows = db
    .query(
      `SELECT st.session_id, s.title, s.directory,
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
       ${filter.where}
       GROUP BY st.session_id
       ORDER BY last_at DESC
       LIMIT ?`,
    )
    .all(
      ...filter.params,
      limit,
    ) as (UsageRow & {
    session_id: string
    title: string | null
    directory: string | null
    providers: string | null
    models: string | null
    prompts: number | null
    first_at: number | null
    last_at: number | null
  })[]

  return rows.map((row) => ({
    ...usageFrom(row),
    sessionID: row.session_id,
    title: row.title ?? undefined,
    directory: row.directory ?? undefined,
    providers: row.providers ? row.providers.split(",").filter(Boolean) : [],
    models: row.models ? row.models.split(",").filter(Boolean) : [],
    prompts: row.prompts ?? 0,
    firstAt: row.first_at ?? undefined,
    lastAt: row.last_at ?? undefined,
  }))
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
  upstream: string | undefined
  upstreamModel: string | undefined
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
  upstream: string | null
  upstream_model: string | null
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
 */
export function turns(
  db: Database,
  options?: { sessionID?: string | undefined; range?: Range | undefined; limit?: number | undefined },
): TurnUsage[] {
  const filter = rangeWhere(options?.range)
  const clauses = filter.where === "" ? [] : [filter.where.slice("WHERE ".length)]
  const params: (number | string)[] = [...filter.params]
  if (options?.sessionID !== undefined) {
    clauses.push("session_id = ?")
    params.push(options.sessionID)
  }
  const steps = db
    .query(
      `SELECT message_id, session_id, provider_id, model_id, variant,
              input_tokens, cache_read, cache_write, output_tokens, reasoning_tokens, cost,
              created_at, recorded_at, completed_at, finish, upstream, upstream_model, router
         FROM steps ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY session_id, ${STEP_TIME}`,
    )
    .all(...params) as TurnStepRow[]

  const promptRows = db
    .query(
      `SELECT session_id, created_at FROM prompts ${options?.sessionID === undefined ? "" : "WHERE session_id = ?"} ORDER BY session_id, created_at`,
    )
    .all(...(options?.sessionID === undefined ? [] : [options.sessionID])) as { session_id: string; created_at: number | null }[]

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
      upstream: lastWith((row) => row.upstream),
      upstreamModel: lastWith((row) => row.upstream_model),
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

  return result.reverse().slice(0, options?.limit ?? 50)
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
 * Most recent upstream evidence recorded for a session+model pair. The TUI
 * reads this for the telemetry line because the line renders from the TUI
 * process while the recorder (the server process) is still writing the step
 * that just finished.
 */
export function latestUpstream(db: Database, sessionID: string, modelID: string): UpstreamInfo | undefined {
  // Latest non-null value per field: the operator can change per request while
  // the router stays the same, and both are worth keeping.
  const row = db
    .query(
      `SELECT
         (SELECT upstream FROM steps WHERE session_id = $sessionID AND model_id = $modelID AND upstream IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) AS operator,
         (SELECT upstream_model FROM steps WHERE session_id = $sessionID AND model_id = $modelID AND upstream_model IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) AS model,
         (SELECT router FROM steps WHERE session_id = $sessionID AND model_id = $modelID AND router IS NOT NULL ORDER BY recorded_at DESC LIMIT 1) AS router`,
    )
    .get({ $sessionID: sessionID, $modelID: modelID }) as { operator: string | null; model: string | null; router: string | null } | null
  if (row === null) return undefined
  const info: UpstreamInfo = {}
  if (row.operator !== null) info.operator = row.operator
  if (row.model !== null) info.model = row.model
  if (row.router !== null) info.router = row.router
  return Object.keys(info).length === 0 ? undefined : info
}
