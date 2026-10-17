/** @jsxImportSource @opentui/solid */
import type { Database } from "bun:sqlite"
import type { RGBA } from "@opentui/core"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { For, createMemo } from "solid-js"
import {
  PANEL_VIEWS,
  RANGE_KEYS,
  cacheLines,
  latencyLines,
  modelsLines,
  overviewLines,
  rangeFor,
  rangeLabel,
  sessionsLines,
  turnsLines,
  type LineFormatOptions,
  type PanelLine,
  type PanelTone,
  type PanelView,
  type RangeKey,
} from "./panel-data"
import { cacheDrops, cacheTtlEvidence, latency, models, overview, sessions, turns } from "./stats/queries"

/**
 * The `/stats` panel: one read-only view over the stats database at a time.
 * Query results are mapped to plain lines by `panel-data`, so this component
 * stays a thin renderer and the layout can be tested without a terminal.
 */

export type PanelDeps = {
  /** Lazily opened stats database; undefined when it cannot be opened. */
  db: () => Database | undefined
  /** Injectable clock, for tests. */
  now: () => number
  /** Creation time of a session, used by the `session` range. */
  sessionStart: (sessionID: string) => number | undefined
  /** Bumped by the TUI when a step or an execution ends, so views re-read. */
  refresh?: (() => number) | undefined
}

export function Panel(props: {
  readonly input: PanelInput
  readonly ctx: Context
  readonly deps: PanelDeps
  readonly view: () => PanelView
  readonly range: () => RangeKey
}) {
  // The panel owns input while it is open, so these keys are live only then.
  // `escape` is the panel's own "hide it" key — without it the only way to get
  // rid of the panel was leaving the session — and `f` toggles the full-screen
  // presentation the host offers.
  props.ctx.keymap.layer(() => ({
    commands: [
      { id: "usage-insights.close", title: "Close usage panel", bind: "escape", run: () => props.input.close() },
      {
        id: "usage-insights.fullscreen",
        title: "Toggle usage panel fullscreen",
        bind: "f",
        run: () => props.input.toggleFullscreen(),
      },
    ],
  }))

  const color = (tone: PanelTone | undefined): RGBA => {
    switch (tone) {
      case "muted":
        return props.ctx.theme.text.muted
      case "warning":
        return props.ctx.theme.text.feedback.warning.base
      case "accent":
        return props.ctx.theme.text.feedback.info.base
      default:
        return props.ctx.theme.text.base
    }
  }

  const lines = createMemo<PanelLine[]>(() => {
    props.deps.refresh?.()
    const width = Math.max(60, props.input.width - 4)
    const range = rangeFor(props.range(), props.deps.now(), props.deps.sessionStart(props.input.sessionID))
    const db = props.deps.db()
    if (db === undefined) {
      return [{ text: "stats database is not readable; enable the usage-insights server plugin in opencode.json", tone: "warning" }]
    }
    try {
      switch (props.view()) {
        case "overview": {
          const sessionStart = props.deps.sessionStart(props.input.sessionID)
          return overviewLines(
            {
              usage: overview(db, range),
              session: sessionStart === undefined ? undefined : overview(db, { from: sessionStart }),
              range: props.range(),
            },
            width,
          )
        }
        case "models":
          return modelsLines(models(db, range), width)
        case "turns":
          return turnsLines(turns(db, { sessionID: props.input.sessionID, range, limit: 60 }), width, props.ctx.options as LineFormatOptions)
        case "cache":
          return cacheLines({ drops: cacheDrops(db, { range }), evidence: cacheTtlEvidence(db, range) }, width)
        case "latency":
          return latencyLines(latency(db, range), width)
        case "sessions":
          return sessionsLines(sessions(db, { range, limit: 20 }), width)
        default:
          return []
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [{ text: `stats query failed: ${message}`, tone: "warning" }]
    }
  })

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Everything lives inside the scrollbox: in the current OpenTUI build,
          text siblings placed before a scrollbox overlap its first rows. */}
      <scrollbox flexGrow={1} scrollY={true} verticalScrollbarOptions={{ visible: true }}>
        <text fg={props.ctx.theme.text.feedback.info.base}>usage insights</text>
        <text fg={props.ctx.theme.text.muted}>
          {`${props.view()} · ${rangeLabel(props.range())} · views: ${PANEL_VIEWS.join(" ")} · ranges: ${RANGE_KEYS.join(" ")}`}
        </text>
        <For each={lines()}>{(line) => <text fg={color(line.tone)}>{line.text}</text>}</For>
        <text fg={props.ctx.theme.text.muted}>{""}</text>
        <text fg={props.ctx.theme.text.muted}>{"/usage <view> <range> to switch · escape to close · f full screen"}</text>
      </scrollbox>
    </box>
  )
}
