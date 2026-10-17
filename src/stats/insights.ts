import type { Database } from "bun:sqlite"
import { cacheDrop, stepGap, tokensPerSecond, type AssistantMessage } from "../core"
import { buildWhere, latencyStats, percentile, type Filters, type LatencyStats, type Range, type Usage } from "./queries"

/**
 * Analysis layer for the panel. Plain totals stay in the SQL aggregates of
 * `queries.ts`; everything that needs per-step comparisons, medians or calendar
 * buckets is computed here from one ordered fetch of step facts. That keeps the
 * rules — cache reuse, identity changes, idle gaps — in a single place and out
 * of the renderers.
 *
 * Every metric follows the definition documented in the panel help:
 * `hit = cached / (cached + input + cache_write)`.
 */

export type { Filters } from "./queries"

export const STEP_TIME = "COALESCE(created_at, recorded_at)"

const FACT_COLUMNS = `message_id, session_id, provider_id, model_id, variant, upstream, router,
       input_tokens, cache_read, cache_write, output_tokens, reasoning_tokens, cost,
       created_at, streamed_at, completed_at, finish, recorded_at`

/** One recorded step, ordered by session and time. */
export type StepFact = {
  messageID: string
  sessionID: string
  providerID: string | undefined
  modelID: string | undefined
  variant: string | undefined
  /** Inference operator behind the provider, when discovery learned one. */
  operator: string | undefined
  /** Gateway routing endpoint that served the request. */
  router: string | undefined
  input: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
  cost: number
  createdAt: number | undefined
  streamedAt: number | undefined
  completedAt: number | undefined
  /** `COALESCE(created_at, recorded_at)`, the ordering time of the step. */
  at: number
  finish: string | undefined
}

type FactRow = {
  message_id: string
  session_id: string
  provider_id: string | null
  model_id: string | null
  variant: string | null
  upstream: string | null
  router: string | null
  input_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cost: number | null
  created_at: number | null
  streamed_at: number | null
  completed_at: number | null
  finish: string | null
  recorded_at: number
}

function factFrom(row: FactRow): StepFact {
  return {
    messageID: row.message_id,
    sessionID: row.session_id,
    providerID: row.provider_id ?? undefined,
    modelID: row.model_id ?? undefined,
    variant: row.variant ?? undefined,
    operator: row.upstream ?? undefined,
    router: row.router ?? undefined,
    input: row.input_tokens ?? 0,
    cached: row.cache_read ?? 0,
    cacheWrite: row.cache_write ?? 0,
    output: row.output_tokens ?? 0,
    reasoning: row.reasoning_tokens ?? 0,
    cost: row.cost ?? 0,
    createdAt: row.created_at ?? undefined,
    streamedAt: row.streamed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    at: row.created_at ?? row.recorded_at,
    finish: row.finish ?? undefined,
  }
}

/** `WHERE` for a range and the panel filters, over one time column. */
function combineWhere(where: string, extra: string[]): string {
  const base = where === "" ? [] : [where.slice("WHERE ".length)]
  const all = [...base, ...extra]
  return all.length > 0 ? `WHERE ${all.join(" AND ")}` : ""
}

/**
 * Every step of the range, ordered by session and time. `withPredecessor` also
 * loads, per session, the newest step recorded before the range: judging a
 * reuse loss or an identity change needs the step that came before the window.
 */
export function stepFacts(
  db: Database,
  options?: { range?: Range | undefined; filters?: Filters | undefined; sessionID?: string | undefined; withPredecessor?: boolean | undefined },
): StepFact[] {
  const filter = buildWhere(options?.range, options?.filters)
  const extra: string[] = []
  const params: (string | number)[] = [...filter.params]
  if (options?.sessionID !== undefined) {
    extra.push("session_id = ?")
    params.push(options.sessionID)
  }
  const rows = db
    .query(`SELECT ${FACT_COLUMNS} FROM steps ${combineWhere(filter.where, extra)} ORDER BY session_id, ${STEP_TIME}, message_id`)
    .all(...params) as FactRow[]
  const facts = rows.map(factFrom)

  if (options?.withPredecessor === true && options.range?.from !== undefined) {
    const before = db
      .query(
        `SELECT * FROM (
           SELECT ${FACT_COLUMNS},
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ${STEP_TIME} DESC, message_id DESC) AS rn
             FROM steps
            WHERE ${STEP_TIME} < ?
         ) WHERE rn = 1`,
      )
      .all(options.range.from) as (FactRow & { rn: number })[]
    facts.push(...before.map(factFrom))
    facts.sort((left, right) => {
      if (left.sessionID !== right.sessionID) return left.sessionID < right.sessionID ? -1 : 1
      if (left.at !== right.at) return left.at - right.at
      return left.messageID < right.messageID ? -1 : left.messageID > right.messageID ? 1 : 0
    })
  }
  return facts
}

