import {
  displayTotals,
  formatClock,
  formatCost,
  formatDuration,
  formatLine,
  formatTokens,
  type LineFields,
  type LineIdentity,
  type LineLabels,
  type TurnStats,
  type TurnTotalsView,
} from "./core"
import type {
  CacheDropRow,
  LatencyReport,
  ModelUsage,
  Overview,
  Range,
  SessionUsage,
  TurnUsage,
  TtlEvidenceRow,
} from "./stats/queries"
import type { DbInfo } from "./stats/maintenance"
import type {
  AffinityReport,
  CacheStats,
  CoverageReport,
  EndpointRow,
  EndpointSummary,
  GapReport,
  LatencyGroupRow,
  PeriodGranularity,
  PeriodRow,
} from "./stats/aggregates"
import { modelKey } from "./stats/queries"
import { sanitizeText } from "./text"

/**
 * View models and formatting for the stats panel. Everything here is pure:
 * the panel component feeds query results in and renders the lines out, which
 * keeps the layout testable without a terminal. Lines may carry a `row`, the
 * identity the cursor selects and Enter drills into.
 */

export const PANEL_NAME = "usage-insights"

export const PANEL_VIEWS = ["overview", "models", "endpoints", "affinity", "cache", "periods", "latency", "sessions", "turns", "db"] as const
export type PanelView = (typeof PANEL_VIEWS)[number]

export const RANGE_KEYS = ["session", "today", "7d", "30d", "all"] as const
export type RangeKey = (typeof RANGE_KEYS)[number]

export const GRANULARITIES = ["day", "week", "month"] as const
export type Granularity = (typeof GRANULARITIES)[number]

export type PanelTone = "base" | "muted" | "warning" | "accent"

/** What a selectable line stands for; Enter drills into it. */
export type PanelRow = {
  kind: "model" | "session" | "period" | "endpoint" | "provider" | "turn" | "prune"
  value: string
  variant?: string | undefined
}

export type PanelLine = {
  text: string
  tone?: PanelTone
  row?: PanelRow | undefined
}

/** The views and ranges, as the command and the panel header understand them. */
export function parseArgs(input: string | undefined): { view?: PanelView; range?: RangeKey } {
  const parsed: { view?: PanelView; range?: RangeKey } = {}
  for (const token of (input ?? "").split(/\s+/)) {
    const value = token.trim().toLowerCase()
    if (value === "") continue
    // `providers` was this view's name before the endpoint became the identity.
    const view = value === "providers" ? "endpoints" : value
    if ((PANEL_VIEWS as readonly string[]).includes(view)) parsed.view = view as PanelView
    else if ((RANGE_KEYS as readonly string[]).includes(value)) parsed.range = value as RangeKey
  }
  return parsed
}

export function rangeFor(key: RangeKey, now: number, sessionStart?: number | undefined): Range | undefined {
  switch (key) {
    case "session":
      return sessionStart === undefined ? undefined : { from: sessionStart }
    case "today": {
      const start = new Date(now)
      start.setHours(0, 0, 0, 0)
      return { from: start.getTime() }
    }
    case "7d":
      return { from: now - 7 * 24 * 60 * 60 * 1000 }
    case "30d":
      return { from: now - 30 * 24 * 60 * 60 * 1000 }
    case "all":
      return undefined
  }
}

export function rangeLabel(key: RangeKey): string {
  switch (key) {
    case "session":
      return "this session"
    case "today":
      return "today"
    case "7d":
      return "7 days"
    case "30d":
      return "30 days"
    case "all":
      return "all time"
  }
}

export function nextIn<Value>(values: readonly Value[], current: Value, step: number): Value {
  const index = values.indexOf(current)
  if (index === -1) return values[0]!
  return values[(index + step + values.length) % values.length]!
}

/** Which turns the `turns` view lists: the open session, or every session. */
export type TurnsScope = "session" | "all"

/**
 * Everything the panel remembers between openings. Stored through the host's
 * durable storage, so the panel reopens where the user left it.
 */
export type PanelSettings = {
  view: PanelView
  range: RangeKey
  sort: string
  sortDesc: boolean
  granularity: Granularity
  turnsScope: TurnsScope
  /** Empty string means "no filter". */
  modelID: string
  /** The routing endpoint that served the request. */
  routerID: string
}

export const DEFAULT_SETTINGS: PanelSettings = {
  view: "overview",
  range: "all",
  sort: "",
  sortDesc: true,
  granularity: "day",
  turnsScope: "session",
  modelID: "",
  routerID: "",
}

/** Merge persisted state with the defaults, dropping anything unrecognized. */
export function sanitizeSettings(raw: Partial<PanelSettings> | undefined): PanelSettings {
  const settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
  return {
    view: (PANEL_VIEWS as readonly string[]).includes(settings.view) ? settings.view : DEFAULT_SETTINGS.view,
    range: (RANGE_KEYS as readonly string[]).includes(settings.range) ? settings.range : DEFAULT_SETTINGS.range,
    sort: typeof settings.sort === "string" ? settings.sort : DEFAULT_SETTINGS.sort,
    sortDesc: settings.sortDesc === true,
    granularity: (GRANULARITIES as readonly string[]).includes(settings.granularity) ? settings.granularity : DEFAULT_SETTINGS.granularity,
    turnsScope: settings.turnsScope === "all" ? "all" : "session",
    modelID: typeof settings.modelID === "string" ? settings.modelID : "",
    routerID: typeof settings.routerID === "string" ? settings.routerID : "",
  }
}

// ---------------------------------------------------------------------------
// Primitive formatting
// ---------------------------------------------------------------------------

