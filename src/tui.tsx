/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { StyledText, fg, type ColorInput } from "@opentui/core"
import type { Database } from "bun:sqlite"
import { Show, createMemo, createRenderEffect, createSignal } from "solid-js"
import { computeTurn, type LineFields, type LineLabels, type TurnStats, type TurnTotalsView } from "./core"
import { lineParts, lineText, sessionTotals, toTranscriptTail, type LinePart, type RuntimeMessage, type RuntimeSessionInfo } from "./line"
import { DEFAULT_SETTINGS, PANEL_NAME, parseArgs, sanitizeSettings, type PanelSettings, type PanelView, type RangeKey } from "./panel-data"
import { Panel } from "./panel"
import { costOf, priceTable, type PriceFn, type PriceTable } from "./pricing"
import { TurnsSidebar } from "./sidebar"
import { openStatsDbReadOnly, openStatsDbWrite } from "./stats/db"
import { backfillListCost, type BackfillResult } from "./stats/maintenance"
import { resolveDbPath } from "./stats/paths"
import { sessionListCost } from "./stats/queries"

/**
 * TUI side of the plugin. Two contributions:
 *
 * - `session.composer.top`: one telemetry line after every turn with the end
 *   time, the delta since the previous prompt, the provider and model that ran
 *   it, turn and session token totals, and cache warnings.
 * - `session.panel` + the `/stats` slash command: the statistics panel over
 *   the database written by the server entry.
 *
 * The line is computed from the host's transcript alone; the database is opened
 * lazily for the panel and the sidebar, read-only in spirit: the TUI never
 * writes usage. When the database cannot be opened, the line still works and
 * the panel explains itself.
 */