/** Consecutive steps of the same session, in time order. */
export function stepPairs(facts: readonly StepFact[]): Array<{ previous: StepFact; current: StepFact }> {
  const pairs: Array<{ previous: StepFact; current: StepFact }> = []
  for (let index = 1; index < facts.length; index += 1) {
    const previous = facts[index - 1]!
    const current = facts[index]!
    if (previous.sessionID !== current.sessionID) continue
    pairs.push({ previous, current })
  }
  return pairs
}

/** Structural view of a fact, so the shared cache rules apply unchanged. */
export function factMessage(fact: StepFact): AssistantMessage {
  return {
    type: "assistant",
    id: fact.messageID,
    time: {
      ...(fact.createdAt !== undefined ? { created: fact.createdAt } : {}),
      ...(fact.completedAt !== undefined ? { completed: fact.completedAt } : {}),
    },
    ...(fact.modelID !== undefined
      ? { model: { providerID: fact.providerID ?? "", id: fact.modelID, ...(fact.variant !== undefined ? { variant: fact.variant } : {}) } }
      : {}),
    tokens: {
      input: fact.input,
      output: fact.output,
      reasoning: fact.reasoning,
      cache: { read: fact.cached, write: fact.cacheWrite },
    },
    ...(fact.finish !== undefined ? { finish: fact.finish } : {}),
  }
}

export function groupBy<Value, Key>(items: readonly Value[], key: (item: Value) => Key): Map<Key, Value[]> {
  const groups = new Map<Key, Value[]>()
  for (const item of items) {
    const group = key(item)
    const list = groups.get(group)
    if (list !== undefined) list.push(item)
    else groups.set(group, [item])
  }
  return groups
}

export function emptyUsage(): Usage {
  return { steps: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 }
}

function usageOf(facts: readonly StepFact[]): Usage {
  const usage = emptyUsage()
  for (const fact of facts) {
    usage.steps += 1
    usage.input += fact.input
    usage.cached += fact.cached
    usage.cacheWrite += fact.cacheWrite
    usage.output += fact.output
    usage.reasoning += fact.reasoning
    usage.cost += fact.cost
  }
  return usage
}

export type CacheStats = {
  steps: number
  input: number
  cached: number
  cacheWrite: number
  /** The whole prompt the provider saw: `cached + input + cache_write`. */
  prompt: number
  /** Token-weighted reuse over the whole selection. */
  hit: number | undefined
  /** Median of the per-step reuse ratios: a few huge steps cannot hide a split pattern. */
  hitP50: number | undefined
}

/** Reuse of the prompt cache, both weighted and per-step. */
export function cacheStats(facts: readonly StepFact[]): CacheStats {
  let input = 0
  let cached = 0
  let cacheWrite = 0
  const ratios: number[] = []
  for (const fact of facts) {
    input += fact.input
    cached += fact.cached
    cacheWrite += fact.cacheWrite
    const prompt = fact.input + fact.cached + fact.cacheWrite
    if (prompt > 0) ratios.push(fact.cached / prompt)
  }
  const prompt = input + cached + cacheWrite
  return {
    steps: facts.length,
    input,
    cached,
    cacheWrite,
    prompt,
    hit: prompt > 0 ? cached / prompt : undefined,
    hitP50: percentile(ratios, 50),
  }
}

// ---------------------------------------------------------------------------
// Which endpoint served each model
// ---------------------------------------------------------------------------