export function formatPercent(value: number | undefined, digits = 1): string {
  return value === undefined ? "–" : `${(value * 100).toFixed(digits)}%`
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

export function formatMs(value: number | undefined): string {
  if (value === undefined) return "–"
  if (value < 1_000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`
  return formatDuration(value)
}

export function formatTps(value: number | undefined): string {
  return value === undefined ? "–" : `${value.toFixed(1)}/s`
}

/** Idle gaps are read at a glance: seconds, minutes, hours, days. */
export function formatGap(value: number | undefined): string {
  if (value === undefined) return "–"
  if (value < 60_000) return `${Math.round(value / 1_000)}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  if (value < 86_400_000) return `${(value / 3_600_000).toFixed(1)}h`
  return `${(value / 86_400_000).toFixed(1)}d`
}

/** Cut a value to the width, dropping control characters first. */
export function truncate(value: string, width: number): string {
  if (width <= 1) return ""
  const clean = sanitizeText(value)
  if (clean.length <= width) return clean
  return `${clean.slice(0, width - 1).trimEnd()}…`
}

/** Keep both ends of a long id: the family reads first, the `#variant` last. */
export function truncateMiddle(value: string, width: number): string {
  if (width <= 1) return ""
  const clean = sanitizeText(value)
  if (clean.length <= width) return clean
  const head = Math.ceil((width - 1) / 2)
  const tail = width - 1 - head
  return `${clean.slice(0, head)}…${clean.slice(clean.length - tail)}`
}

/**
 * Pick the widest column layout that fits the panel. A table that overflows
 * wraps and stops reading as a table, so the columns are chosen, not squeezed.
 */
export function tableWidths(width: number, layouts: readonly (readonly number[])[]): number[] {
  for (const layout of layouts) {
    const total = layout.reduce((sum, column) => sum + column, 0) + layout.length - 1
    if (total <= width) return [...layout]
  }
  const last = layouts[layouts.length - 1]
  return last === undefined ? [] : [...last]
}

/**
 * A model cell keeps the variant visible: two rows of the same family must not
 * read alike after truncation.
 */
export function modelCell(modelID: string, variant: string | undefined, width: number): string {
  return truncateMiddle(variant === undefined ? modelID : `${modelID} ${variant}`, width)
}

export function padCell(value: string, width: number, align: "left" | "right" = "left"): string {
  if (value.length >= width) return value
  const padding = " ".repeat(width - value.length)
  return align === "right" ? `${padding}${value}` : `${value}${padding}`
}

export function formatTableRow(cells: readonly string[], widths: readonly number[], aligns?: readonly ("left" | "right")[]): string {
  const parts: string[] = []
  for (let index = 0; index < cells.length; index += 1) {
    const width = widths[index] ?? 8
    const align = aligns?.[index] ?? "left"
    parts.push(padCell(truncate(cells[index] ?? "", width), width, align))
  }
  return parts.join(" ")
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`
}

/** Two label/value pairs per row, collapsed to one pair on narrow panels. */
export function kvGrid(pairs: readonly (readonly [string, string])[], width: number): PanelLine[] {
  const lines: PanelLine[] = []
  const label = 11
  const column = Math.floor(width / 2)
  for (let index = 0; index < pairs.length; index += 2) {
    const left = pairs[index]!
    const right = pairs[index + 1]
    const leftText = `${padCell(left[0], label)}${left[1]}`
    if (right === undefined) {
      lines.push({ text: leftText, tone: "base" })
      continue
    }
    const rightText = `${padCell(right[0], label)}${right[1]}`
    if (leftText.length + 2 <= column) {
      lines.push({ text: `${leftText}${" ".repeat(Math.max(2, column - leftText.length))}${rightText}`, tone: "base" })
    } else {
      lines.push({ text: leftText, tone: "base" })
      lines.push({ text: rightText, tone: "base" })
    }
  }
  return lines
}

const HEADER_TONE: PanelTone = "accent"
const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/** Fold a series into at most `maxBars` summed buckets, so a sparkline stays a line. */
export function reduceSeries(values: readonly number[], maxBars = 48): number[] {
  if (values.length <= maxBars) return [...values]
  const group = Math.ceil(values.length / maxBars)
  const reduced: number[] = []
  for (let index = 0; index < values.length; index += group) {
    reduced.push(values.slice(index, index + group).reduce((sum, value) => sum + value, 0))
  }
  return reduced
}

/** Text sparkline: trends at a glance without a chart renderable. */
export function sparkline(values: readonly number[], maxBars = 48): string {
  if (values.length === 0) return ""
  const series = reduceSeries(values, maxBars)
  const max = Math.max(...series)
  if (max <= 0) return SPARK[0]!.repeat(series.length)
  return series.map((value) => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round((value / max) * (SPARK.length - 1))))]!).join("")
}

/**
 * The live line's buckets, so every aggregate the panel shows reconciles with
 * it: `in` is the uncached prompt (fresh input *and* cache writes), `prompt` is
 * what the provider saw, `out` is everything generated (visible *and*
 * reasoning). `write` and `reasoning` are the parts of `in` and `out`.
 */
export type UsageBuckets = {
  steps: number
  input: number
  prompt: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
  cost: number
  hit: number | undefined
}

export function usageBuckets(usage: {
  steps: number
  input: number
  cached: number
  cacheWrite: number
  output: number
  reasoning: number
  cost: number
}): UsageBuckets {
  const prompt = usage.input + usage.cached + usage.cacheWrite
  return {
    steps: usage.steps,
    input: prompt - usage.cached,
    prompt,
    cached: usage.cached,
    cacheWrite: usage.cacheWrite,
    output: usage.output + usage.reasoning,
    reasoning: usage.reasoning,
    cost: usage.cost,
    hit: prompt > 0 ? usage.cached / prompt : undefined,
  }
}

// ---------------------------------------------------------------------------
// Chrome shared by every view
// ---------------------------------------------------------------------------

/**
 * The view tabs. The active one is bracketed so a single tone still reads
 * clearly; on a narrow panel the names shorten instead of wrapping, and the
 * active view always keeps its full name.
 */
export function viewBar(view: PanelView, width = 200): PanelLine {
  // Ten views, nine digits: the tenth is `0`.
  const key = (index: number) => String((index + 1) % 10)
  const full = PANEL_VIEWS.map((name, index) => (name === view ? `[${key(index)} ${name}]` : `${key(index)} ${name}`))
  const candidates = [full, PANEL_VIEWS.map((name, index) => (name === view ? `[${key(index)} ${name}]` : `${key(index)} ${name.slice(0, 3)}`))]
  for (const parts of candidates) {
    const text = parts.join("  ")
    if (text.length <= width) return { text, tone: "muted" }
  }
  return { text: `[${String((PANEL_VIEWS.indexOf(view) + 1) % 10)} ${view}] · 0-9 or [ ] to switch`, tone: "muted" }
}

export function keysFor(of: PanelView): string {
  if (of === "db") return "↑↓ move · enter prune (asks first) · v vacuum · r refresh · 0-9 view · ? help"
  if (of === "periods") return "↑↓ move · enter drill · b bucket · t range · m/e filter · x clear · 0-9 view · ? help"
  if (of === "turns") return "↑↓ move · a scope · t range · 1-9 view · ? help"
  return "↑↓ move · enter drill · s sort · t range · m/e filter · x clear · 1-9 view · ? help"
}

export function filterSummary(filters: { modelID?: string | undefined; routerID?: string | undefined }): string | undefined {
  const parts: string[] = []
  if (filters.modelID !== undefined && filters.modelID !== "") parts.push(`model=${filters.modelID}`)
  if (filters.routerID !== undefined && filters.routerID !== "") parts.push(`endpoint=${filters.routerID}`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

export function granularityLabel(granularity: PeriodGranularity): string {
  return granularity === "day" ? "per day" : granularity === "week" ? "per week" : "per month"
}

/** Help overlay: the keys and the exact meaning of every number. */
export function helpLines(width: number): PanelLine[] {
  const lines: PanelLine[] = [
    { text: "keys", tone: HEADER_TONE },
    { text: "  ↑ ↓ j k      move the cursor · enter drills in · backspace goes back" },
    { text: "  0-9 [ ]      choose a view · cycle views (0 is db)" },
    { text: "  t shift+t    previous / next range" },
    { text: "  s shift+s    cycle sort column · reverse" },
    { text: "  b            periods bucket: day → week → month" },
    { text: "  a            turns scope: this session ↔ all sessions" },
    { text: "  m e          filter by model / endpoint, who served it (x clears)" },
    { text: "  r            re-read the database · f full screen · escape close" },
    { text: "" },
    { text: "numbers · the same buckets as the live line", tone: HEADER_TONE },
    { text: "  prompt    everything the provider saw: cached + fresh + writes" },
    { text: "  in        the uncached part: fresh input + cache writes" },
    { text: "  cached    prompt read from the provider prompt cache" },
    { text: "  write     part of `in`: prompt written into that cache" },
    { text: "  hit       cached / prompt, weighted over the selection" },
    { text: "  hit p50   median of the per-step hit: spots a split pattern" },
    { text: "  out       everything generated: visible output + reasoning" },
    { text: "  reasoning part of `out`" },
    { text: "  wall      request → completed step · stream request → last chunk" },
    { text: "  tps       out / streaming seconds, shown as p50" },
    { text: "  changed   the step's model or endpoint differs from the step" },
    { text: "            before it in the same session (affinity view)" },
    { text: "" },
    { text: "evidence", tone: HEADER_TONE },
    { text: "  endpoint  where the request was actually sent: the endpoint that ran" },
    { text: "            the inference in practice, and the only identity the panel" },
    { text: "            shows. The endpoint is the inference provider." },
    { text: "  recorded  the OpenCode provider is kept in the database as evidence," },
    { text: "            not surfaced: it says where a request came from, not who" },
    { text: "            ran it" },
    { text: "" },
    { text: "database", tone: HEADER_TONE },
    { text: "  the db view shows where the file lives, what it holds and how much" },
    { text: "  of it is old: enter prunes a retention, v gives the space back" },
    { text: "  local time · SQLite in the OpenCode state directory" },
  ]
  return lines.map((line) => ({ ...line, text: truncate(line.text, width) }))
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function usagePairs(usage: Overview | SessionUsage | undefined): (readonly [string, string])[] {
  if (usage === undefined) return []
  const buckets = usageBuckets(usage)
  const pairs: (readonly [string, string])[] = [
    ["steps", formatCount(buckets.steps)],
    ["in", formatTokens(buckets.input)],
    ["prompt", formatTokens(buckets.prompt)],
    ["cached", formatTokens(buckets.cached)],
    ["hit", formatPercent(buckets.hit)],
    ["out", formatTokens(buckets.output)],
    ["write", formatTokens(buckets.cacheWrite)],
  ]
  if (buckets.reasoning > 0) pairs.push(["reasoning", formatTokens(buckets.reasoning)])
  pairs.push(["cost", formatCost(buckets.cost)])
  return pairs
}

export function overviewLines(
  data: {
    usage: Overview
    session: Overview | undefined
    /** Child sessions of the open session, when it has any. */
    subagents?: readonly SessionUsage[] | undefined
    range: RangeKey
    activity?: readonly number[] | undefined
    coverage?: CoverageReport | undefined
  },
  width: number,
): PanelLine[] {
  const lines: PanelLine[] = []
  lines.push({
    text: `${rangeLabel(data.range)} · ${count(data.usage.steps, "step")} · ${count(data.usage.sessions, "session")} · ${count(data.usage.prompts, "prompt")}`,
    tone: "muted",
  })
  lines.push(...kvGrid(buildOverviewPairs(data.usage, "all"), width))
  if (data.activity !== undefined && data.activity.length > 1) {
    const series = reduceSeries(data.activity)
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: `activity ${sparkline(series)}  ${count(series.length, "bucket")}`, tone: "muted" })
  }
  if (data.session !== undefined) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "this session", tone: HEADER_TONE })
    lines.push(...kvGrid(buildOverviewPairs(data.session, "session"), width))
    if (data.subagents !== undefined && data.subagents.length > 0) {
      const steps = data.subagents.reduce((sum, row) => sum + row.steps, 0)
      const cost = data.subagents.reduce((sum, row) => sum + row.cost, 0)
      lines.push({
        text: `  subagents  ${count(data.subagents.length, "session")} · ${count(steps, "step")} · ${formatCost(cost)} (their own sessions)`,
        tone: "muted",
      })
    }
  }
  if (data.coverage !== undefined) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "data coverage", tone: HEADER_TONE })
    lines.push(...kvGrid(coveragePairs(data.coverage), width))
  }
  return lines
}

function buildOverviewPairs(usage: Overview, scope: "all" | "session"): (readonly [string, string])[] {
  const pairs = usagePairs(usage)
  if (scope === "all") {
    pairs.push(["first", usage.firstAt === undefined ? "–" : new Date(usage.firstAt).toLocaleString("en-GB")])
    pairs.push(["last", usage.lastAt === undefined ? "–" : new Date(usage.lastAt).toLocaleString("en-GB")])
  }
  return pairs
}

function coveragePairs(coverage: CoverageReport): (readonly [string, string])[] {
  const share = (missing: number) => (coverage.steps === 0 ? "–" : `${((missing / coverage.steps) * 100).toFixed(1)}%`)
  return [
    ["models", `${formatCount(coverage.models)} · unknown ${share(coverage.missingModel)}`],
    ["endpoints", `${formatCount(coverage.endpoints)} · unknown ${share(coverage.missingEndpoint)}`],
    ["unsettled", `${formatCount(coverage.unsettled)} · no tps ${share(coverage.missingTps)}`],
    [
      "window",
      `${coverage.firstAt === undefined ? "–" : new Date(coverage.firstAt).toLocaleString("en-GB")} → ${
        coverage.lastAt === undefined ? "–" : new Date(coverage.lastAt).toLocaleString("en-GB")
      }`,
    ],
  ]
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

type ModelColumns = {
  model: number
  steps: number
  prompt: number
  cached: number
  hit: number
  out: number
  cost: number
  spread: number
}

function modelColumns(width: number): ModelColumns {
  const layouts = [
    { model: 30, steps: 6, prompt: 10, cached: 10, hit: 7, out: 9, cost: 9, spread: 24 },
    { model: 26, steps: 6, prompt: 9, cached: 9, hit: 7, out: 8, cost: 8, spread: 20 },
    { model: 20, steps: 6, prompt: 9, cached: 9, hit: 6, out: 8, cost: 8, spread: 0 },
    { model: 18, steps: 5, prompt: 8, cached: 8, hit: 0, out: 7, cost: 8, spread: 0 },
    { model: 14, steps: 5, prompt: 8, cached: 8, hit: 0, out: 7, cost: 0, spread: 0 },
  ]
  for (const layout of layouts) {
    const total = Object.values(layout).reduce((sum, column) => sum + column, 0) + Object.values(layout).filter((column) => column > 0).length - 1
    if (total <= width) return layout
  }
  return layouts[layouts.length - 1]!
}

export type ModelExtras = {
  /** Reuse stats per `modelKey`, computed from the step facts. */
  cache?: Map<string, CacheStats> | undefined
  /** Identity changes per `modelKey`, from the affinity report. */
  changes?: Map<string, number> | undefined
}

/**
 * Usage per model with the cache it actually got, where it was served from and
 * how often its identity changed. One line per model; `providers` keeps the
 * per-provider detail.
 */
export function modelsLines(rows: readonly ModelUsage[], width: number, extras?: ModelExtras, limit = 40): PanelLine[] {
  const columns = modelColumns(width)
  const widths: number[] = [columns.model, columns.steps, columns.prompt, columns.cached]
  const aligns: ("left" | "right")[] = ["left", "right", "right", "right"]
  const header: string[] = ["model", "steps", "prompt", "cached"]
  if (columns.hit > 0) {
    widths.push(columns.hit)
    aligns.push("right")
    header.push("hit")
  }
  widths.push(columns.out)
  aligns.push("right")
  header.push("out")
  if (columns.cost > 0) {
    widths.push(columns.cost)
    aligns.push("right")
    header.push("cost")
  }
  if (columns.spread > 0) {
    widths.push(columns.spread)
    aligns.push("left")
    header.push("served by")
  }
  const lines: PanelLine[] = [{ text: formatTableRow(header, widths, aligns), tone: HEADER_TONE }]

  for (const model of rows.slice(0, limit)) {
    const key = modelKey(model.modelID, model.variant)
    const name = modelCell(model.modelID, model.variant, columns.model)
    const buckets = usageBuckets(model.totals)
    // The endpoint is the identity that actually served the request; the
    // provider is where it came from, kept as evidence but not shown here.
    const endpoints = unique(model.providers.flatMap((provider) => provider.routers))
    const cache = extras?.cache?.get(key)
    const changes = extras?.changes?.get(key)
    const cells: string[] = [name, formatCount(buckets.steps), formatTokens(buckets.prompt), formatTokens(buckets.cached)]
    if (columns.hit > 0) cells.push(formatPercent(cache?.hit ?? buckets.hit))
    cells.push(formatTokens(buckets.output))
    if (columns.cost > 0) cells.push(formatCost(buckets.cost))
    if (columns.spread > 0) cells.push(endpoints.length > 0 ? endpoints.join(", ") : "–")
    lines.push({
      text: formatTableRow(cells, widths, aligns),
      tone: "base",
      row: { kind: "model", value: model.modelID, ...(model.variant !== undefined ? { variant: model.variant } : {}) },
    })
    const details: string[] = []
    if (cache !== undefined) details.push(`p50 hit ${formatPercent(cache.hitP50)}`)
    if (changes !== undefined && changes > 0) details.push(count(changes, "identity change"))
    if (endpoints.length === 0) details.push("no routing endpoint observed")
    if (details.length > 0) {
      lines.push({ text: truncate(`${" ".repeat(columns.model + 1)}${details.join(" · ")}`, width), tone: "muted" })
    }
  }
  if (rows.length > limit) lines.push({ text: `… ${count(rows.length - limit, "more model")} · narrow the range or filter`, tone: "muted" })
  if (rows.length === 0) lines.push({ text: "no usage recorded for this range", tone: "muted" })
  return lines
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

// ---------------------------------------------------------------------------
// Providers (model × provider × endpoint)
// ---------------------------------------------------------------------------

/**
 * A table column. Header, width, alignment and cell come from the same spec, so
 * dropping an optional column can never shift the others.
 */
type ColumnSpec<Row> = {
  header: string
  width: number
  align?: "left" | "right"
  cell: (row: Row) => string
  /** Columns marked optional are dropped, last one first, until the table fits. */
  optional?: boolean
}

const tableWidth = <Row>(columns: readonly ColumnSpec<Row>[]): number => columns.reduce((sum, column) => sum + column.width, 0) + columns.length - 1

function fitColumns<Row>(columns: readonly ColumnSpec<Row>[], width: number): ColumnSpec<Row>[] {
  const chosen = [...columns]
  while (chosen.length > 1 && tableWidth(chosen) > width) {
    const optional = [...chosen].reverse().findIndex((column) => column.optional === true)
    if (optional === -1) break
    chosen.splice(chosen.length - 1 - optional, 1)
  }
  return chosen
}

function renderTable<Row>(
  rows: readonly Row[],
  columns: readonly ColumnSpec<Row>[],
  width: number,
  options: { limit: number; empty: string; row?: (row: Row) => PanelRow | undefined; tone?: (row: Row) => PanelTone },
): PanelLine[] {
  const chosen = fitColumns(columns, width)
  const widths = chosen.map((column) => column.width)
  const aligns = chosen.map((column) => column.align ?? "left")
  const alignsTyped = aligns as ("left" | "right")[]
  const lines: PanelLine[] = [{ text: formatTableRow(chosen.map((column) => column.header), widths, alignsTyped), tone: HEADER_TONE }]
  if (rows.length === 0) lines.push({ text: options.empty, tone: "muted" })
  for (const row of rows.slice(0, options.limit)) {
    const identity = options.row?.(row)
    lines.push({
      text: formatTableRow(
        chosen.map((column) => column.cell(row)),
        widths,
        alignsTyped,
      ),
      tone: options.tone?.(row) ?? "base",
      ...(identity === undefined ? {} : { row: identity }),
    })
  }
  if (rows.length > options.limit) lines.push({ text: `… ${count(rows.length - options.limit, "more row")}`, tone: "muted" })
  return lines
}

/** One row per endpoint, over every model it served. */
export function endpointSummaryLines(rows: readonly EndpointSummary[], width: number, limit = 40): PanelLine[] {
  const lines = renderTable(
    rows,
    [
      { header: "endpoint", width: 24, cell: (row) => truncate(row.endpoint ?? "– (never observed)", 24) },
      { header: "models", width: 13, align: "right", optional: true, cell: (row) => formatCount(row.models.length) },
      { header: "steps", width: 6, align: "right", cell: (row) => formatCount(row.usage.steps) },
      { header: "share", width: 6, align: "right", optional: true, cell: (row) => formatPercent(row.share, 0) },
      { header: "prompt", width: 10, align: "right", cell: (row) => formatTokens(row.cache.prompt) },
      { header: "cached", width: 10, align: "right", cell: (row) => formatTokens(row.cache.cached) },
      { header: "hit", width: 7, align: "right", optional: true, cell: (row) => formatPercent(row.cache.hit) },
      { header: "tps p50", width: 8, align: "right", optional: true, cell: (row) => formatTps(row.tps) },
      { header: "wall", width: 8, align: "right", optional: true, cell: (row) => formatMs(row.wall) },
      { header: "cost", width: 9, align: "right", optional: true, cell: (row) => formatCost(row.usage.cost) },
    ],
    width,
    {
      limit,
      empty: "no routing endpoint was observed in this range",
      // A request whose destination was never observed is not a row to drill into.
      row: (row) => (row.endpoint === undefined ? undefined : { kind: "endpoint", value: row.endpoint }),
      tone: (row) => (row.endpoint === undefined ? "muted" : "base"),
    },
  )
  return lines
}

/** One row per model × endpoint: the endpoints that served each model. */
export function endpointsLines(rows: readonly EndpointRow[], width: number, limit = 40): PanelLine[] {
  return renderTable(
    rows,
    [
      { header: "model", width: 26, cell: (row) => modelCell(row.modelID, row.variant, 26) },
      { header: "endpoint", width: 22, cell: (row) => truncate(row.endpoint ?? "– (never observed)", 22) },
      { header: "steps", width: 6, align: "right", cell: (row) => formatCount(row.usage.steps) },
      { header: "share", width: 6, align: "right", optional: true, cell: (row) => formatPercent(row.share, 0) },
      { header: "prompt", width: 10, align: "right", cell: (row) => formatTokens(row.cache.prompt) },
      { header: "cached", width: 10, align: "right", cell: (row) => formatTokens(row.cache.cached) },
      { header: "hit", width: 7, align: "right", optional: true, cell: (row) => formatPercent(row.cache.hit) },
      { header: "tps p50", width: 8, align: "right", optional: true, cell: (row) => formatTps(row.tps) },
      { header: "wall", width: 8, align: "right", optional: true, cell: (row) => formatMs(row.wall) },
      { header: "cost", width: 9, align: "right", optional: true, cell: (row) => formatCost(row.usage.cost) },
    ],
    width,
    {
      limit,
      empty: "no usage recorded for this range",
      row: (row) => ({ kind: "model", value: row.modelID, ...(row.variant !== undefined ? { variant: row.variant } : {}) }),
      tone: (row) => (row.endpoint === undefined ? "muted" : "base"),
    },
  )
}

// ---------------------------------------------------------------------------
// Affinity
// ---------------------------------------------------------------------------

export function affinityLines(report: AffinityReport, width: number, limit = 40): PanelLine[] {
  const lines: PanelLine[] = []
  const rate = report.totals.pairs === 0 ? undefined : report.totals.changes / report.totals.pairs
  lines.push({
    text: `${count(report.totals.pairs, "comparable step pair")} · ${count(report.totals.changes, "identity change")} (${formatPercent(rate)}) · cache lost on change ${formatTokens(
      report.totals.cacheLost,
    )}`,
    tone: report.totals.changes > 0 ? "warning" : "muted",
  })
  lines.push({ text: "a change is the step's model or endpoint differing from the step before it", tone: "muted" })
  lines.push({ text: "", tone: "muted" })

  const widths = tableWidths(width, [
    [28, 7, 8, 9, 9, 11, 9],
    [18, 6, 7, 8, 8, 9, 8],
  ])
  const header = ["model", "steps", "changes", "model", "endpoint", "cache lost", "avg"]
  lines.push({ text: formatTableRow(header, widths, widths.map((_, index) => (index === 0 ? "left" : "right"))), tone: HEADER_TONE })
  if (report.rows.length === 0) {
    lines.push({ text: "no comparable consecutive steps in this range", tone: "muted" })
  }
  for (const row of report.rows.slice(0, limit)) {
    const perChange = row.cacheLostEvents > 0 ? row.cacheLost / row.cacheLostEvents : undefined
    lines.push({
      text: formatTableRow(
        [
          modelCell(row.modelID, row.variant, widths[0]!),
          formatCount(row.steps),
          formatCount(row.changes),
          formatCount(row.modelChanges),
          formatCount(row.endpointChanges),
          row.cacheLost > 0 ? `−${formatTokens(row.cacheLost)}` : "–",
          perChange === undefined ? "–" : `−${formatTokens(perChange)}`,
        ],
        widths,
        widths.map((_, index) => (index === 0 ? "left" : "right")),
      ),
      tone: row.changes > 0 ? "warning" : "base",
      row: { kind: "model", value: row.modelID, ...(row.variant !== undefined ? { variant: row.variant } : {}) },
    })
  }
  if (report.rows.length > limit) lines.push({ text: `… ${count(report.rows.length - limit, "more model")}`, tone: "muted" })

  if (report.transitions.length > 0) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "top transitions", tone: HEADER_TONE })
    for (const transition of report.transitions.slice(0, 8)) {
      lines.push({
        text: truncate(`  ${padCell(transition.dimension, 9)}${transition.from} → ${transition.to}  ×${formatCount(transition.count)}`, width),
        tone: "muted",
      })
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** One model's reuse row, shared by the models and cache views. */
export type CacheModelRow = {
  usage: { modelID: string; variant: string | undefined }
  cache: CacheStats
}

export function cacheLines(
  data: {
    drops: readonly CacheDropRow[]
    evidence: readonly TtlEvidenceRow[]
    gap?: GapReport | undefined
    models?: readonly CacheModelRow[] | undefined
  },
  width: number,
): PanelLine[] {
  const lines: PanelLine[] = []
  const total = data.drops.reduce((sum, drop) => sum + drop.tokens, 0)
  lines.push({ text: `reuse losses  ${count(data.drops.length, "event")} · ${formatTokens(total)} tokens`, tone: total > 0 ? "warning" : "base" })
  for (const reason of ["expired", "compaction", "unknown"] as const) {
    const group = data.drops.filter((drop) => drop.reason === reason)
    if (group.length === 0) continue
    const tokens = group.reduce((sum, drop) => sum + drop.tokens, 0)
    lines.push({ text: `  ${padCell(reason, 11)}${formatCount(group.length)} · ${formatTokens(tokens)}`, tone: reason === "expired" ? "warning" : "muted" })
  }
  if (data.drops.length === 0) lines.push({ text: "  none: prompt cache held through every gap", tone: "muted" })

  if (data.models !== undefined && data.models.length > 0) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "reuse by model", tone: HEADER_TONE })
    const widths = width >= 100 ? [30, 7, 11, 10, 8, 8, 10] : [18, 6, 9, 9, 7, 7, 9]
    lines.push({ text: formatTableRow(["model", "steps", "prompt", "cached", "write", "hit", "hit p50"], widths, ["left", "right", "right", "right", "right", "right", "right"]), tone: "muted" })
    for (const row of data.models.slice(0, 10)) {
      const name = modelCell(row.usage.modelID, row.usage.variant, widths[0]!)
      lines.push({
        text: formatTableRow(
          [name, formatCount(row.cache.steps), formatTokens(row.cache.prompt), formatTokens(row.cache.cached), formatTokens(row.cache.cacheWrite), formatPercent(row.cache.hit), formatPercent(row.cache.hitP50)],
          widths,
          ["left", "right", "right", "right", "right", "right", "right"],
        ),
        tone: "base",
        row: { kind: "model", value: row.usage.modelID, ...(row.usage.variant !== undefined ? { variant: row.usage.variant } : {}) },
      })
    }
  }

  if (data.gap !== undefined && data.gap.samples > 0) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "cache survival against idle time", tone: HEADER_TONE })
    const widths = [9, 8, 9, 9, 10]
    lines.push({ text: formatTableRow(["gap", "pairs", "kept", "drops", "lost"], widths, ["left", "right", "right", "right", "right"]), tone: "muted" })
    for (const bucket of data.gap.buckets) {
      if (bucket.samples === 0) continue
      lines.push({
        text: formatTableRow(
          [bucket.label, formatCount(bucket.samples), formatPercent(bucket.retainedRatio, 0), formatCount(bucket.drops), formatTokens(bucket.lostTokens)],
          widths,
          ["left", "right", "right", "right", "right"],
        ),
        tone: bucket.drops > 0 ? "warning" : "base",
      })
    }
    if (data.gap.endpoints.length > 1) {
      lines.push({ text: "", tone: "muted" })
      lines.push({ text: "reuse kept, by endpoint", tone: HEADER_TONE })
      const endpointWidths = [26, 8, 9, 9]
      lines.push({ text: formatTableRow(["endpoint", "pairs", "kept", "lost"], endpointWidths, ["left", "right", "right", "right"]), tone: "muted" })
      for (const row of data.gap.endpoints.slice(0, 8)) {
        lines.push({
          text: formatTableRow([row.endpoint, formatCount(row.samples), formatPercent(row.retainedRatio, 0), formatTokens(row.lostTokens)], endpointWidths, ["left", "right", "right", "right"]),
          tone: "base",
        })
      }
    }
  }

  lines.push({ text: "", tone: "muted" })
  lines.push({ text: "observed cache TTL bounds", tone: HEADER_TONE })
  if (data.evidence.length === 0) {
    lines.push({ text: "  no comparable step pairs yet", tone: "muted" })
  } else {
    const widths = [Math.max(18, Math.floor(width * 0.4)), 14, 12, 9]
    lines.push({ text: formatTableRow(["model", "hits up to", "drops from", "samples"], widths, ["left", "right", "right", "right"]), tone: "muted" })
    for (const row of data.evidence.slice(0, 10)) {
      lines.push({
        text: formatTableRow(
          [`${row.providerID}/${row.modelID}`, formatGap(row.maxHitGapMs), formatGap(row.minDropGapMs), formatCount(row.samples)],
          widths,
          ["left", "right", "right", "right"],
        ),
        tone: "base",
      })
    }
  }

  if (data.drops.length > 0) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "recent losses", tone: HEADER_TONE })
    for (const drop of [...data.drops].sort((a, b) => b.at - a.at).slice(0, 8)) {
      const when = new Date(drop.at).toLocaleTimeString("en-GB")
      lines.push({
        text: formatTableRow(
          [when, `${drop.providerID ?? ""}/${drop.modelID ?? ""}`, `−${formatTokens(drop.tokens)}`, `${formatGap(drop.gapMs)} idle · ${drop.reason}`],
          [10, Math.max(20, Math.floor(width * 0.42)), 10, 24],
          ["left", "left", "right", "left"],
        ),
        tone: drop.reason === "expired" ? "warning" : "base",
      })
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export function periodLines(rows: readonly PeriodRow[], width: number, granularity: PeriodGranularity, limit = 40): PanelLine[] {
  const lines: PanelLine[] = []
  const totals = rows.reduce(
    (sum, row) => {
      sum.steps += row.usage.steps
      sum.sessions += row.sessions
      sum.input += row.usage.input
      sum.cached += row.usage.cached
      sum.cacheWrite += row.usage.cacheWrite
      sum.output += row.usage.output
      sum.reasoning += row.usage.reasoning
      sum.cost += row.usage.cost
      return sum
    },
    { steps: 0, sessions: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 },
  )
  const overall = usageBuckets(totals)
  lines.push({
    text: `${granularityLabel(granularity)} · ${count(rows.length, "period")} · ${count(totals.steps, "step")} · hit ${formatPercent(overall.hit)}`,
    tone: "muted",
  })
  if (rows.length > 1) {
    lines.push({ text: `steps   ${sparkline(rows.map((row) => row.usage.steps))}`, tone: "muted" })
    lines.push({ text: `cached  ${sparkline(rows.map((row) => row.usage.cached))}`, tone: "muted" })
    lines.push({ text: `cost    ${sparkline(rows.map((row) => Math.round(row.usage.cost * 10_000)))}`, tone: "muted" })
  }
  const withSessions = tableWidths(width, [[12, 7, 7, 11, 10, 7, 9, 9]]).length === 8
  const widths = withSessions ? [12, 7, 7, 11, 10, 7, 9, 9] : [12, 7, 11, 10, 7, 9, 9]
  const aligns: ("left" | "right")[] = widths.map((_, index) => (index === 0 ? "left" : "right"))
  const header = withSessions ? ["period", "steps", "sess", "prompt", "cached", "hit", "out", "cost"] : ["period", "steps", "prompt", "cached", "hit", "out", "cost"]
  lines.push({ text: formatTableRow(header, widths, aligns), tone: HEADER_TONE })

  const newest = [...rows].sort((left, right) => right.at - left.at).slice(0, limit)
  for (const row of newest) {
    const buckets = usageBuckets(row.usage)
    const cells = [
      row.label,
      formatCount(row.steps),
      ...(withSessions ? [formatCount(row.sessions)] : []),
      formatTokens(buckets.prompt),
      formatTokens(buckets.cached),
      formatPercent(buckets.hit, 0),
      formatTokens(buckets.output),
      formatCost(buckets.cost),
    ]
    lines.push({ text: formatTableRow(cells, widths, aligns), tone: "base", row: { kind: "period", value: row.key } })
  }
  lines.push({ text: "", tone: "muted" })
  lines.push({
    text: formatTableRow(
      [
        "total",
        formatCount(totals.steps),
        ...(withSessions ? [formatCount(totals.sessions)] : []),
        formatTokens(overall.prompt),
        formatTokens(overall.cached),
        formatPercent(overall.hit, 0),
        formatTokens(overall.output),
        formatCost(overall.cost),
      ],
      widths,
      aligns,
    ),
    tone: HEADER_TONE,
  })
  if (rows.length === 0) lines.push({ text: "no usage recorded for this range", tone: "muted" })
  return lines
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

export function latencyLines(report: LatencyReport, width: number, groups?: readonly LatencyGroupRow[] | undefined, limit = 12): PanelLine[] {
  const lines: PanelLine[] = []
  lines.push({
    text: formatTableRow(
      ["wall", "p50", formatMs(report.wall.p50), "p90", formatMs(report.wall.p90), "p99", formatMs(report.wall.p99), `n ${formatCount(report.wall.count)}`],
      [10, 4, 9, 4, 9, 4, 9, 12],
    ),
    tone: "base",
  })
  lines.push({
    text: formatTableRow(["stream", "p50", formatMs(report.stream.p50), "p90", formatMs(report.stream.p90), "p99", formatMs(report.stream.p99)], [10, 4, 9, 4, 9, 4, 9]),
    tone: "base",
  })
  lines.push({
    text: formatTableRow(["throughput", "p50", formatTps(report.tps.p50), "p90", formatTps(report.tps.p90), "p99", formatTps(report.tps.p99)], [10, 4, 9, 4, 9, 4, 9]),
    tone: "base",
  })
  lines.push({ text: "", tone: "muted" })
  lines.push({
    text: truncate("wall = request to completed · stream = request to last chunk · throughput = output+reasoning tokens/s", width),
    tone: "muted",
  })
  if (report.wall.count === 0) lines.push({ text: "no completed steps for this range", tone: "muted" })

  if (groups !== undefined && groups.length > 0) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "by group", tone: HEADER_TONE })
    const widths = width >= 110 ? [24, 6, 9, 9, 9, 9, 9, 9] : [16, 5, 8, 8, 8, 8, 8, 8]
    const aligns: ("left" | "right")[] = ["left", "right", "right", "right", "right", "right", "right", "right"]
    lines.push({ text: formatTableRow(["group", "n", "wall p50", "wall p90", "stream", "tps p50", "tps p90", "cost"], widths, aligns), tone: "muted" })
    for (const row of groups.slice(0, limit)) {
      const thin = row.count < 5
      lines.push({
        text: formatTableRow(
          [row.label, formatCount(row.count), formatMs(row.wall.p50), formatMs(row.wall.p90), formatMs(row.stream.p50), formatTps(row.tps.p50), formatTps(row.tps.p90), formatCost(row.usage.cost)],
          widths,
          aligns,
        ),
        tone: thin ? "muted" : "base",
        row: { kind: "model", value: row.key },
      })
    }
    lines.push({ text: "n < 5 is dimmed: too few samples to compare", tone: "muted" })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function sessionsLines(
  rows: readonly SessionUsage[],
  width: number,
  options?: { limit?: number | undefined; rollup?: { subagentSteps: number; subagentCost: number } | undefined },
): PanelLine[] {
  const limit = options?.limit ?? 20
  const widths = [Math.max(18, Math.floor(width * 0.36)), 7, 11, 10, 7, 9, 9]
  const aligns: ("left" | "right")[] = ["left", "right", "right", "right", "right", "right", "right"]
  const lines: PanelLine[] = [
    { text: formatTableRow(["title", "steps", "prompt", "cached", "hit", "out", "cost"], widths, aligns), tone: HEADER_TONE },
  ]
  const byID = new Map(rows.map((row) => [row.sessionID, row]))
  const ordered = rows.filter((row) => row.parentID === undefined || !byID.has(row.parentID))
  const children = rows.filter((row) => row.parentID !== undefined && byID.has(row.parentID))
  const orderedAll = [...ordered, ...children]

  for (const row of orderedAll.slice(0, limit)) {
    const child = row.parentID !== undefined && byID.has(row.parentID)
    const title = truncate(row.title ?? row.sessionID, Math.max(8, widths[0]! - (child ? 2 : 0)))
    const buckets = usageBuckets(row)
    lines.push({
      text: formatTableRow(
        [
          `${child ? "↳ " : ""}${title}`,
          formatCount(buckets.steps),
          formatTokens(buckets.prompt),
          formatTokens(buckets.cached),
          formatPercent(buckets.hit, 0),
          formatTokens(buckets.output),
          formatCost(buckets.cost),
        ],
        widths,
        aligns,
      ),
      tone: child ? "muted" : "base",
      row: { kind: "session", value: row.sessionID },
    })
    const details = [row.directory ?? "", row.models.length > 1 ? count(row.models.length, "model") : ""].filter((part) => part !== "").join(" · ")
    lines.push({ text: truncate(`${" ".repeat(child ? 2 : 0)}  ${details}`, width), tone: "muted" })
  }
  if (options?.rollup !== undefined && options.rollup.subagentSteps > 0) {
    const share = rows.reduce((sum, row) => sum + row.steps, 0)
    lines.push({ text: "", tone: "muted" })
    lines.push({
      text: `subagents ${formatCount(options.rollup.subagentSteps)} steps (${formatPercent(share > 0 ? options.rollup.subagentSteps / share : undefined)}) · ${formatCost(
        options.rollup.subagentCost,
      )}`,
      tone: "muted",
    })
  }
  if (rows.length > limit) lines.push({ text: `… ${count(rows.length - limit, "more session")} · narrow the range`, tone: "muted" })
  if (rows.length === 0) lines.push({ text: "no sessions recorded for this range", tone: "muted" })
  return lines
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** The database view: where it lives, what it holds, and the two cleanups. */
export function dbLines(data: { info: DbInfo; busy?: boolean | undefined }, width: number): PanelLine[] {
  const lines: PanelLine[] = []
  const size = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`
  lines.push({ text: truncate(data.info.path, width), tone: "base" })
  lines.push({
    text: `${size(data.info.bytes)}${data.info.walBytes === undefined ? "" : ` + ${size(data.info.walBytes)} wal`} · schema v${data.info.schemaVersion}`,
    tone: "muted",
  })
  lines.push({ text: "", tone: "muted" })
  lines.push({ text: "what it holds", tone: HEADER_TONE })
  for (const table of data.info.tables) {
    lines.push({ text: `  ${padCell(table.name, 12)}${formatCount(table.rows)} rows`, tone: table.rows === 0 ? "muted" : "base" })
  }
  lines.push({
    text: `  window      ${data.info.firstAt === undefined ? "–" : new Date(data.info.firstAt).toLocaleDateString("en-GB")} → ${
      data.info.lastAt === undefined ? "–" : new Date(data.info.lastAt).toLocaleDateString("en-GB")
    }`,
    tone: "muted",
  })

  lines.push({ text: "", tone: "muted" })
  lines.push({ text: "clean up", tone: HEADER_TONE })
  lines.push({ text: "  enter prunes the steps older than the row · v gives the space back", tone: "muted" })
  const widths = [10, 10]
  lines.push({ text: formatTableRow(["keep", "prunes"], widths, ["left", "right"]), tone: "muted" })
  for (const option of data.info.removable) {
    lines.push({
      text: formatTableRow([`${option.days} days`, `${formatCount(option.steps)} steps`], widths, ["left", "right"]),
      tone: option.steps === 0 ? "muted" : "base",
      row: { kind: "prune", value: String(option.days) },
    })
  }
  if (data.busy === true) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "the recorder is writing: try the vacuum again in a moment", tone: "warning" })
  }
  return lines
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export type LineFormatOptions = {
  labels?: Partial<LineLabels> | undefined
  fields?: Partial<LineFields> | undefined
  turnTotals?: TurnTotalsView | undefined
  identity?: LineIdentity | undefined
}