export type Options = {
  /** Turn the TUI side off: no line and no panel. */
  enabled?: boolean | undefined
  /** SQLite database path override; must match the server entry. */
  db?: string | undefined
  /**
   * List-price estimates for steps the host reports as costing nothing.
   * `off` hides them on the line, in the panel and in the sidebar, and
   * disables the historical backfill. Defaults to `auto`.
   */
  pricing?: "auto" | "off" | undefined
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

/**
 * Shortest interval between two panel rebuilds. A tool-call loop ends several
 * steps in a row, and each one used to rebuild every open view; the views read
 * the database, so the burst is coalesced into one rebuild.
 */
const REFRESH_THROTTLE_MS = 300

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
    const pricing = options.pricing !== "off"
    const PRICE_TTL_MS = 5 * 60 * 1000
    let priceCache: { table: PriceTable; at: number } | undefined

    /**
     * The catalog prices the live line prices steps with. The host publishes
     * the model list as a location collection, so a stale table is still
     * usable when the collection is temporarily unavailable.
     */
    function priceTableFor(): PriceTable | undefined {
      if (!pricing) return undefined
      const now = Date.now()
      if (priceCache !== undefined && now - priceCache.at < PRICE_TTL_MS) return priceCache.table
      try {
        const models = ctx.data.location?.model?.list(ctx.location)
        if (models !== undefined && models.length > 0) {
          priceCache = { table: priceTable(models), at: now }
          return priceCache.table
        }
      } catch {
        // Fall through to the previous table.
      }
      return priceCache?.table
    }

    function priceFor(): PriceFn | undefined {
      const table = priceTableFor()
      return table === undefined ? undefined : (ref, tokens) => costOf(table, ref, tokens)
    }

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
    let database: Database | undefined
    let databaseFailed = false
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let lastRefresh = 0
    /** Per-session list estimate for the `sess` segment; cleared on every write event. */
    const sessionCostCache = new Map<string, number>()

    /**
     * Ask the panel and the sidebar to re-read the database, at most once per
     * throttle window. The first event after an idle stretch is instant; the
     * rest of a burst is folded into one trailing rebuild.
     */
    function bumpRefresh(): void {
      sessionCostCache.clear()
      const now = Date.now()
      const wait = lastRefresh + REFRESH_THROTTLE_MS - now
      if (wait <= 0) {
        lastRefresh = now
        setRefresh((value) => value + 1)
        return
      }
      if (refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        lastRefresh = Date.now()
        setRefresh((value) => value + 1)
      }, wait)
      // A repaint is not a reason to keep the process alive.
      ;(refreshTimer as { unref?: (() => void) | undefined }).unref?.()
    }

    /**
     * Reader connection. Read-only on purpose: the TUI only ever reads, and a
     * reader that cannot write never takes the recorder's lock, never runs a
     * schema statement and cannot corrupt what it shows.
     */
    function db(): Database | undefined {
      if (database !== undefined) return database
      if (databaseFailed) return undefined
      try {
        database = openStatsDbReadOnly(resolveDbPath(options.db))
        return database
      } catch {
        databaseFailed = true
        return undefined
      }
    }

    /**
     * The session's recorded list estimate, for the `sess` segment. One indexed
     * sum per session between write events, cached so a long transcript does
     * not pay for it on every recompute. A missing database or an older schema
     * degrades to the host's charged total alone.
     */
    function sessionListCostFor(sessionID: string): number {
      if (!pricing) return 0
      const cached = sessionCostCache.get(sessionID)
      if (cached !== undefined) return cached
      const handle = db()
      if (handle === undefined) return 0
      try {
        const value = sessionListCost(handle, sessionID)
        if (sessionCostCache.size >= 512) {
          const oldest = sessionCostCache.keys().next()
          if (oldest.done !== true) sessionCostCache.delete(oldest.value)
        }
        sessionCostCache.set(sessionID, value)
        return value
      } catch {
        return 0
      }
    }

    /**
     * Write connection for maintenance only (prune, compact), opened for the
     * duration of the operation with a short busy timeout: a reader waits, but
     * a maintenance action that cannot take the lock is an error the user can
     * see and retry.
     */
    function withWrite<Value>(run: (handle: Database) => Value): Value | undefined {
      let handle: Database | undefined
      try {
        handle = openStatsDbWrite(resolveDbPath(options.db))
        return run(handle)
      } catch {
        return undefined
      } finally {
        handle?.close()
      }
    }

    /**
     * Price every historical step the host recorded at $0 and that has no
     * estimate yet. Explicit, because the catalog used is today's: a model
     * that was free at the time is priced as it is now.
     */
    function backfill(): BackfillResult | undefined {
      if (!pricing) return undefined
      const table = priceTableFor()
      if (table === undefined) return undefined
      return withWrite((handle) => backfillListCost(handle, (ref, tokens) => costOf(table, ref, tokens)))
    }

    function sessionStart(sessionID: string): number | undefined {
      return ctx.data.session.get(sessionID)?.time.created
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
      // A running turn has no final numbers yet: the line belongs to finished
      // work, so it stays hidden until the session goes idle again. The check
      // comes first on purpose: the host publishes the message list as a store,
      // so this function is recomputed on every streamed delta, and reading the
      // list there would be per-delta work for a line that is not shown.
      if (!sessionIdle(sessionID)) return undefined
      // Track the shared write signal: a backfill or prune changes the session
      // estimate without changing the transcript, and the line must recompute.
      if (pricing) refresh()
      const messages = ctx.data.session.message.list(sessionID) as unknown as RuntimeMessage[]
      const info = ctx.data.session.get(sessionID) as unknown as RuntimeSessionInfo | undefined
      // The host supplies the charged session total; the plugin database supplies
      // the list estimate for the steps the host reported as $0.
      const session = info === undefined ? undefined : sessionTotals(info, sessionListCostFor(sessionID))
      return computeTurn(toTranscriptTail(messages, 2, priceFor()), session)
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
          estimates: pricing,
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
                deps={{ db, dbPath: () => resolveDbPath(options.db), withWrite, backfill, now: () => Date.now(), sessionStart, refresh, bump: bumpRefresh }}
                settings={settings}
                update={patchSettings}
                format={{ labels: options.labels, fields: options.fields, turnTotals: options.turnTotals, estimates: pricing }}
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
            options={{ labels: options.labels, fields: options.fields, turnTotals: options.turnTotals, estimates: pricing }}
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
      // A finished step means the history views have one more row: let them
      // re-read the database.
      ctx.data.on("session.step.ended", () => bumpRefresh()),
      ctx.data.on("session.execution.succeeded", () => bumpRefresh()),
      ctx.data.on("session.execution.failed", () => bumpRefresh()),
      ctx.data.on("session.execution.interrupted", () => bumpRefresh()),
      ctx.data.on("session.compaction.ended", () => bumpRefresh()),
      // A price change invalidates the live line's table; the next line reads
      // the catalog again (and the TTL keeps it fresh even without this event).
      ctx.data.on("model.updated", () => {
        priceCache = undefined
      }),
    ]

    __test.line = lineFor
    __test.lineText = (sessionID: string) =>
      lineText(lineParts(lineFor(sessionID), { labels: options.labels, fields: options.fields, estimates: pricing }))
    __test.open = open
    __test.state = () => {
      const current = sanitizeSettings(settings)
      return { view: current.view, range: current.range }
    }

    return () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      for (const dispose of disposeEvents) dispose()
      disposeLine()
      disposePanel()
      disposeSidebar()
      database?.close()
    }
  },
})
