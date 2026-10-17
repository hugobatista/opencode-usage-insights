import type { Database } from "bun:sqlite"
import { formatTokens } from "./core"
import {
  affinityReport,
  cacheStats,
  coverageReport,
  gapReport,
  groupBy,
  latencyGroups,
  modelKey,
  periodReport,
  periodStart,
  endpointBreakdown,
  endpointSummary,
  stepFacts,
  type CacheStats,
  type Filters,
  type StepFact,
} from "./stats/insights"
import { cacheDrops, cacheTtlEvidence, latency, models, overview, sessions, turns } from "./stats/queries"
import { STEP_TIME } from "./stats/insights"
import {
  affinityLines,
  cacheLines,
  latencyLines,
  modelsLines,
  overviewLines,
  periodLines,
  endpointSummaryLines,
  endpointsLines,
  sessionsLines,
  turnsLines,
  type CacheModelRow,
  type Granularity,
  type LineFormatOptions,
  type PanelLine,
  type PanelRow,
  type PanelView,
  type RangeKey,
} from "./panel-data"

/**
 * The panel's data assembly: read the database, run the queries the active view
 * needs and hand plain lines to the renderer. Kept out of the component so
 * every view can be asserted from an in-memory database, exactly as the CLI
 * report renders it.
 */

export type TurnsScope = "session" | "all"

/** Everything the panel shows, in one request object. */
export type PanelRequest = {
  db: Database
  view: PanelView
  range: RangeKey
  filters: Filters
  granularity: Granularity
  turnsScope: TurnsScope
  sort: string
  sortDesc: boolean
  sessionID: string
  sessionStart: number | undefined
  now: number
  format?: LineFormatOptions | undefined
  /** Drill-down target: when set, the panel shows this detail instead. */
  detail?: PanelRow | undefined
  width: number
}

/** Sorting options per view; the first is the default. */
export const SORT_KEYS: Partial<Record<PanelView, readonly string[]>> = {
  models: ["steps", "cached", "hit", "out", "cost"],
  endpoints: ["steps", "cached", "hit", "cost", "share", "tps"],
  affinity: ["changes", "lost", "steps"],
  latency: ["n", "tps", "wall"],
  sessions: ["last", "steps", "cached", "cost"],
  turns: ["time", "cost", "tokens"],
}

export function sortKeys(view: PanelView): readonly string[] {
  return SORT_KEYS[view] ?? []
}

export function defaultSort(view: PanelView): string {
  return sortKeys(view)[0] ?? ""
}

export function nextSort(view: PanelView, current: string, step: number): string {
  const keys = sortKeys(view)
  if (keys.length === 0) return current
  const index = keys.indexOf(current)
  if (index === -1) return keys[0]!
  return keys[(index + step + keys.length) % keys.length]!
}

export function detailLabel(row: PanelRow): string {
  switch (row.kind) {
    case "model":
      return `model ${row.variant !== undefined ? `${row.value} ${row.variant}` : row.value}`
    case "session":
    case "turn":
      return `session ${row.value}`
    case "period":
      return `period ${row.value}`
    case "operator":
      return `endpoint ${row.value}`
    case "provider":
      return `provider ${row.value}`
  }
}

