/** @jsxImportSource @opentui/solid */
import type { Database } from "bun:sqlite"
import type { RGBA } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { For, createMemo } from "solid-js"
import { sidebarLines, type LineFormatOptions, type PanelTone } from "./panel-data"
import { turns } from "./stats/queries"

/**
 * Sidebar history: the last finished turns of the session, two compact lines
 * each (when + endpoint, then the prompt volumes). Reads the same database and
 * the same formatting as the panel, and refreshes whenever a turn ends.
 */

export type TurnsSidebarDeps = {
  db: () => Database | undefined
  /** Bumped by the TUI when a step or an execution ends. */
  refresh: () => number
  /** How many turns to show. */
  limit: number
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

  const lines = createMemo(() => {
    props.deps.refresh()
    const db = props.deps.db()
    if (db === undefined) return []
    try {
      return sidebarLines(turns(db, { sessionID: props.sessionID, limit: props.deps.limit }), props.options)
    } catch {
      return []
    }
  })

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={props.ctx.theme.text.feedback.info.base}>turns</text>
      <For each={lines()}>{(line) => <text fg={color(line.tone)}>{line.text}</text>}</For>
    </box>
  )
}
