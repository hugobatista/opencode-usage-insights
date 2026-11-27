/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { PanelLine, PanelTone } from "./panel-data"
import { usageApi } from "./rpc-client"
import type { TurnsOutput } from "./rpc"

/**
 * Sidebar history: the session's accumulated usage, then the last finished
 * turns — when and through which provider, the model when it changed, and the
 * prompt volumes. The lines are formatted by the server's RPC from the same
 * database the panel uses; the sidebar only renders them.
 */

export type TurnsSidebarDeps = {
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

  const [data, setData] = createSignal<TurnsOutput | undefined>(undefined)
  const [error, setError] = createSignal<unknown>(undefined)
  const [loading, setLoading] = createSignal(false)
  let generation = 0

  createEffect(() => {
    props.deps.refresh()
    const input = {
      sessionID: props.sessionID,
      limit: props.deps.limit,
      width: props.deps.budget ?? 34,
    }
    const current = ++generation
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    setLoading(true)
    void usageApi(props.ctx.client, props.ctx.location)
      .turns(input, controller.signal)
      .then((result) => {
        if (current !== generation) return
        setData(result)
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (current !== generation) return
        setError(cause)
      })
      .finally(() => {
        if (current === generation) setLoading(false)
      })
  })

  const lines = createMemo<PanelLine[]>(() => {
    const result = data()
    if (result === undefined) {
      if (error() !== undefined) return [{ text: "usage history unavailable", tone: "muted" }]
      return []
    }
    return [...result.summary, { text: "turns", tone: "accent" as PanelTone }, ...result.history]
  })

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <For each={lines()}>{(line) => <text fg={color(line.tone)}>{line.text}</text>}</For>
      <Show when={loading() && data() !== undefined}>
        <text fg={props.ctx.theme.text.muted}>…</text>
      </Show>
    </box>
  )
}