export function modelKey(modelID: string, variant: string | undefined): string {
  return `${modelID}#${variant ?? ""}`
}

export function modelLabel(modelID: string, variant: string | undefined): string {
  return variant === undefined ? modelID : `${modelID} ${variant}`
}

/**
 * One model served by one endpoint. The endpoint is the only identity that
 * answers "who ran this inference": the configured provider says where the
 * request came from and the reported operator is best-effort evidence, so
 * neither is part of the key.
 */
export type EndpointRow = {
  modelID: string
  variant: string | undefined
  /** The routing endpoint, or undefined when it was never observed. */
  endpoint: string | undefined
  /** Share of the model's steps served by this endpoint. */
  share: number
  usage: Usage
  cache: CacheStats
  tps: number | undefined
  wall: number | undefined
  firstAt: number | undefined
  lastAt: number | undefined
}

function latencyOf(facts: readonly StepFact[]): { tps: number | undefined; wall: number | undefined } {
  const tps: number[] = []
  const wall: number[] = []
  for (const fact of facts) {
    const rate = tokensPerSecond(fact.output + fact.reasoning, fact.createdAt, fact.streamedAt)
    if (rate !== undefined) tps.push(rate)
    if (fact.createdAt !== undefined && fact.completedAt !== undefined) wall.push(fact.completedAt - fact.createdAt)
  }
  return { tps: latencyStats(tps).p50, wall: latencyStats(wall).p50 }
}

/** One row per model × endpoint. */
export function endpointBreakdown(facts: readonly StepFact[]): EndpointRow[] {
  const perModel = new Map<string, number>()
  for (const fact of facts) {
    const key = modelKey(fact.modelID ?? "(unknown)", fact.variant)
    perModel.set(key, (perModel.get(key) ?? 0) + 1)
  }
  const groups = groupBy(facts, (fact) => `${modelKey(fact.modelID ?? "(unknown)", fact.variant)}|${fact.router ?? ""}`)
  const rows: EndpointRow[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    const times = group.map((fact) => fact.at)
    const latency = latencyOf(group)
    rows.push({
      modelID: first.modelID ?? "(unknown)",
      variant: first.variant,
      endpoint: first.router,
      share: group.length / (perModel.get(modelKey(first.modelID ?? "(unknown)", first.variant)) ?? group.length),
      usage: usageOf(group),
      cache: cacheStats(group),
      tps: latency.tps,
      wall: latency.wall,
      firstAt: times.length > 0 ? Math.min(...times) : undefined,
      lastAt: times.length > 0 ? Math.max(...times) : undefined,
    })
  }
  return rows.sort((left, right) => right.usage.steps - left.usage.steps || right.cache.cached - left.cache.cached)
}

export type EndpointSummary = {
  /** The routing endpoint, or undefined for requests whose destination was never observed. */
  endpoint: string | undefined
  /** Models this endpoint served. */
  models: string[]
  share: number
  usage: Usage
  cache: CacheStats
  tps: number | undefined
  wall: number | undefined
  firstAt: number | undefined
  lastAt: number | undefined
}

/** One row per endpoint, over every model it served. */
export function endpointSummary(facts: readonly StepFact[]): EndpointSummary[] {
  const groups = groupBy(facts, (fact) => fact.router ?? "")
  const rows: EndpointSummary[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    const times = group.map((fact) => fact.at)
    const latency = latencyOf(group)
    rows.push({
      endpoint: first.router,
      models: [...new Set(group.map((fact) => modelKey(fact.modelID ?? "(unknown)", fact.variant)))].map((key) => labelOfKey(key)),
      share: facts.length === 0 ? 0 : group.length / facts.length,
      usage: usageOf(group),
      cache: cacheStats(group),
      tps: latency.tps,
      wall: latency.wall,
      firstAt: times.length > 0 ? Math.min(...times) : undefined,
      lastAt: times.length > 0 ? Math.max(...times) : undefined,
    })
  }
  return rows.sort((left, right) => right.usage.steps - left.usage.steps)
}

function labelOfKey(key: string): string {
  const [modelID, variant] = key.split("#")
  return variant === undefined || variant === "" ? modelID! : `${modelID} ${variant}`
}