/** Build the panel lines for the request. Never throws: a failure is a line. */
export function buildPanel(request: PanelRequest): PanelLine[] {
  try {
    return build(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [{ text: `stats query failed: ${message}`, tone: "warning" }]
  }
}

function build(request: PanelRequest): PanelLine[] {
  const { db, view, now, sessionStart, width } = request
  // The `session` range is the session itself, not "everything recorded after it
  // started": siblings and subagents run in that window too.
  const scoped = request.range === "session" && request.sessionID !== ""
  const range = scoped ? undefined : request.range === "session" ? (sessionStart === undefined ? undefined : { from: sessionStart }) : rangeForRequest(request.range, now)
  const filters: Filters = scoped ? { ...request.filters, sessionID: request.sessionID } : request.filters
  const facts = stepFacts(db, { range, filters, withPredecessor: true })
  if (request.detail !== undefined) return buildDetail(request, facts, range)

  switch (view) {
    case "overview": {
      const usage = overview(db, range, filters)
      const sessionUsage =
        request.sessionID === "" ? undefined : overview(db, undefined, { ...request.filters, sessionID: request.sessionID })
      // Subagents are their own sessions; showing them apart explains why the
      // line's `sess` segment (one session) is smaller than the whole family.
      const children =
        request.sessionID === "" ? [] : sessions(db, { limit: 500 }).filter((row) => row.parentID === request.sessionID)
      return overviewLines(
        {
          usage,
          session: sessionUsage,
          ...(children.length > 0 ? { subagents: children } : {}),
          range: request.range,
          activity: activityOf(db, range, now),
          coverage: coverageReport(facts),
        },
        width,
      )
    }
    case "models": {
      const rows = sortModels(models(db, range, filters), request.sort, request.sortDesc)
      const affinity = affinityReport(facts)
      return modelsLines(
        rows,
        width,
        {
          cache: cacheByModel(facts),
          changes: new Map(affinity.rows.map((row) => [modelKey(row.modelID, row.variant), row.changes])),
        },
        40,
      )
    }
    case "endpoints":
      return endpointSummaryLines(sortEndpoints(endpointSummary(facts), request.sort, request.sortDesc), width, 40)
    case "affinity":
      return affinityLines(sortAffinity(affinityReport(facts), request.sort, request.sortDesc), width, 40)
    case "cache":
      return cacheLines(
        {
          drops: cacheDrops(db, { range, filters }),
          evidence: cacheTtlEvidence(db, { range, filters }),
          gap: gapReport(facts),
          models: topCacheModels(facts),
        },
        width,
      )
    case "periods":
      return periodLines(periodReport(facts, request.granularity), width, request.granularity, 40)
    case "latency": {
      const by = filters.modelID !== undefined ? "operator" : "model"
      return latencyLines(latency(db, range, filters), width, sortLatency(latencyGroups(facts, by), request.sort, request.sortDesc), 14)
    }
    case "sessions": {
      const rows = sortSessions(sessions(db, { range, filters, limit: 200 }), request.sort, request.sortDesc)
      const child = rows.filter((row) => row.parentID !== undefined && rows.some((parent) => parent.sessionID === row.parentID))
      return sessionsLines(rows, width, {
        limit: 20,
        rollup: { subagentSteps: child.reduce((sum, row) => sum + row.steps, 0), subagentCost: child.reduce((sum, row) => sum + row.cost, 0) },
      })
    }
    case "turns": {
      const sessionID = request.turnsScope === "session" ? request.sessionID : undefined
      const rows = sortTurns(turns(db, { sessionID, range, filters, limit: 300 }), request.sort, request.sortDesc)
      const titles =
        request.turnsScope === "all"
          ? new Map(sessions(db, { range, filters, limit: 200 }).map((row) => [row.sessionID, row.title ?? row.sessionID]))
          : undefined
      return turnsLines(rows.slice(0, 60), width, { ...request.format, sessionTitles: titles })
    }
  }
}

function rangeForRequest(key: RangeKey, now: number): { from?: number | undefined; to?: number | undefined } | undefined {
  switch (key) {
    case "today": {
      const start = new Date(now)
      start.setHours(0, 0, 0, 0)
      return { from: start.getTime() }
    }
    case "7d":
      return { from: now - 7 * 24 * 60 * 60 * 1000 }
    case "30d":
      return { from: now - 30 * 24 * 60 * 60 * 1000 }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Detail screens
// ---------------------------------------------------------------------------

function buildDetail(request: PanelRequest, facts: StepFact[], range: { from?: number | undefined; to?: number | undefined } | undefined): PanelLine[] {
  const row = request.detail!
  const width = request.width
  const head: PanelLine = { text: detailLabel(row), tone: "accent" }
  const back: PanelLine = { text: "backspace returns · the header shows where you came from", tone: "muted" }

  if (row.kind === "model") {
    const key = modelKey(row.value, row.variant)
    const scoped = facts.filter((fact) => modelKey(fact.modelID ?? "(unknown)", fact.variant) === key)
    const stats = cacheStats(scoped)
    return [
      head,
      {
        // The same buckets as the line and the views: `in` is uncached (fresh +
        // writes) and `prompt` is everything the provider saw.
        text: `steps ${scoped.length} · in ${formatTokens(stats.prompt - stats.cached)} · prompt ${formatTokens(stats.prompt)} · cached ${formatTokens(
          stats.cached,
        )} · write ${formatTokens(stats.cacheWrite)} · hit ${percent(stats.hit)} · p50 ${percent(stats.hitP50)}`,
        tone: "muted",
      },
      { text: "", tone: "muted" },
      ...endpointsLines(endpointBreakdown(scoped), width, 40),
      { text: "", tone: "muted" },
      ...affinityLines(affinityReport(scoped), width, 10),
      { text: "", tone: "muted" },
      back,
    ]
  }
  if (row.kind === "session" || row.kind === "turn") {
    const rows = turns(request.db, { sessionID: row.value, limit: 80 })
    return [head, { text: "", tone: "muted" }, ...turnsLines(rows, width, request.format), { text: "", tone: "muted" }, back]
  }
  if (row.kind === "operator") {
    // An endpoint detail: every model that endpoint served, then its latency.
    const scoped = facts.filter((fact) => fact.router === row.value)
    const stats = cacheStats(scoped)
    return [
      head,
      {
        text: `steps ${scoped.length} · in ${formatTokens(stats.prompt - stats.cached)} · prompt ${formatTokens(stats.prompt)} · cached ${formatTokens(
          stats.cached,
        )} · hit ${percent(stats.hit)} · p50 ${percent(stats.hitP50)}`,
        tone: "muted",
      },
      { text: "", tone: "muted" },
      ...endpointsLines(endpointBreakdown(scoped), width, 40),
      { text: "", tone: "muted" },
      ...latencyLines(latency(request.db, range, { ...request.filters, router: row.value }), width, latencyGroups(scoped, "model"), 14),
      { text: "", tone: "muted" },
      back,
    ]
  }
  if (row.kind === "period") {
    const bucket = facts.filter((fact) => periodStart(fact.at, request.granularity).key === row.value)
    return [head, { text: `${bucket.length} steps`, tone: "muted" }, { text: "", tone: "muted" }, ...endpointSummaryLines(endpointSummary(bucket), width, 40), { text: "", tone: "muted" }, back]
  }
  return [head, back]
}

function percent(value: number | undefined): string {
  return value === undefined ? "–" : `${(value * 100).toFixed(1)}%`
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortModels(rows: ReturnType<typeof models>, sort: string, desc: boolean): ReturnType<typeof models> {
  const sign = desc ? -1 : 1
  const pick = (model: (typeof rows)[number]): number => {
    if (sort === "cached") return model.totals.cached
    if (sort === "out") return model.totals.output
    if (sort === "cost") return model.totals.cost
    return model.totals.steps
  }
  return [...rows].sort((left, right) => sign * (pick(right) - pick(left)))
}

function sortEndpoints(rows: ReturnType<typeof endpointSummary>, sort: string, desc: boolean): ReturnType<typeof endpointSummary> {
  const sign = desc ? -1 : 1
  const pick = (row: (typeof rows)[number]): number => {
    if (sort === "cached") return row.cache.cached
    if (sort === "hit") return row.cache.hit ?? -1
    if (sort === "cost") return row.usage.cost
    if (sort === "share") return row.share
    if (sort === "tps") return row.tps ?? -1
    return row.usage.steps
  }
  return [...rows].sort((left, right) => sign * (pick(right) - pick(left)))
}

function sortAffinity(report: ReturnType<typeof affinityReport>, sort: string, desc: boolean): ReturnType<typeof affinityReport> {
  const sign = desc ? -1 : 1
  const pick = (row: (typeof report.rows)[number]): number => {
    if (sort === "lost") return row.cacheLost
    if (sort === "steps") return row.steps
    return row.changes
  }
  return { ...report, rows: [...report.rows].sort((left, right) => sign * (pick(right) - pick(left))) }
}

function sortLatency(rows: ReturnType<typeof latencyGroups>, sort: string, desc: boolean): ReturnType<typeof latencyGroups> {
  const sign = desc ? -1 : 1
  const pick = (row: (typeof rows)[number]): number => {
    if (sort === "tps") return row.tps.p50 ?? -1
    if (sort === "wall") return row.wall.p50 ?? -1
    return row.count
  }
  return [...rows].sort((left, right) => sign * (pick(right) - pick(left)))
}

function sortSessions(rows: ReturnType<typeof sessions>, sort: string, desc: boolean): ReturnType<typeof sessions> {
  const sign = desc ? -1 : 1
  const pick = (row: (typeof rows)[number]): number => {
    if (sort === "steps") return row.steps
    if (sort === "cached") return row.cached
    if (sort === "cost") return row.cost
    return row.lastAt ?? 0
  }
  return [...rows].sort((left, right) => sign * (pick(right) - pick(left)))
}

function sortTurns(rows: ReturnType<typeof turns>, sort: string, desc: boolean): ReturnType<typeof turns> {
  const sign = desc ? -1 : 1
  const pick = (row: (typeof rows)[number]): number => {
    if (sort === "cost") return row.totals.cost
    if (sort === "tokens") return row.totals.cached + row.totals.input + row.totals.output
    return row.endAt ?? 0
  }
  return [...rows].sort((left, right) => sign * (pick(right) - pick(left)))
}

// ---------------------------------------------------------------------------
// Small derived series
// ---------------------------------------------------------------------------

/** Token reuse per model, for the models view and the cache view. */
export function cacheByModel(facts: readonly StepFact[]): Map<string, CacheStats> {
  const groups = groupBy(facts, (fact) => modelKey(fact.modelID ?? "(unknown)", fact.variant))
  const map = new Map<string, CacheStats>()
  for (const [key, group] of groups) map.set(key, cacheStats(group))
  return map
}

function topCacheModels(facts: readonly StepFact[]): CacheModelRow[] {
  const groups = groupBy(facts, (fact) => modelKey(fact.modelID ?? "(unknown)", fact.variant))
  const rows: CacheModelRow[] = [...groups.values()].map((group) => {
    const first = group[0]!
    return { usage: { modelID: first.modelID ?? "(unknown)", variant: first.variant }, cache: cacheStats(group) }
  })
  return rows.sort((left, right) => right.cache.cached - left.cache.cached).slice(0, 10)
}

/**
 * Steps per bucket for the overview sparkline. The bucket size is chosen so a
 * range reads as roughly 48 bars, and always from a fixed ladder so the axis is
 * stable between refreshes.
 */
function activityOf(db: Database, range: { from?: number | undefined; to?: number | undefined } | undefined, now: number): number[] {
  // All time has no lower bound: span the recorded window instead of starting
  // at the epoch, or the sparkline would be one bar of data and 46 of nothing.
  const earliest = db.query(`SELECT MIN(${STEP_TIME}) AS at FROM steps`).get() as { at: number | null } | null
  const from = range?.from ?? earliest?.at ?? 0
  const to = range?.to ?? now
  const span = Math.max(1, to - from)
  const ladder = [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 3 * 86_400_000, 7 * 86_400_000, 30 * 86_400_000]
  const bucket = ladder.find((size) => span / size <= 48) ?? ladder[ladder.length - 1]!
  const rows = db
    .query(
      `SELECT CAST(COALESCE(created_at, recorded_at) / ? AS INTEGER) AS bucket, COUNT(*) AS steps
         FROM steps
        WHERE COALESCE(created_at, recorded_at) >= ?
        GROUP BY bucket ORDER BY bucket`,
    )
    .all(bucket, from) as { bucket: number; steps: number }[]
  if (rows.length === 0) return []
  const first = Math.floor(from / bucket)
  const last = rows[rows.length - 1]!.bucket
  const series: number[] = []
  for (let index = first; index <= last; index += 1) {
    series.push(rows.find((row) => row.bucket === index)?.steps ?? 0)
  }
  return series
}