/** The line's own view of a recorded turn, so both render identically. */
export function turnStats(turn: TurnUsage): TurnStats {
  return {
    endAt: turn.endAt,
    startAt: turn.promptAt ?? turn.endAt,
    promptAt: turn.promptAt,
    promptGapMs: turn.promptGapMs,
    providerID: turn.providerID,
    modelID: turn.modelID,
    variant: turn.variant,
    router: turn.router,
    identityChanged: turn.routerChanged,
    affinityKey: undefined,
    providerChanged: turn.providerChanged,
    modelChanged: turn.modelChanged,
    totals: turn.totals,
    latest: turn.latest,
    session: undefined,
    drops: turn.drops.map((drop) => ({ messageID: drop.messageID, tokens: drop.tokens, prevCached: 0, gapMs: drop.gapMs })),
    cacheDropTokens: turn.drops.reduce((sum, drop) => sum + drop.tokens, 0),
    cacheExpired: turn.drops.length > 0,
    steps: turn.steps,
  }
}

/**
 * Per-prompt history: one line per finished turn, rendered by the same
 * formatter as the live line (without the session segment, which would repeat
 * the same totals on every row).
 */
export function turnsLines(rows: readonly TurnUsage[], width: number, options?: LineFormatOptions & { sessionTitles?: Map<string, string> | undefined }): PanelLine[] {
  const lines: PanelLine[] = []
  const warning = rows.filter((turn) => turn.drops.length > 0).length
  lines.push({
    text: `${count(rows.length, "turn")} · newest first${warning > 0 ? ` · ${count(warning, "turn")} with a cache loss` : ""}`,
    tone: "muted",
  })
  const showSession = options?.sessionTitles !== undefined
  for (const turn of rows) {
    const line = formatLine(turnStats(turn), {
      ...options,
      fields: { ...options?.fields, session: false },
    })
    const title = showSession ? `${truncate(options!.sessionTitles!.get(turn.sessionID) ?? turn.sessionID, 18)}  ` : ""
    lines.push({
      text: truncate(`${title}${line}`, width),
      tone: turn.drops.length > 0 || turn.routerChanged ? "warning" : "base",
      row: { kind: "turn", value: turn.sessionID },
    })
  }
  if (rows.length === 0) lines.push({ text: "no finished turns for this range", tone: "muted" })
  return lines
}

