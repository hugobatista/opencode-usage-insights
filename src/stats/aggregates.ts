/**
 * The analysis layer: the reports the panel and the CLI show.
 *
 * Two shapes, chosen by measurement rather than taste:
 *
 * 1. **Aggregates in SQLite** — totals, counts, distinct values. `coverageOf`
 *    and the filter pickers never move a row into JavaScript.
 * 2. **Narrow rows plus arithmetic in JS** — percentiles, pair rules, calendar
 *    buckets. SQLite's window functions cost about 17 µs per row per report
 *    here (a sort plus a materialisation), while reading the four to twelve
 *    columns a report actually needs costs 1–4 µs per row. The percentiles and
 *    the pair comparisons are therefore computed over lean projections: on the
 *    audit's 120k-step database a whole view costs a few hundred milliseconds,
 *    and on a normal one it is instant.
 *
 * The rules are not restated here. Cache reuse, idle gaps and the noise
 * threshold come from `core.ts` — the same functions the live line uses — so
 * the panel and the line can never disagree about what a cache loss is.
 * `test/reports.test.ts` holds every report to those rules.
 */

import type { Database } from "bun:sqlite"
import { cacheDrop, stepGap, tokensPerSecond, type AssistantMessage } from "../core"
import {
  buildWhere,
  DEFAULT_TTL_HINT_MS,
  latencyStats,
  modelKey,
  modelLabel,
  percentile,
  type Filters,
  type LatencyStats,
  type Range,
  type Usage,
} from "./queries"

/** The step's own clock, the expression the `steps_at` index covers. */
export const STEP_AT = "COALESCE(created_at, recorded_at)"

type Options = { range?: Range | undefined; filters?: Filters | undefined }

// ---------------------------------------------------------------------------
// Lean projections
// ---------------------------------------------------------------------------

/**
 * Turn `null` into `undefined` in place, so a row costs one object and not two.
 * Every query aliases its columns to the field names they are read through;
 * only the optional ones have to be normalized.
 */
function normalize<Row>(rows: Row[], optional: readonly string[]): Row[] {
  for (const row of rows as unknown as Array<Record<string, unknown>>) {
    for (const key of optional) if (row[key] === null) row[key] = undefined
  }
  return rows
}

function groupBy<Value, Key>(items: readonly Value[], key: (item: Value) => Key): Map<Key, Value[]> {
  const groups = new Map<Key, Value[]>()
  for (const item of items) {
    const group = key(item)
    const list = groups.get(group)
    if (list !== undefined) list.push(item)
    else groups.set(group, [item])
  }
  return groups
}

/** One recorded step, as the reports read it. */
export type StepRow = {
  messageID: string
  sessionID: string
  providerID: string | undefined
  modelID: string | undefined
  variant: string | undefined
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
  /** `COALESCE(created_at, recorded_at)`: the ordering time of the step. */
  at: number
  /** Set on the single step loaded before the range, as a reference. */
  boundary?: boolean | undefined
}

const STEP_COLUMNS = `message_id AS messageID, session_id AS sessionID, provider_id AS providerID,
       model_id AS modelID, variant, router,
       COALESCE(input_tokens, 0) AS input, COALESCE(cache_read, 0) AS cached, COALESCE(cache_write, 0) AS cacheWrite,
       COALESCE(output_tokens, 0) AS output, COALESCE(reasoning_tokens, 0) AS reasoning, COALESCE(cost, 0) AS cost,
       created_at AS createdAt, streamed_at AS streamedAt, completed_at AS completedAt, ${STEP_AT} AS at`

const STEP_OPTIONAL = ["providerID", "modelID", "variant", "router", "createdAt", "streamedAt", "completedAt"] as const

/** The pair reports read no generated tokens: `output` and `reasoning` stay out. */
const PAIR_COLUMNS = STEP_COLUMNS.replace("COALESCE(output_tokens, 0) AS output, COALESCE(reasoning_tokens, 0) AS reasoning, ", "")

