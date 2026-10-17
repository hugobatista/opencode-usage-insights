/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { StyledText, fg, type ColorInput } from "@opentui/core"
import type { Database } from "bun:sqlite"
import { Show, createMemo, createRenderEffect, createSignal } from "solid-js"
import { computeTurn, type LineFields, type LineIdentity, type LineLabels, type TurnStats, type TurnTotalsView } from "./core"
import { lineParts, lineText, sessionTotals, toTranscript, type LinePart, type RuntimeMessage, type RuntimeSessionInfo } from "./line"
import { DEFAULT_SETTINGS, PANEL_NAME, parseArgs, sanitizeSettings, type PanelSettings, type PanelView, type RangeKey } from "./panel-data"
import { Panel } from "./panel"
import { TurnsSidebar } from "./sidebar"
import { openStatsDb } from "./stats/db"
import { resolveDbPath } from "./stats/paths"
import { latestUpstream, routerBefore } from "./stats/queries"
import type { UpstreamInfo } from "./upstream"

/**
 * TUI side of the plugin. Two contributions:
 *
 * - `session.composer.top`: one telemetry line after every turn with the end
 *   time, the delta since the previous prompt, the provider, the upstream
 *   operator when known, turn and session token totals, and cache warnings.
 * - `session.panel` + the `/stats` slash command: the statistics panel over
 *   the database written by the server entry.
 *
 * The database is opened lazily and read-only in spirit: the TUI never
 * writes usage. When the database cannot be opened, the line falls back to
 * host data only and the panel explains itself.
 */

export type Options = {
  /** Turn the TUI side off: no line and no panel. */
  enabled?: boolean | undefined
  /** SQLite database path override; must match the server entry. */
  db?: string | undefined
  /** Show the upstream operator on the line when a recorder learned it. */
  upstream?: boolean | undefined
  /**
   * Which identity the line leads with: `endpoint` (default) shows the gateway
   * endpoint that served the turn (`orcarouter-dsv4.1flash`) and warns when it
   * changes; `model` shows `provider/model#variant` as before.
   */
  identity?: LineIdentity | undefined
  /**
   * How the turn segment counts prompt usage: `latest` (default) shows the
   * prompt size the turn ended with, `sum` adds every step of the turn.
   */
  turnTotals?: TurnTotalsView | undefined
  /** Telemetry line field toggles. */
  fields?: Partial<LineFields> | undefined
  /** Telemetry line label overrides. */
  labels?: Partial<LineLabels> | undefined
  /** Show the per-prompt history in the session sidebar (default true). */
  sidebar?: boolean | undefined
  /** How many turns the sidebar history shows (default 5). */
  sidebarTurns?: number | undefined
  /**
   * Show the `/usage` statistics panel and its command (default true).
   * `false` keeps the live line and the sidebar history.
   */
  panel?: boolean | undefined
}

const UPSTREAM_CACHE_MS = 5_000

// Test hook. The plugin loader reads the default export only; named exports
// are ignored.
export const __test: {
  line: ((sessionID: string) => TurnStats | undefined) | undefined
  lineText: ((sessionID: string) => string) | undefined
  open: ((input?: string) => boolean) | undefined
  state: (() => { view: PanelView; range: RangeKey }) | undefined
} = {
  line: undefined,
  lineText: undefined,
  open: undefined,
  state: undefined,
}

