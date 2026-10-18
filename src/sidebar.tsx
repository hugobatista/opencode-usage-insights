/** @jsxImportSource @opentui/solid */
import type { Database } from "bun:sqlite"
import type { RGBA } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { For, createMemo } from "solid-js"
import { sidebarLines, sessionSummaryLines, type LineFormatOptions, type PanelLine, type PanelTone } from "./panel-data"
import { overview, turns } from "./stats/queries"

/**
 * Sidebar history: the session's accumulated usage, then the last finished
 * turns — when and through which provider, the model when it changed, and the
 * prompt volumes. Reads the same database, the same buckets and the same
 * formatter as the panel and the live line, and refreshes whenever a turn ends.
 */

export type TurnsSidebarDeps = {
  db: () => Database | undefined
  /** Bumped by the TUI when a step or an execution ends. */
  refresh: () => number
  /** How many turns to show. */
  limit: number
  /** Column budget of the sidebar, shared with the summary. */
  budget?: number | undefined
}

export function TurnsSidebar(props: {
  readonly sessionID: string
  readonly ctx: Context
  readonly deps: TurnsSidebarDeps
  readonly options?: LineFormatOptions | undefined
}) {
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
    props.deps.refresh()
    const db = props.deps.db()
    if (db === undefined) return []
    const budget = props.deps.budget ?? 34
    try {
      // The session's own steps, never the window after it started: siblings
      // and subagents are their own sessions.
      const summary = sessionSummaryLines(overview(db, undefined, { sessionID: props.sessionID }), budget)
      const history = sidebarLines(turns(db, { sessionID: props.sessionID, limit: props.deps.limit }), { ...props.options, budget })
      return [...summary, { text: "turns", tone: "accent" as PanelTone }, ...history]
    } catch {
      return []
    }
  })

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <For each={lines()}>{(line) => <text fg={color(line.tone)}>{line.text}</text>}</For>
    </box>
  )
}