/**
 * The accumulated usage of one session, as compact lines for the sidebar. The
 * buckets are the live line's, so the sidebar, the line and the panel agree.
 */
export function sessionSummaryLines(usage: Overview, budget = 34): PanelLine[] {
  const buckets = usageBuckets(usage)
  return [
    { text: truncate("session", budget), tone: HEADER_TONE },
    { text: truncate(`  ${formatCount(buckets.steps)} steps · ${formatCost(buckets.cost)}`, budget), tone: "muted" },
    { text: truncate(`  in ${formatTokens(buckets.input)} · cached ${formatTokens(buckets.cached)}`, budget), tone: "base" },
    { text: truncate(`  out ${formatTokens(buckets.output)} · hit ${formatPercent(buckets.hit)}`, budget), tone: "base" },
    { text: "", tone: "muted" },
  ]
}

/**
 * The sidebar history: two compact lines per turn — when and through which
 * endpoint, then the prompt volumes — truncated to the sidebar budget.
 */
export function sidebarLines(rows: readonly TurnUsage[], options?: LineFormatOptions & { budget?: number | undefined }): PanelLine[] {
  const budget = options?.budget ?? 34
  const labels = { input: options?.labels?.input ?? "in", output: options?.labels?.output ?? "out" }
  const lines: PanelLine[] = []
  for (const turn of rows) {
    const clock = turn.endAt !== undefined ? formatClock(turn.endAt).slice(0, 5) : "--:--"
    const identity = turn.router ?? (turn.providerID !== undefined && turn.modelID !== undefined ? `${turn.providerID}/${turn.modelID}` : "unknown")
    const display = displayTotals(turn.latest)
    const input = formatTokens(display.input)
    const prompt = formatTokens(display.prompt)
    const output = formatTokens(display.output)
    const cost = formatCost(turn.totals.cost)
    const suffix = turn.drops.length > 0 ? " · ⚠" : ""
    // The cost of the turn is always shown; when the budget is tight the
    // parenthesised prompt is the first thing to go.
    const candidates = [
      `  ${labels.input} ${input} (${prompt}) · ${labels.output} ${output} · ${cost}${suffix}`,
      `  ${labels.input} ${input} · ${labels.output} ${output} · ${cost}${suffix}`,
      `  ${labels.input} ${input} · ${labels.output} ${output}${suffix}`,
    ]
    lines.push({ text: truncate(`${clock} ${identity}`, budget), tone: turn.routerChanged ? "warning" : "base" })
    lines.push({
      text: truncate(candidates.find((text) => text.length <= budget) ?? candidates[candidates.length - 1]!, budget),
      tone: turn.drops.length > 0 ? "warning" : "muted",
    })
  }
  if (rows.length === 0) lines.push({ text: "no finished turns yet", tone: "muted" })
  return lines
}