// ---------------------------------------------------------------------------
// Affinity: how often the identity changed, and what it cost
// ---------------------------------------------------------------------------

export type AffinityDimension = "model" | "endpoint"

export type AffinityTransition = {
  dimension: AffinityDimension
  from: string
  to: string
  count: number
}

function noteTransition(map: Map<string, AffinityTransition>, dimension: AffinityDimension, from: string, to: string): void {
  const key = `${dimension}\u0000${from}\u0000${to}`
  const entry = map.get(key)
  if (entry !== undefined) entry.count += 1
  else map.set(key, { dimension, from, to, count: 1 })
}

export type AffinityRow = {
  modelID: string
  variant: string | undefined
  steps: number
  /** Comparable consecutive pairs of the model: the denominator of `rate`. */
  pairs: number
  changes: number
  modelChanges: number
  endpointChanges: number
  /** Measured cache reuse lost on the step right after a change. */
  cacheLost: number
  cacheLostEvents: number
}

export type AffinityReport = {
  rows: AffinityRow[]
  transitions: AffinityTransition[]
  totals: { pairs: number; changes: number; cacheLost: number; cacheLostEvents: number }
}

/**
 * Identity changes between consecutive steps of a session, by the two
 * dimensions that decide where the work ran: the model and the routing
 * endpoint. A change is not by itself a fault — the gateway may re-route
 * deliberately — so the report pairs the count with the cache it actually cost.
 */
export function affinityReport(facts: readonly StepFact[]): AffinityReport {
  const rows = new Map<string, AffinityRow>()
  const transitions = new Map<string, AffinityTransition>()
  const totals = { pairs: 0, changes: 0, cacheLost: 0, cacheLostEvents: 0 }

  for (const { previous, current } of stepPairs(facts)) {
    if (previous.modelID === undefined || current.modelID === undefined) continue
    const key = modelKey(current.modelID, current.variant)
    const row = rows.get(key) ?? {
      modelID: current.modelID,
      variant: current.variant,
      steps: 0,
      pairs: 0,
      changes: 0,
      modelChanges: 0,
      endpointChanges: 0,
      cacheLost: 0,
      cacheLostEvents: 0,
    }
    row.steps += 1
    row.pairs += 1
    totals.pairs += 1

    const modelChanged = modelKey(previous.modelID, previous.variant) !== modelKey(current.modelID, current.variant)
    const endpointChanged = previous.router !== undefined && current.router !== undefined && previous.router !== current.router
    const changed = modelChanged || endpointChanged

    if (modelChanged) {
      row.modelChanges += 1
      noteTransition(transitions, "model", modelLabel(previous.modelID, previous.variant), modelLabel(current.modelID, current.variant))
    }
    if (endpointChanged) {
      row.endpointChanges += 1
      noteTransition(transitions, "endpoint", previous.router!, current.router!)
    }
    if (changed) {
      row.changes += 1
      totals.changes += 1
      const lost = cacheDrop(factMessage(previous), factMessage(current))
      if (lost !== undefined) {
        row.cacheLost += lost
        row.cacheLostEvents += 1
        totals.cacheLost += lost
        totals.cacheLostEvents += 1
      }
    }
    rows.set(key, row)
  }

  return {
    rows: [...rows.values()].sort((left, right) => right.changes - left.changes || right.steps - left.steps),
    transitions: [...transitions.values()].sort((left, right) => right.count - left.count),
    totals,
  }
}

// ---------------------------------------------------------------------------
// Cache reuse against idle time
// ---------------------------------------------------------------------------

export type GapBucket = {
  label: string
  samples: number
  /** Pairs that still reused the prompt cache. */
  retained: number
  drops: number
  lostTokens: number
  retainedRatio: number | undefined
}

export type EndpointReuseRow = {
  /** The routing endpoint, or `(unknown)` when it was never observed. */
  endpoint: string
  samples: number
  retained: number
  drops: number
  lostTokens: number
  retainedRatio: number | undefined
}

export type GapReport = {
  buckets: GapBucket[]
  endpoints: EndpointReuseRow[]
  samples: number
}