/** The steps of the range, narrow. Ordering is only paid for where it is read. */
export function stepRows(db: Database, options?: Options): StepRow[] {
  const filter = buildWhere(options?.range, options?.filters)
  const rows = db.query(`SELECT ${STEP_COLUMNS} FROM steps ${filter.where}`).all(...filter.params) as Array<Record<string, unknown>>
  return normalize(rows, STEP_OPTIONAL) as StepRow[]
}

/**
 * The steps of the range plus, for every session with a step inside it, the one
 * step before the range: the pair reports compare a step with the one that
 * preceded it, so the first step of a range has to see it.
 *
 * The boundary is one seek per session on the `(session_id, time)` index — a
 * few milliseconds for a far wider history — never the whole history of the
 * sessions in range.
 */
export function cachePairs(db: Database, options?: Options): StepRow[] {
  const filter = buildWhere(options?.range, options?.filters)
  const rows = normalize(
    db
      .query(`SELECT ${PAIR_COLUMNS} FROM steps ${filter.where} ORDER BY session_id, ${STEP_AT}, message_id`)
      .all(...filter.params) as Array<Record<string, unknown>>,
    STEP_OPTIONAL,
  ) as StepRow[]
  const from = options?.range?.from
  if (from === undefined || rows.length === 0) return rows
  const seek = db.query(
    `SELECT ${PAIR_COLUMNS} FROM steps
      WHERE session_id = ? AND COALESCE(created_at, recorded_at) < ?
      ORDER BY COALESCE(created_at, recorded_at) DESC, message_id DESC LIMIT 1`,
  )
  for (const sessionID of new Set(rows.map((row) => row.sessionID))) {
    const boundary = seek.get(sessionID, from) as Record<string, unknown> | null
    if (boundary === null) continue
    const step = normalize([boundary], STEP_OPTIONAL)[0] as StepRow
    step.boundary = true
    rows.push(step)
  }
  rows.sort((left, right) => {
    if (left.sessionID !== right.sessionID) return left.sessionID < right.sessionID ? -1 : 1
    if (left.at !== right.at) return left.at - right.at
    return left.messageID < right.messageID ? -1 : left.messageID > right.messageID ? 1 : 0
  })
  return rows
}

/** The same step in the message shape the shared pair rules are written for. */
function message(step: StepRow): AssistantMessage {
  return {
    type: "assistant",
    id: step.messageID,
    ...(step.modelID === undefined
      ? {}
      : { model: { providerID: step.providerID ?? "", id: step.modelID, ...(step.variant === undefined ? {} : { variant: step.variant }) } }),
    tokens: { cache: { read: step.cached } },
    time: {
      ...(step.createdAt === undefined ? {} : { created: step.createdAt }),
      ...(step.streamedAt === undefined ? {} : { streamed: step.streamedAt }),
      ...(step.completedAt === undefined ? {} : { completed: step.completedAt }),
    },
  }
}

/** Consecutive steps of the same session, in order. */
function pairsOf(rows: readonly StepRow[]): Array<{ previous: StepRow; current: StepRow }> {
  const pairs: Array<{ previous: StepRow; current: StepRow }> = []
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!
    const current = rows[index]!
    if (previous.sessionID !== current.sessionID) continue
    pairs.push({ previous, current })
  }
  return pairs
}

type Counted = { input: number; cached: number; cacheWrite: number; output: number; reasoning: number; cost: number }

/** The buckets the panel and the line agree on. */
function usageOf(steps: readonly Counted[]): Usage {
  const usage: Usage = { steps: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 }
  for (const step of steps) {
    usage.steps += 1
    usage.input += step.input
    usage.cached += step.cached
    usage.cacheWrite += step.cacheWrite
    usage.output += step.output
    usage.reasoning += step.reasoning
    usage.cost += step.cost
  }
  return usage
}