export default Plugin.define({
  id: "usage-insights",
  setup(ctx: Context) {
    const options = (ctx.options ?? {}) as Options
    if (options.enabled === false) return
    const panelEnabled = options.panel !== false

    // Panel state lives in the host's durable store, so the view, range, sort,
    // bucket and filters survive a restart and the command palette and the
    // panel keys mutate the same object.
    const [settings, updateSettings] = ctx.storage.store<PanelSettings>("panel", { initial: DEFAULT_SETTINGS })
    const patchSettings = (mutation: (draft: PanelSettings) => void): void => {
      void updateSettings(mutation)
    }
    // Bumped when a step or an execution ends: the panel and the sidebar read
    // the database, which is not reactive by itself.
    const [refresh, setRefresh] = createSignal(0)
    const upstreamCache = new Map<string, { value: UpstreamInfo | undefined; at: number }>()
    let database: Database | undefined
    let databaseFailed = false

    function db(): Database | undefined {
      if (database !== undefined) return database
      if (databaseFailed) return undefined
      try {
        database = openStatsDb(resolveDbPath(options.db))
        return database
      } catch {
        databaseFailed = true
        return undefined
      }
    }

    function sessionStart(sessionID: string): number | undefined {
      return ctx.data.session.get(sessionID)?.time.created
    }

    function lookupUpstream(sessionID: string, modelID: string | undefined): UpstreamInfo | undefined {
      if (modelID === undefined || options.upstream === false) return undefined
      const key = `${sessionID}|${modelID}`
      const now = Date.now()
      const cached = upstreamCache.get(key)
      if (cached !== undefined && now - cached.at < UPSTREAM_CACHE_MS) return cached.value
      let value: UpstreamInfo | undefined
      const handle = db()
      if (handle !== undefined) {
        try {
          value = latestUpstream(handle, sessionID, modelID)
        } catch {
          value = undefined
        }
      }
      upstreamCache.set(key, { value, at: now })
      return value
    }

    /**
     * True while the session is running a turn. The host publishes that state
     * from its execution events, so the line only appears when the turn is
     * over — not between the steps of a tool-call loop. A host without the
     * flag degrades to "idle", which is the old behaviour.
     */
    function sessionIdle(sessionID: string): boolean {
      try {
        return ctx.data.session.status(sessionID) === "idle"
      } catch {
        return true
      }
    }

    function lineFor(sessionID: string): TurnStats | undefined {
      const messages = ctx.data.session.message.list(sessionID) as unknown as RuntimeMessage[]
      const info = ctx.data.session.get(sessionID) as unknown as RuntimeSessionInfo | undefined
      // A running turn has no final numbers yet: the line belongs to finished
      // work, so it stays hidden until the session goes idle again.
      if (!sessionIdle(sessionID)) return undefined
      const stats = computeTurn(toTranscript(messages), sessionTotals(info))
      if (stats !== undefined) {
        const upstream = lookupUpstream(sessionID, stats.modelID)
        if (upstream?.operator !== undefined) stats.upstream = upstream.operator
        if (upstream?.router !== undefined) {
          stats.router = upstream.router
          // The transcript carries no routing history, so the previous endpoint
          // comes from the database: the line warns when the turn was served by
          // a different endpoint than the turn before it.
          const handle = db()
          if (handle !== undefined) {
            try {
              const previous = routerBefore(handle, sessionID, stats.startAt)
              stats.identityChanged = previous !== undefined && previous !== stats.router
            } catch {
              stats.identityChanged = false
            }
          }
        }
      }
      return stats
    }

    function toneColor(tone: LinePart["tone"]): ColorInput {
      if (tone === "warning") return ctx.theme.text.feedback.warning.base
      if (tone === "muted") return ctx.theme.text.muted
      return ctx.theme.text.base
    }

    /** Structural view of the text renderable: no host-only class is imported. */
    type LineNode = { content: StyledText | string }

    function Line(props: { readonly sessionID: string }) {
      const parts = createMemo(() =>
        lineParts(lineFor(props.sessionID), {
          labels: options.labels,
          fields: options.fields,
          turnTotals: options.turnTotals,
          identity: options.identity,
        }),
      )
      return (
        <Show when={parts().length > 0}>
          {() => {
            // The line is one text renderable whose content is *replaced* on every
            // update. In the current OpenTUI build the `content` prop stringifies a
            // StyledText, and a StyledText child is appended as chunks that are
            // never removed — the line grew one extra copy per reactive update.
            // Assigning the property replaces; a render effect runs before paint.
            let node: LineNode | undefined
            const element = <text ref={(target: unknown) => { node = target as LineNode }} />
            createRenderEffect(() => {
              const rendered = node
              if (rendered === undefined) return
              const current = parts()
              rendered.content = current.length === 0 ? "" : new StyledText(current.map((part) => fg(toneColor(part.tone))(part.text)))
            })
            return element
          }}
        </Show>
      )
    }

    const disposeLine = ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => <Line sessionID={input.sessionID} />,
    })

    const disposePanel = panelEnabled
      ? ctx.ui.slot({
          append: "session.panel",
          render: (input) =>
            input.name === PANEL_NAME ? (
              <Panel
                input={input}
                ctx={ctx}
                deps={{ db, now: () => Date.now(), sessionStart, refresh }}
                settings={settings}
                update={patchSettings}
                format={{ labels: options.labels, fields: options.fields, turnTotals: options.turnTotals, identity: options.identity }}
              />
            ) : null,
        })
      : () => {}

    const disposeSidebar = ctx.ui.slot({
      append: "sidebar.content",
      render: (input) =>
        options.sidebar === false ? null : (
          <TurnsSidebar
            sessionID={input.sessionID}
            ctx={ctx}
            deps={{ db, refresh, limit: Math.max(1, Math.round(options.sidebarTurns ?? 5)) }}
            options={{ labels: options.labels, fields: options.fields, turnTotals: options.turnTotals, identity: options.identity }}
          />
        ),
    })

    /**
     * `/usage` toggles the panel. With no argument tokens it closes a panel it
     * opened, so the same command both shows and hides it and the user never
     * has to leave the session to get rid of it. Any argument — even an
     * unknown token, which `parseArgs` ignores — keeps the panel open.
     *
     * A slash command declared with `arguments: true` receives its raw input,
     * which still carries the `/usage` (or `/insights`) token itself, so the
     * command tokens are dropped before deciding.
     */
    function open(input?: string): boolean {
      const parsed = parseArgs(input)
      if (parsed.view !== undefined || parsed.range !== undefined) {
        patchSettings((draft) => {
          if (parsed.view !== undefined) draft.view = parsed.view
          if (parsed.range !== undefined) draft.range = parsed.range
        })
      }
      const tokens = (input ?? "")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token !== "" && !token.startsWith("/"))
      if (tokens.length === 0 && ctx.ui.panel.current()?.name === PANEL_NAME) {
        ctx.ui.panel.close()
        return true
      }
      return ctx.ui.panel.open(PANEL_NAME)
    }

    if (panelEnabled) {
      ctx.keymap.layer(() => {
        // The explicit block body avoids a TypeScript TSX parser quirk: a
        // parenthesized object literal as an arrow body can be misread as arrow
        // parameters when a later `) =>` exists in the same file.
        //
        // `mode: "global"` is required: without it the layer is pinned to the
        // default `base` input mode, and the host only exposes a layer's palette
        // and slash commands while that mode is active — so `/usage` was
        // invisible in the prompt completion and the command palette.
        return {
          mode: "global",
          commands: [
            {
              id: "usage-insights.stats",
              title: "Usage insights",
              description: "Open the usage statistics panel",
              group: "Usage insights",
              bind: false,
              palette: true,
              slash: { name: "usage", aliases: ["insights"], arguments: true },
              run: (input?: string) => {
                if (!open(input)) {
                  ctx.ui.toast.show({ message: "Open a session first, then run /usage", variant: "warning" })
                }
              },
            },
          ],
        }
      })
    }

    const disposeEvents = [
      // A finished step may carry a fresh upstream operator; drop the cache and
      // let the history views re-read the database.
      ctx.data.on("session.step.ended", () => {
        upstreamCache.clear()
        setRefresh((value) => value + 1)
      }),
      ctx.data.on("session.execution.succeeded", () => setRefresh((value) => value + 1)),
      ctx.data.on("session.execution.failed", () => setRefresh((value) => value + 1)),
      ctx.data.on("session.execution.interrupted", () => setRefresh((value) => value + 1)),
      ctx.data.on("session.compaction.ended", () => setRefresh((value) => value + 1)),
    ]

    __test.line = lineFor
    __test.lineText = (sessionID: string) =>
      lineText(lineParts(lineFor(sessionID), { labels: options.labels, fields: options.fields }))
    __test.open = open
    __test.state = () => {
      const current = sanitizeSettings(settings)
      return { view: current.view, range: current.range }
    }

    return () => {
      for (const dispose of disposeEvents) dispose()
      disposeLine()
      disposePanel()
      disposeSidebar()
      database?.close()
    }
  },
})