/** Idle-gap buckets, coarse enough to read at a glance. */
export const GAP_BUCKETS: ReadonlyArray<readonly [string, number, number | undefined]> = [
  ["<1m", 0, 60_000],
  ["1–5m", 60_000, 5 * 60_000],
  ["5–15m", 5 * 60_000, 15 * 60_000],
  ["15–60m", 15 * 60_000, 60 * 60_000],
  ["1–6h", 60 * 60_000, 6 * 60 * 60_000],
  [">6h", 6 * 60 * 60_000, undefined],
]

function bucketFor(gapMs: number): number {
  for (let index = 0; index < GAP_BUCKETS.length; index += 1) {
    const [, from, to] = GAP_BUCKETS[index]!
    if (gapMs >= from && (to === undefined || gapMs < to)) return index
  }
  return GAP_BUCKETS.length - 1
}

/**
 * How long an idle gap the prompt cache survives, per gap bucket and per
 * endpoint. Only pairs of the same model are comparable, which is exactly the
 * set the cache rule already uses.
 */
export function gapReport(facts: readonly StepFact[]): GapReport {
  const buckets: GapBucket[] = GAP_BUCKETS.map(([label]) => ({ label, samples: 0, retained: 0, drops: 0, lostTokens: 0, retainedRatio: undefined }))
  const endpoints = new Map<string, EndpointReuseRow>()
  let samples = 0

  for (const { previous, current } of stepPairs(facts)) {
    if (previous.modelID === undefined || current.modelID === undefined) continue
    if (modelKey(previous.modelID, previous.variant) !== modelKey(current.modelID, current.variant)) continue
    const gap = stepGap(factMessage(previous), factMessage(current))
    if (gap === undefined) continue
    const lost = cacheDrop(factMessage(previous), factMessage(current))
    const bucket = buckets[bucketFor(gap)]!
    bucket.samples += 1
    samples += 1
    if (lost === undefined) bucket.retained += 1
    else {
      bucket.drops += 1
      bucket.lostTokens += lost
    }

    const endpoint = current.router ?? previous.router ?? "(unknown)"
    const row = endpoints.get(endpoint) ?? { endpoint, samples: 0, retained: 0, drops: 0, lostTokens: 0, retainedRatio: undefined }
    row.samples += 1
    if (lost === undefined) row.retained += 1
    else {
      row.drops += 1
      row.lostTokens += lost
    }
    endpoints.set(endpoint, row)
  }

  for (const bucket of buckets) bucket.retainedRatio = bucket.samples > 0 ? bucket.retained / bucket.samples : undefined
  for (const row of endpoints.values()) row.retainedRatio = row.samples > 0 ? row.retained / row.samples : undefined
  return { buckets, endpoints: [...endpoints.values()].sort((left, right) => right.samples - left.samples), samples }
}

// ---------------------------------------------------------------------------
// Calendar periods
// ---------------------------------------------------------------------------

export type PeriodGranularity = "day" | "week" | "month"

export type PeriodRow = {
  key: string
  label: string
  /** Start of the bucket, local time. */
  at: number
  steps: number
  sessions: number
  usage: Usage
  cache: CacheStats
}

/** ISO-8601 week number and its Monday, in local time. */
export function isoWeek(date: Date): { year: number; week: number; monday: Date } {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3)
  const firstThursday = new Date(thursday.getFullYear(), 0, 4)
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3)
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000))
  return { year: thursday.getFullYear(), week, monday }
}

export function periodStart(at: number, granularity: PeriodGranularity): { key: string; label: string; start: number } {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  if (granularity === "month") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1)
    return { key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}`, label: `${start.getFullYear()}-${pad(start.getMonth() + 1)}`, start: start.getTime() }
  }
  if (granularity === "week") {
    const { year, week, monday } = isoWeek(date)
    return { key: `${year}-W${pad(week)}`, label: `${year}-W${pad(week)}`, start: monday.getTime() }
  }
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`
  return { key, label: key, start: start.getTime() }
}