// ---------------------------------------------------------------------------
// Coverage
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
export function coverageOf(db: Database, options?: Options): CoverageReport {
  const filter = buildWhere(options?.range, options?.filters)
  const row = db
    .query(
      `SELECT COUNT(*) AS steps,
              COUNT(DISTINCT CASE WHEN model_id IS NOT NULL THEN model_id || '#' || COALESCE(variant, '') END) AS models,
              COUNT(DISTINCT router) AS endpoints,
              COALESCE(SUM(CASE WHEN model_id IS NULL THEN 1 ELSE 0 END), 0) AS missingModel,
              COALESCE(SUM(CASE WHEN router IS NULL THEN 1 ELSE 0 END), 0) AS missingEndpoint,
              COALESCE(SUM(CASE WHEN completed_at IS NOT NULL OR finish IS NOT NULL THEN 0 ELSE 1 END), 0) AS unsettled,
              COALESCE(SUM(CASE WHEN (output_tokens + reasoning_tokens) > 0 AND created_at IS NOT NULL AND streamed_at IS NOT NULL AND streamed_at > created_at THEN 0 ELSE 1 END), 0) AS missingTps,
              MIN(${STEP_AT}) AS firstAt,
              MAX(${STEP_AT}) AS lastAt
         FROM steps ${filter.where}`,
    )
    .get(...filter.params) as {
    steps: number
    models: number
    endpoints: number
    missingModel: number
    missingEndpoint: number
    unsettled: number
    missingTps: number
    firstAt: number | null
    lastAt: number | null
  }
  return {
    steps: row.steps,
    models: row.models,
    endpoints: row.endpoints,
    missingModel: row.missingModel,
    missingEndpoint: row.missingEndpoint,
    unsettled: row.unsettled,
    missingTps: row.missingTps,
    firstAt: row.firstAt ?? undefined,
    lastAt: row.lastAt ?? undefined,
  }
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

/** The steps a latency report is built from. It reads no generated tokens. */
type GroupedRow = StepRow

function groupedRows(db: Database, options?: Options): GroupedRow[] {
  const filter = buildWhere(options?.range, options?.filters)
  const rows = db.query(`SELECT ${STEP_COLUMNS} FROM steps ${filter.where}`).all(...filter.params) as Array<Record<string, unknown>>
  return normalize(rows, STEP_OPTIONAL) as StepRow[]
}

/** The three measures a latency report is made of. */
function timingOf(step: StepRow): { wall: number | undefined; stream: number | undefined; tps: number | undefined } {
  const wall = step.createdAt !== undefined && step.completedAt !== undefined ? step.completedAt - step.createdAt : undefined
  const stream =
    step.createdAt !== undefined && step.streamedAt !== undefined && step.streamedAt > step.createdAt ? step.streamedAt - step.createdAt : undefined
  return { wall, stream, tps: tokensPerSecond(step.output + step.reasoning, step.createdAt, step.streamedAt) }
}

export type LatencyReport = {
  wall: LatencyStats
  stream: LatencyStats
  tps: LatencyStats
}

/** The timings of the range: one read, shared by the overall report and the groups. */
export function timingRows(db: Database, options?: Options): GroupedRow[] {
  return groupedRows(db, options)
}

/** Overall wall time, streaming window and throughput percentiles. */
export function latencyOf(rows: readonly StepRow[]): LatencyReport {
  const wall: number[] = []
  const stream: number[] = []
  const tps: number[] = []
  for (const step of rows) {
    const timing = timingOf(step)
    if (timing.wall !== undefined) wall.push(timing.wall)
    if (timing.stream !== undefined) stream.push(timing.stream)
    if (timing.tps !== undefined) tps.push(timing.tps)
  }
  return { wall: latencyStats(wall), stream: latencyStats(stream), tps: latencyStats(tps) }
}

export type LatencyGroupRow = {
  key: string
  label: string
  count: number
  usage: Usage
  wall: LatencyStats
  stream: LatencyStats
  tps: LatencyStats
}

export type Dimension = "model" | "provider" | "endpoint"

/** Wall, streaming window and throughput percentiles per group. */
export function latencyGroupsOf(rows: readonly StepRow[], by: Dimension): LatencyGroupRow[] {
  const key = (step: StepRow) => (by === "model" ? modelKey(step.modelID ?? "(unknown)", step.variant) : by === "provider" ? step.providerID ?? "(unknown)" : step.router ?? "(unknown)")
  const groups: LatencyGroupRow[] = []
  for (const [group, steps] of groupBy(rows, key)) {
    const wall: number[] = []
    const stream: number[] = []
    const tps: number[] = []
    for (const step of steps) {
      const timing = timingOf(step)
      if (timing.wall !== undefined) wall.push(timing.wall)
      if (timing.stream !== undefined) stream.push(timing.stream)
      if (timing.tps !== undefined) tps.push(timing.tps)
    }
    const [modelID, variant] = group.split("#")
    groups.push({
      key: group,
      label: by === "model" ? (variant === undefined || variant === "" ? modelID! : `${modelID} ${variant}`) : group,
      count: steps.length,
      usage: usageOf(steps),
      wall: latencyStats(wall),
      stream: latencyStats(stream),
      tps: latencyStats(tps),
    })
  }
  return groups.sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

// ---------------------------------------------------------------------------
// Cache reuse
// ---------------------------------------------------------------------------

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

const EMPTY_CACHE: CacheStats = { steps: 0, input: 0, cached: 0, cacheWrite: 0, prompt: 0, hit: undefined, hitP50: undefined }

/** Reuse of the prompt cache over a set of steps. */
function cacheStatsOfSteps(steps: readonly { input: number; cached: number; cacheWrite: number }[]): CacheStats {
  let input = 0
  let cached = 0
  let cacheWrite = 0
  const ratios: number[] = []
  for (const step of steps) {
    input += step.input
    cached += step.cached
    cacheWrite += step.cacheWrite
    const prompt = step.input + step.cached + step.cacheWrite
    if (prompt > 0) ratios.push(step.cached / prompt)
  }
  const prompt = input + cached + cacheWrite
  return { steps: steps.length, input, cached, cacheWrite, prompt, hit: prompt > 0 ? cached / prompt : undefined, hitP50: percentile(ratios, 50) }
}

/** Reuse of the prompt cache over the range, as one row. */
export function cacheStatsOf(db: Database, options?: Options): CacheStats {
  const rows = stepRows(db, options)
  return rows.length === 0 ? EMPTY_CACHE : cacheStatsOfSteps(rows)
}

export type CacheModelRow = {
  modelID: string
  variant: string | undefined
  cache: CacheStats
}

/**
 * Reuse of the prompt cache per model, most cached first, over the steps of the
 * range. A boundary step is not part of the range, so it is left out.
 */
export function cacheStatsByModel(rows: readonly StepRow[]): CacheModelRow[] {
  const out: CacheModelRow[] = []
  const inRange = rows.filter((row) => row.boundary !== true)
  for (const [, group] of groupBy(inRange, (row) => modelKey(row.modelID ?? "(unknown)", row.variant))) {
    out.push({ modelID: group[0]!.modelID ?? "(unknown)", variant: group[0]!.variant, cache: cacheStatsOfSteps(group) })
  }
  return out.sort((left, right) => right.cache.cached - left.cache.cached || left.modelID.localeCompare(right.modelID))
}

// ---------------------------------------------------------------------------
// Pairs: affinity, cache survival, TTL, losses
// ---------------------------------------------------------------------------

export type AffinityRow = {
  modelID: string
  variant: string | undefined
  steps: number
  pairs: number
  changes: number
  modelChanges: number
  endpointChanges: number
  cacheLost: number
  cacheLostEvents: number
}

export type AffinityTransition = {
  dimension: "model" | "endpoint"
  from: string
  to: string
  count: number
}

export type AffinityReport = {
  rows: AffinityRow[]
  transitions: AffinityTransition[]
  totals: { pairs: number; changes: number; cacheLost: number; cacheLostEvents: number }
}

function noteTransition(map: Map<string, AffinityTransition>, dimension: "model" | "endpoint", from: string, to: string): void {
  const key = `${dimension}\u0000${from}\u0000${to}`
  const entry = map.get(key)
  if (entry !== undefined) entry.count += 1
  else map.set(key, { dimension, from, to, count: 1 })
}

/**
 * Identity changes between consecutive steps of a session, by the two
 * dimensions that decide where the work ran: the model and the routing
 * endpoint. A change is not by itself a fault — a gateway may re-route
 * deliberately — so the report pairs the count with the cache it actually cost.
 */
export function affinityOf(rows: readonly StepRow[]): AffinityReport {
  const perModel = new Map<string, AffinityRow>()
  const transitions = new Map<string, AffinityTransition>()
  const totals = { pairs: 0, changes: 0, cacheLost: 0, cacheLostEvents: 0 }

  for (const { previous, current } of pairsOf(rows)) {
    if (previous.modelID === undefined || current.modelID === undefined) continue
    const key = modelKey(current.modelID, current.variant)
    const row = perModel.get(key) ?? {
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

    const modelChanged = key !== modelKey(previous.modelID, previous.variant)
    const endpointChanged = previous.router !== undefined && current.router !== undefined && previous.router !== current.router
    if (modelChanged) {
      row.modelChanges += 1
      noteTransition(transitions, "model", modelLabel(previous.modelID, previous.variant), modelLabel(current.modelID, current.variant))
    }
    if (endpointChanged) {
      row.endpointChanges += 1
      noteTransition(transitions, "endpoint", previous.router!, current.router!)
    }
    if (modelChanged || endpointChanged) {
      row.changes += 1
      totals.changes += 1
      const lost = cacheDrop(message(previous), message(current))
      if (lost !== undefined) {
        row.cacheLost += lost
        row.cacheLostEvents += 1
        totals.cacheLost += lost
        totals.cacheLostEvents += 1
      }
    }
    perModel.set(key, row)
  }

  return {
    rows: [...perModel.values()].sort((left, right) => right.changes - left.changes || right.steps - left.steps || left.modelID.localeCompare(right.modelID)),
    transitions: [...transitions.values()].sort((left, right) => right.count - left.count || left.dimension.localeCompare(right.dimension)),
    totals,
  }
}

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
  const index = GAP_BUCKETS.findIndex(([, from, to]) => gapMs >= from && (to === undefined || gapMs < to))
  return index === -1 ? GAP_BUCKETS.length - 1 : index
}

/**
 * How long an idle gap the prompt cache survives, per gap bucket and per
 * endpoint. Only pairs of the same model are comparable, which is exactly the
 * set the cache rule already uses.
 */
export function gapReportOf(rows: readonly StepRow[]): GapReport {
  const buckets: GapBucket[] = GAP_BUCKETS.map(([label]) => ({ label, samples: 0, retained: 0, drops: 0, lostTokens: 0, retainedRatio: undefined }))
  const endpoints = new Map<string, EndpointReuseRow>()
  let samples = 0

  for (const { previous, current } of pairsOf(rows)) {
    if (previous.modelID === undefined || current.modelID === undefined) continue
    if (modelKey(previous.modelID, previous.variant) !== modelKey(current.modelID, current.variant)) continue
    const gap = stepGap(message(previous), message(current))
    if (gap === undefined) continue
    const lost = cacheDrop(message(previous), message(current))
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
  return {
    buckets,
    endpoints: [...endpoints.values()].sort((left, right) => right.samples - left.samples || left.endpoint.localeCompare(right.endpoint)),
    samples,
  }
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

/**
 * Empirical bounds on the provider cache TTL: the longest idle gap that still
 * reused the cache, and the shortest gap that lost it. Comparing the two per
 * provider turns TTL guesses into observations.
 */
export function ttlEvidenceOf(rows: readonly StepRow[]): TtlEvidenceRow[] {
  const evidence = new Map<string, TtlEvidenceRow>()

  for (const { previous, current } of pairsOf(rows)) {
    if (previous.modelID === undefined || current.modelID === undefined) continue
    const key = `${current.providerID ?? ""}/${current.modelID}`
    const before = `${previous.providerID ?? ""}/${previous.modelID}#${previous.variant ?? ""}`
    const after = `${current.providerID ?? ""}/${current.modelID}#${current.variant ?? ""}`
    if (before !== after) continue

    const row = evidence.get(key) ?? {
      providerID: current.providerID ?? "(unknown)",
      modelID: current.modelID,
      samples: 0,
      maxHitGapMs: undefined,
      minDropGapMs: undefined,
    }
    row.samples += 1
    const gapMs = stepGap(message(previous), message(current))
    if (gapMs !== undefined) {
      const lost = cacheDrop(message(previous), message(current))
      if (lost === undefined) row.maxHitGapMs = row.maxHitGapMs === undefined ? gapMs : Math.max(row.maxHitGapMs, gapMs)
      else row.minDropGapMs = row.minDropGapMs === undefined ? gapMs : Math.min(row.minDropGapMs, gapMs)
    }
    evidence.set(key, row)
  }
  return [...evidence.values()].sort(
    (left, right) => right.samples - left.samples || `${left.providerID}/${left.modelID}`.localeCompare(`${right.providerID}/${right.modelID}`),
  )
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

/**
 * Cache reuse losses with a best-effort reason: a compaction in between, an
 * idle gap long enough to be provider-side expiry, or unknown.
 *
 * Compactions come from the `events` table: one query for the sessions in
 * play, never one per loss.
 */
export function cacheDropsOf(db: Database, rows: readonly StepRow[], options?: { ttlHintMs?: number }): CacheDropRow[] {
  const ttlHint = options?.ttlHintMs ?? DEFAULT_TTL_HINT_MS
  const losses: Array<{ previous: StepRow; current: StepRow; tokens: number; gapMs: number | undefined }> = []
  for (const { previous, current } of pairsOf(rows)) {
    const tokens = cacheDrop(message(previous), message(current))
    if (tokens === undefined) continue
    losses.push({ previous, current, tokens, gapMs: stepGap(message(previous), message(current)) })
  }
  if (losses.length === 0) return []

  const compactions = new Map<string, number[]>()
  const sessionIDs = [...new Set(losses.map((loss) => loss.current.sessionID))]
  const events = db
    .query(
      `SELECT session_id, at FROM events
        WHERE kind = 'compaction' AND at IS NOT NULL AND session_id IN (${sessionIDs.map(() => "?").join(", ")})
        ORDER BY at`,
    )
    .all(...sessionIDs) as { session_id: string; at: number }[]
  for (const event of events) {
    const list = compactions.get(event.session_id)
    if (list !== undefined) list.push(event.at)
    else compactions.set(event.session_id, [event.at])
  }

  return losses
    .map((loss) => {
      const ended = loss.previous.completedAt ?? loss.previous.streamedAt ?? loss.previous.createdAt
      const compacted = (compactions.get(loss.current.sessionID) ?? []).some((time) => ended !== undefined && time >= ended && time <= loss.current.at)
      const reason: DropReason = compacted ? "compaction" : loss.gapMs !== undefined && loss.gapMs >= ttlHint ? "expired" : "unknown"
      return {
        sessionID: loss.current.sessionID,
        messageID: loss.current.messageID,
        providerID: loss.current.providerID,
        modelID: loss.current.modelID,
        variant: loss.current.variant,
        at: loss.current.at,
        tokens: loss.tokens,
        gapMs: loss.gapMs,
        prevCached: loss.previous.cached,
        reason,
      }
    })
    .sort((left, right) => left.at - right.at)
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

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

export type EndpointRow = EndpointSummary & {
  modelID: string
  variant: string | undefined
}

/** The numbers of one group of steps. */
function endpointValues(steps: readonly StepRow[]): { cache: CacheStats; tps: number | undefined; wall: number | undefined } {
  const wall: number[] = []
  const tps: number[] = []
  for (const step of steps) {
    const timing = timingOf(step)
    if (timing.wall !== undefined) wall.push(timing.wall)
    if (timing.tps !== undefined) tps.push(timing.tps)
  }
  return { cache: cacheStatsOfSteps(steps), tps: latencyStats(tps).p50, wall: latencyStats(wall).p50 }
}

function endpointOf(steps: readonly StepRow[], models: string): Omit<EndpointSummary, "endpoint"> & { endpoint: string | undefined } {
  const values = endpointValues(steps)
  const times = steps.map((step) => step.at)
  return {
    endpoint: steps[0]!.router,
    models: models.split("\u0000"),
    share: 0,
    usage: usageOf(steps),
    cache: values.cache,
    tps: values.tps,
    wall: values.wall,
    firstAt: times.length > 0 ? Math.min(...times) : undefined,
    lastAt: times.length > 0 ? Math.max(...times) : undefined,
  }
}

const modelNames = (steps: readonly StepRow[]): string =>
  [...new Set(steps.map((step) => modelKey(step.modelID ?? "(unknown)", step.variant)))].map((key) => modelLabel(key.slice(0, key.indexOf("#")), key.slice(key.indexOf("#") + 1) || undefined)).join("\u0000")

/** One row per endpoint, over every model it served. */
export function endpointSummaryOf(rows: readonly StepRow[]): EndpointSummary[] {
  const out: EndpointSummary[] = []
  for (const steps of groupBy(rows, (step) => step.router ?? "").values()) {
    const summary = endpointOf(steps, modelNames(steps))
    out.push({ ...summary, share: rows.length === 0 ? 0 : steps.length / rows.length })
  }
  return out.sort((left, right) => right.usage.steps - left.usage.steps || (left.endpoint ?? "").localeCompare(right.endpoint ?? ""))
}

/** One row per model × endpoint: where each model was served, and how much. */
export function endpointBreakdownOf(rows: readonly StepRow[]): EndpointRow[] {
  const out: EndpointRow[] = []
  for (const [model, modelRows] of groupBy(rows, (step) => modelKey(step.modelID ?? "(unknown)", step.variant))) {
    for (const steps of groupBy(modelRows, (step) => step.router ?? "").values()) {
      const [modelID, variant] = [model.slice(0, model.indexOf("#")), model.slice(model.indexOf("#") + 1)]
      out.push({
        ...endpointOf(steps, model),
        modelID,
        variant: variant === "" ? undefined : variant,
        share: steps.length / modelRows.length,
      })
    }
  }
  return out.sort((left, right) => right.usage.steps - left.usage.steps || right.cache.cached - left.cache.cached)
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

/** Key, label and local start of the period `at` falls in. */
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
export function periodsOf(rows: readonly StepRow[], granularity: PeriodGranularity): PeriodRow[] {
  const out: PeriodRow[] = []
  for (const [key, steps] of groupBy(rows, (step) => periodStart(step.at, granularity).key)) {
    const period = periodStart(steps[0]!.at, granularity)
    out.push({
      key,
      label: period.label,
      at: period.start,
      steps: steps.length,
      sessions: new Set(steps.map((step) => step.sessionID)).size,
      usage: usageOf(steps),
      cache: cacheStatsOfSteps(steps),
    })
  }
  return out.sort((left, right) => left.at - right.at)
}
