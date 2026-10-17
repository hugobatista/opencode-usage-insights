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
import type { CacheDropRow, LatencyReport, ModelUsage, Overview, Range, SessionUsage, TurnUsage, TtlEvidenceRow } from "./stats/queries"

/**
 * View models and formatting for the stats panel. Everything here is pure:
 * the panel component only feeds query results in and renders the lines out,
 * which keeps the layout testable without a terminal.
 */

export const PANEL_NAME = "usage-insights"

export const PANEL_VIEWS = ["overview", "models", "turns", "cache", "latency", "sessions"] as const
export type PanelView = (typeof PANEL_VIEWS)[number]

export const RANGE_KEYS = ["session", "today", "7d", "30d", "all"] as const
export type RangeKey = (typeof RANGE_KEYS)[number]

export type PanelTone = "base" | "muted" | "warning" | "accent"

export type PanelLine = {
  text: string
  tone?: PanelTone
}

/** Parse `/usage <view> <range>` arguments; unknown tokens are ignored. */
export function parseArgs(input: string | undefined): { view?: PanelView; range?: RangeKey } {
  const parsed: { view?: PanelView; range?: RangeKey } = {}
  for (const token of (input ?? "").split(/\s+/)) {
    const value = token.trim().toLowerCase()
    if (value === "") continue
    if ((PANEL_VIEWS as readonly string[]).includes(value)) parsed.view = value as PanelView
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

export function formatPercent(value: number | undefined): string {
  return value === undefined ? "–" : `${(value * 100).toFixed(1)}%`
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

export function truncate(value: string, width: number): string {
  if (width <= 1) return ""
  if (value.length <= width) return value
  return `${value.slice(0, width - 1).trimEnd()}…`
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

/** `1 step` / `2 steps` — the panel is user-facing prose, not a raw table. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`
}

export function overviewLines(data: { usage: Overview; session: Overview | undefined; range: RangeKey }, width: number): PanelLine[] {
  const lines: PanelLine[] = []
  lines.push({
    text: `${rangeLabel(data.range)} · ${count(data.usage.steps, "step")} · ${count(data.usage.sessions, "session")} · ${count(data.usage.prompts, "prompt")}`,
    tone: "muted",
  })
  lines.push(...kvGrid(buildOverviewPairs(data.usage, "all"), width))
  if (data.session !== undefined) {
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: "this session", tone: HEADER_TONE })
    lines.push(...kvGrid(buildOverviewPairs(data.session, "session"), width))
  }
  return lines
}

function buildOverviewPairs(usage: Overview, scope: "all" | "session"): (readonly [string, string])[] {
  const pairs: (readonly [string, string])[] = [
    ["steps", formatCount(usage.steps)],
    ["input", formatTokens(usage.input)],
    ["cached", `${formatTokens(usage.cached)} (${formatPercent(usage.cacheHitRatio)} hit)`],
    ["output", formatTokens(usage.output)],
  ]
  if (usage.reasoning > 0) pairs.push(["reasoning", formatTokens(usage.reasoning)])
  pairs.push(["cost", formatCost(usage.cost)])
  if (scope === "all") {
    pairs.push(["first", usage.firstAt === undefined ? "–" : new Date(usage.firstAt).toLocaleString("en-GB")])
    pairs.push(["last", usage.lastAt === undefined ? "–" : new Date(usage.lastAt).toLocaleString("en-GB")])
  }
  return pairs
}

type ModelColumns = {
  model: number
  provider: number
  steps: number
  input: number
  cached: number
  output: number
  cost: number
}

function modelColumns(width: number): ModelColumns {
  if (width >= 100) return { model: 30, provider: 22, steps: 6, input: 9, cached: 9, output: 9, cost: 9 }
  if (width >= 80) return { model: 24, provider: 20, steps: 6, input: 8, cached: 8, output: 8, cost: 8 }
  return { model: 18, provider: 16, steps: 5, input: 7, cached: 7, output: 7, cost: 0 }
}

/** Usage per model with the providers (and upstream operators) behind it. */
export function modelsLines(rows: readonly ModelUsage[], width: number, limit = 12): PanelLine[] {
  const columns = modelColumns(width)
  const widths: number[] = [columns.model, columns.provider, columns.steps, columns.input, columns.cached, columns.output]
  const aligns: ("left" | "right")[] = ["left", "left", "right", "right", "right", "right"]
  const header: string[] = ["model", "provider", "steps", "in", "cached", "out"]
  if (columns.cost > 0) {
    widths.push(columns.cost)
    aligns.push("right")
    header.push("cost")
  }
  const lines: PanelLine[] = [{ text: formatTableRow(header, widths, aligns), tone: HEADER_TONE }]

  for (const model of rows.slice(0, limit)) {
    const name = model.variant !== undefined ? `${model.modelID} ${model.variant}` : model.modelID
    for (const provider of model.providers) {
      const via = provider.upstreams.length > 0 ? `via ${provider.upstreams.join(", ")}` : ""
      const cell = via === "" ? provider.providerID : `${provider.providerID} ${via}`
      const fits = cell.length <= columns.provider
      const cells: string[] = [
        name,
        fits ? cell : provider.providerID,
        formatCount(provider.steps),
        formatTokens(provider.input),
        formatTokens(provider.cached),
        formatTokens(provider.output),
      ]
      if (columns.cost > 0) cells.push(formatCost(provider.cost))
      lines.push({ text: formatTableRow(cells, widths, aligns), tone: "base" })
      // Details are the whole point of this view: the operator list, the
      // upstream model the gateway reported and the routing endpoint continue
      // on indented lines instead of being truncated away.
      const details = [via]
      if (provider.upstreamModels.length > 0) details.push(`upstream ${provider.upstreamModels.join(", ")}`)
      if (provider.routers.length > 0) details.push(`endpoint ${provider.routers.join(", ")}`)
      const detail = details.filter((entry) => entry !== "").join(" · ")
      if (detail !== "" && (!fits || provider.upstreamModels.length > 0 || provider.routers.length > 0)) {
        lines.push({ text: truncate(`${" ".repeat(columns.model + 1)}${detail}`, width), tone: "muted" })
      }
    }
  }
  if (rows.length > limit) lines.push({ text: `… ${count(rows.length - limit, "more model")}`, tone: "muted" })
  if (rows.length === 0) lines.push({ text: "no usage recorded for this range", tone: "muted" })
  return lines
}

export function cacheLines(data: { drops: readonly CacheDropRow[]; evidence: readonly TtlEvidenceRow[] }, width: number): PanelLine[] {
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

export function latencyLines(report: LatencyReport, width: number): PanelLine[] {
  const lines: PanelLine[] = []
  lines.push({
    text: formatTableRow(
      ["wall", "p50", formatMs(report.wall.p50), "p90", formatMs(report.wall.p90), "p99", formatMs(report.wall.p99), `n ${formatCount(report.wall.count)}`],
      [10, 4, 9, 4, 9, 4, 9, 12],
    ),
    tone: "base",
  })
  lines.push({
    text: formatTableRow(
      ["stream", "p50", formatMs(report.stream.p50), "p90", formatMs(report.stream.p90), "p99", formatMs(report.stream.p99)],
      [10, 4, 9, 4, 9, 4, 9],
    ),
    tone: "base",
  })
  lines.push({
    text: formatTableRow(
      ["throughput", "p50", formatTps(report.tps.p50), "p90", formatTps(report.tps.p90), "p99", formatTps(report.tps.p99)],
      [10, 4, 9, 4, 9, 4, 9],
    ),
    tone: "base",
  })
  lines.push({ text: "", tone: "muted" })
  lines.push({
    text: truncate("wall = request to completed · stream = request to last chunk · throughput = output+reasoning tokens/s", width),
    tone: "muted",
  })
  if (report.wall.count === 0) lines.push({ text: "no completed steps for this range", tone: "muted" })
  return lines
}

export function sessionsLines(rows: readonly SessionUsage[], width: number, limit = 14): PanelLine[] {
  const widths = [Math.max(18, Math.floor(width * 0.4)), 7, 8, 8, 9]
  const aligns: ("left" | "right")[] = ["left", "right", "right", "right", "right"]
  const lines: PanelLine[] = [
    { text: formatTableRow(["title", "steps", "in", "cached", "cost"], widths, aligns), tone: HEADER_TONE },
  ]
  for (const row of rows.slice(0, limit)) {
    // The provider list must stay readable, so the title gives up the space.
    const suffix = row.providers.length > 0 ? ` [${row.providers.join(",")}]` : ""
    const title = truncate(row.title ?? row.sessionID, Math.max(8, widths[0]! - suffix.length))
    lines.push({
      text: formatTableRow(
        [`${title}${suffix}`, formatCount(row.steps), formatTokens(row.input), formatTokens(row.cached), formatCost(row.cost)],
        widths,
        aligns,
      ),
      tone: "base",
    })
  }
  if (rows.length === 0) lines.push({ text: "no sessions recorded for this range", tone: "muted" })
  return lines
}

/** Line formatting shared by the live line and the history views. */
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
    upstream: turn.upstream,
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
export function turnsLines(rows: readonly TurnUsage[], width: number, options?: LineFormatOptions): PanelLine[] {
  const lines: PanelLine[] = [{ text: `${count(rows.length, "turn")} · newest first`, tone: "muted" }]
  for (const turn of rows) {
    const line = formatLine(turnStats(turn), {
      ...options,
      fields: { ...options?.fields, session: false },
    })
    lines.push({ text: truncate(line, width), tone: turn.drops.length > 0 ? "warning" : "base" })
  }
  if (rows.length === 0) lines.push({ text: "no finished turns for this range", tone: "muted" })
  return lines
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
    const numbers = `${labels.input} ${formatTokens(display.input)} (${formatTokens(display.prompt)}) · ${labels.output} ${formatTokens(display.output)}`
    lines.push({ text: truncate(`${clock} ${identity}`, budget), tone: turn.routerChanged ? "warning" : "base" })
    lines.push({
      text: truncate(`  ${numbers}${turn.drops.length > 0 ? " · ⚠" : ""}`, budget),
      tone: turn.drops.length > 0 ? "warning" : "muted",
    })
  }
  if (rows.length === 0) lines.push({ text: "no finished turns yet", tone: "muted" })
  return lines
}