/** Totals per local calendar day, week or month, oldest first. */
export function periodReport(facts: readonly StepFact[], granularity: PeriodGranularity): PeriodRow[] {
  const groups = groupBy(facts, (fact) => periodStart(fact.at, granularity).key)
  const rows: PeriodRow[] = []
  for (const [key, group] of groups) {
    const first = group[0]!
    const period = periodStart(first.at, granularity)
    rows.push({
      key,
      label: period.label,
      at: period.start,
      steps: group.length,
      sessions: new Set(group.map((fact) => fact.sessionID)).size,
      usage: usageOf(group),
      cache: cacheStats(group),
    })
  }
  return rows.sort((left, right) => left.at - right.at)
}

// ---------------------------------------------------------------------------
// Latency per model, provider or operator
// ---------------------------------------------------------------------------

export type LatencyGroupRow = {
  key: string
  label: string
  count: number
  usage: Usage
  wall: LatencyStats
  stream: LatencyStats
  tps: LatencyStats
}

/** Wall, streaming window and throughput percentiles per group. */
export function latencyGroups(facts: readonly StepFact[], by: "model" | "provider" | "operator"): LatencyGroupRow[] {
  const groups = groupBy(facts, (fact) => {
    if (by === "model") return modelKey(fact.modelID ?? "(unknown)", fact.variant)
    if (by === "provider") return fact.providerID ?? "(unknown)"
    return fact.operator ?? "(unknown)"
  })
  const rows: LatencyGroupRow[] = []
  for (const [key, group] of groups) {
    const wall: number[] = []
    const stream: number[] = []
    const tps: number[] = []
    for (const fact of group) {
      if (fact.createdAt !== undefined && fact.completedAt !== undefined) wall.push(fact.completedAt - fact.createdAt)
      if (fact.createdAt !== undefined && fact.streamedAt !== undefined && fact.streamedAt > fact.createdAt) stream.push(fact.streamedAt - fact.createdAt)
      const rate = tokensPerSecond(fact.output + fact.reasoning, fact.createdAt, fact.streamedAt)
      if (rate !== undefined) tps.push(rate)
    }
    rows.push({ key, label: labelFor(key, by), count: group.length, usage: usageOf(group), wall: latencyStats(wall), stream: latencyStats(stream), tps: latencyStats(tps) })
  }
  return rows.sort((left, right) => right.count - left.count)
}

function labelFor(key: string, by: "model" | "provider" | "operator"): string {
  if (by !== "model") return key
  const [modelID, variant] = key.split("#")
  return variant === undefined || variant === "" ? modelID! : `${modelID} ${variant}`
}

// ---------------------------------------------------------------------------
// Data coverage
// ---------------------------------------------------------------------------

export type CoverageReport = {
  steps: number
  models: number
  endpoints: number
  missingModel: number
  missingEndpoint: number
  unsettled: number
  missingTps: number
  firstAt: number | undefined
  lastAt: number | undefined
}

/**
 * What the panel cannot answer honestly: how many steps lack a model or an
 * observed endpoint, and how many never settled. A zero in the affinity view
 * means "never changed" only when this coverage is complete.
 */
export function coverageReport(facts: readonly StepFact[]): CoverageReport {
  let missingModel = 0
  let missingEndpoint = 0
  let unsettled = 0
  let missingTps = 0
  let firstAt: number | undefined
  let lastAt: number | undefined
  const models = new Set<string>()
  const endpoints = new Set<string>()
  for (const fact of facts) {
    if (fact.modelID === undefined) missingModel += 1
    else models.add(modelKey(fact.modelID, fact.variant))
    if (fact.router === undefined) missingEndpoint += 1
    else endpoints.add(fact.router)
    if (fact.completedAt === undefined) unsettled += 1
    if (tokensPerSecond(fact.output + fact.reasoning, fact.createdAt, fact.streamedAt) === undefined) missingTps += 1
    if (firstAt === undefined || fact.at < firstAt) firstAt = fact.at
    if (lastAt === undefined || fact.at > lastAt) lastAt = fact.at
  }
  return {
    steps: facts.length,
    models: models.size,
    endpoints: endpoints.size,
    missingModel,
    missingEndpoint,
    unsettled,
    missingTps,
    firstAt,
    lastAt,
  }
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
