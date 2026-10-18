/** @jsxImportSource @opentui/solid */
import type { Database } from "bun:sqlite"
import type { RGBA } from "@opentui/core"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { For, createMemo, createRenderEffect, createSignal } from "solid-js"
import { buildPanel, defaultSort, nextSort, type PanelRequest } from "./panel-build"
import {
  GRANULARITIES,
  PANEL_VIEWS,
  RANGE_KEYS,
  filterSummary,
  formatCount,
  helpLines,
  keysFor,
  nextIn,
  rangeLabel,
  sanitizeSettings,
  viewBar,
  type LineFormatOptions,
  type PanelLine,
  type PanelRow,
  type PanelSettings,
  type PanelTone,
  type PanelView,
} from "./panel-data"
import { filterOptions, type Filters } from "./stats/queries"
import { dbInfo, pruneOlderThan, vacuum, type DbInfo } from "./stats/maintenance"

/**
 * The `/usage` panel. One read-only view over the stats database at a time,
 * driven entirely from the keyboard: a cursor over the selectable lines,
 * Enter drills into the row under it, and the views, range, sort, bucket and
 * filters are part of the state the host persists between openings.
 *
 * The panel owns input while it is open, so every key lives in the layer this
 * component registers — the prompt is not involved.
 */

export type PanelDeps = {
  /** Lazily opened stats database; undefined when it cannot be opened. */
  db: () => Database | undefined
  /** Where that database lives, for the `db` view. */
  dbPath: () => string
  /**
   * Short-lived write connection for maintenance (prune, compact). The panel
   * itself only reads; opening a writer on demand is what keeps a read from
   * ever taking the recorder's lock. Undefined when the write cannot be made.
   */
  withWrite?: (<Value>(run: (db: Database) => Value) => Value | undefined) | undefined
  /** Injectable clock, for tests. */
  now: () => number
  /** Creation time of a session, used by the `session` range. */
  sessionStart: (sessionID: string) => number | undefined
  /** Bumped by the TUI when a step or an execution ends, so views re-read. */
  refresh?: (() => number) | undefined
}

type Scroller = { scrollChildIntoView?: ((id: string) => void) | undefined }

export function Panel(props: {
  readonly input: PanelInput
  readonly ctx: Context
  readonly deps: PanelDeps
  readonly settings: PanelSettings
  readonly update: (mutation: (draft: PanelSettings) => void) => void
  readonly format?: LineFormatOptions | undefined
}) {
  const [anchor, setAnchor] = createSignal<string | undefined>(undefined)
  const [detail, setDetail] = createSignal<PanelRow | undefined>(undefined)
  const [help, setHelp] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  // Set when a vacuum could not take the write lock: the recorder is mid-write.
  const [busy, setBusy] = createSignal(false)
  let scroller: Scroller | undefined

  const width = (): number => Math.max(60, props.input.width - 4)
  const view = (): PanelView => sanitizeSettings(props.settings).view
  const settings = (): PanelSettings => sanitizeSettings(props.settings)

  const filters = (): Filters => {
    const current = settings()
    return {
      ...(current.modelID !== "" ? { modelID: current.modelID } : {}),
      ...(current.routerID !== "" ? { router: current.routerID } : {}),
    }
  }

  const rowKey = (row: PanelRow): string => `${row.kind}:${row.value}${row.variant !== undefined ? `#${row.variant}` : ""}`

  /**
   * What the file holds. Reading it stats the file and counts rows in every
   * table, so only the `db` view (and the prune confirmation) asks for it: the
   * other views must not pay for it on every rebuild.
   */
  const database = createMemo<DbInfo | undefined>(() => {
    tick()
    const handle = props.deps.db()
    if (handle === undefined) return undefined
    try {
      return dbInfo(handle, props.deps.dbPath(), props.deps.now())
    } catch {
      return undefined
    }
  })

  const content = createMemo<PanelLine[]>(() => {
    tick()
    props.deps.refresh?.()
    const current = settings()
    if (help()) return helpLines(width())
    const db = props.deps.db()
    if (db === undefined) {
      return [{ text: `stats database is not readable at ${props.deps.dbPath()}; enable the usage-insights server plugin in opencode.json`, tone: "warning" }]
    }
    const info = current.view === "db" ? database() : undefined
    const request: PanelRequest = {
      db,
      view: current.view,
      range: current.range,
      filters: filters(),
      granularity: current.granularity,
      turnsScope: current.turnsScope,
      sort: current.sort,
      sortDesc: current.sortDesc,
      sessionID: props.input.sessionID,
      sessionStart: props.deps.sessionStart(props.input.sessionID),
      now: props.deps.now(),
      format: props.format,
      ...(detail() !== undefined ? { detail: detail() } : {}),
      ...(info !== undefined ? { database: info } : {}),
      busy: busy(),
      width: width(),
    }
    return buildPanel(request)
  })

  const header = createMemo<PanelLine[]>(() => {
    const current = settings()
    const filters = filterSummary(current)
    const where = detail() !== undefined ? " · backspace returns" : filters === undefined ? "" : ` · ${filters}`
    return [
      { text: `usage insights · ${rangeLabel(current.range)}${where}`, tone: "accent" },
      viewBar(current.view, width()),
      { text: "", tone: "muted" },
    ]
  })

  const selectable = createMemo(() => {
    const list: Array<{ key: string; index: number; row: PanelRow }> = []
    const lines = content()
    for (let index = 0; index < lines.length; index += 1) {
      const row = lines[index]!.row
      if (row !== undefined) list.push({ key: rowKey(row), index, row })
    }
    return list
  })

  const cursor = createMemo(() => {
    const list = selectable()
    if (list.length === 0) return -1
    const key = anchor()
    const found = key === undefined ? -1 : list.findIndex((entry) => entry.key === key)
    return found === -1 ? 0 : found
  })

  createRenderEffect(() => {
    const list = selectable()
    const index = cursor()
    if (index < 0) return
    const entry = list[index]
    if (entry === undefined) return
    scroller?.scrollChildIntoView?.(`line-${entry.index}`)
  })

  function move(delta: number): void {
    const list = selectable()
    if (list.length === 0) return
    const next = Math.min(list.length - 1, Math.max(0, cursor() + delta))
    setAnchor(list[next]!.key)
  }

  function moveEdge(toEnd: boolean): void {
    const list = selectable()
    if (list.length === 0) return
    setAnchor(list[toEnd ? list.length - 1 : 0]!.key)
  }

  function drill(): void {
    const entry = selectable()[cursor()]
    if (entry === undefined) return
    if (entry.row.kind === "prune") {
      void prune(Number.parseInt(entry.row.value, 10))
      return
    }
    setDetail(entry.row)
    setAnchor(undefined)
  }

  /** Delete the recorded usage older than `days`, after asking. */
  async function prune(days: number): Promise<void> {
    if (!Number.isFinite(days)) return
    const info = database()
    const steps = info?.removable.find((option) => option.days === days)?.steps
    const confirmed = await props.ctx.ui.dialog.confirm({
      title: `Prune older than ${days} days`,
      message: `${steps === undefined ? "The recorded usage" : `${steps} of ${formatCount(info?.tables.find((table) => table.name === "steps")?.rows ?? 0)} steps`} would be deleted. This cannot be undone.`,
      label: { confirm: "Prune", cancel: "Keep" },
    })
    if (confirmed !== true) return
    const cutoff = props.deps.now() - days * 24 * 60 * 60 * 1000
    const result = props.deps.withWrite?.((handle) => pruneOlderThan(handle, cutoff))
    if (result === undefined) {
      props.ctx.ui.toast.show({ message: "the recorder is writing: try again in a moment", variant: "warning" })
    } else {
      props.ctx.ui.toast.show({
        message: `pruned ${result.steps} steps · ${result.prompts} prompts · ${result.events} compactions`,
        variant: "success",
      })
    }
    setAnchor(undefined)
    setTick((value) => value + 1)
  }

  /** Give the space a prune freed back to the filesystem. */
  async function compact(): Promise<void> {
    const confirmed = await props.ctx.ui.dialog.confirm({
      title: "Compact the database",
      message: "SQLite rewrites the file to reclaim the space of deleted rows. It needs the recorder to be idle, and it can take a moment.",
      label: { confirm: "Compact", cancel: "Cancel" },
    })
    if (confirmed !== true) return
    const path = props.deps.dbPath()
    let result: { freed: number } | undefined
    try {
      result = props.deps.withWrite?.((handle) => vacuum(handle, path))
    } catch {
      result = undefined
    }
    if (result === undefined) {
      setBusy(true)
      props.ctx.ui.toast.show({ message: "the recorder is writing: try again in a moment", variant: "warning" })
    } else {
      setBusy(false)
      props.ctx.ui.toast.show({
        message: `compacted: ${(result.freed / 1_048_576).toFixed(1)} MB back`,
        variant: "success",
      })
    }
    setTick((value) => value + 1)
  }

  function back(): void {
    if (detail() === undefined) return
    setDetail(undefined)
    setAnchor(undefined)
  }

  async function pickFilter(kind: "model" | "endpoint"): Promise<void> {
    const db = props.deps.db()
    if (db === undefined) return
    const all = filterOptions(db)
    const list = kind === "model" ? all.models : all.endpoints
    const current = settings()
    const selected = kind === "model" ? current.modelID : current.routerID
    const value = await props.ctx.ui.dialog.select<string>({
      title: kind === "model" ? "Filter by model" : "Filter by endpoint (who served it)",
      current: selected,
      options: [
        { title: `any · ${list.length} observed`, value: "" },
        ...list.map((entry) => ({ title: entry.value, value: entry.value, description: `${entry.steps} steps`, category: kind })),
      ],
    })
    if (value === undefined) return
    props.update((draft) => {
      if (kind === "model") draft.modelID = value
      else draft.routerID = value
    })
    setAnchor(undefined)
    setDetail(undefined)
  }

  const command = (id: string, title: string, bind: string, run: () => void) => ({ id, title, bind, run })

  props.ctx.keymap.layer(() => {
    return {
      commands: [
        command("usage-insights.cursor.up", "Move up", "up", () => move(-1)),
        command("usage-insights.cursor.down", "Move down", "down", () => move(1)),
        command("usage-insights.cursor.up.alt", "Move up", "k", () => move(-1)),
        command("usage-insights.cursor.down.alt", "Move down", "j", () => move(1)),
        command("usage-insights.page.up", "Page up", "pageup", () => move(-10)),
        command("usage-insights.page.down", "Page down", "pagedown", () => move(10)),
        command("usage-insights.first", "First row", "home", () => moveEdge(false)),
        command("usage-insights.last", "Last row", "end", () => moveEdge(true)),
        command("usage-insights.drill", "Open the selected row", "return", () => drill()),
        command("usage-insights.back", "Go back", "backspace", () => back()),
        command("usage-insights.view.next", "Next view", "]", () => {
          setHelp(false)
          props.update((draft) => {
            draft.view = nextIn(PANEL_VIEWS, sanitizeSettings(draft).view, 1)
          })
        }),
        command("usage-insights.view.previous", "Previous view", "[", () => {
          setHelp(false)
          props.update((draft) => {
            draft.view = nextIn(PANEL_VIEWS, sanitizeSettings(draft).view, -1)
          })
        }),
        command("usage-insights.range.next", "Next range", "t", () => props.update((draft) => {
          draft.range = nextIn(RANGE_KEYS, sanitizeSettings(draft).range, 1)
        })),
        command("usage-insights.range.previous", "Previous range", "shift+t", () => props.update((draft) => {
          draft.range = nextIn(RANGE_KEYS, sanitizeSettings(draft).range, -1)
        })),
        command("usage-insights.sort.cycle", "Cycle sort column", "s", () => props.update((draft) => {
          const state = sanitizeSettings(draft)
          draft.sort = nextSort(state.view, state.sort === "" ? defaultSort(state.view) : state.sort, 1)
        })),
        command("usage-insights.sort.reverse", "Reverse sort", "shift+s", () => props.update((draft) => {
          draft.sortDesc = !sanitizeSettings(draft).sortDesc
        })),
        command("usage-insights.bucket", "Next period bucket", "b", () => props.update((draft) => {
          draft.granularity = nextIn(GRANULARITIES, sanitizeSettings(draft).granularity, 1)
          draft.view = "periods"
        })),
        command("usage-insights.scope", "Toggle the turns scope", "a", () => props.update((draft) => {
          draft.turnsScope = sanitizeSettings(draft).turnsScope === "session" ? "all" : "session"
          draft.view = "turns"
        })),
        command("usage-insights.filter.model", "Filter by model", "m", () => void pickFilter("model")),
        command("usage-insights.filter.endpoint", "Filter by endpoint", "e", () => void pickFilter("endpoint")),
        command("usage-insights.filter.clear", "Clear filters", "x", () => {
          props.update((draft) => {
            draft.modelID = ""
            draft.routerID = ""
          })
          setAnchor(undefined)
        }),
        command("usage-insights.refresh", "Refresh", "r", () => setTick((value) => value + 1)),
        command("usage-insights.vacuum", "Compact the database", "v", () => void compact()),
        command("usage-insights.help", "Help", "?", () => setHelp((open) => !open)),
        command("usage-insights.fullscreen", "Toggle full screen", "f", () => props.input.toggleFullscreen()),
        command("usage-insights.close", "Close usage panel", "escape", () => props.input.close()),
        ...PANEL_VIEWS.map((name, index) =>
          command(`usage-insights.view.${name}`, `View ${name}`, String((index + 1) % 10), () => {
            setHelp(false)
            props.update((draft) => {
              draft.view = name
            })
          }),
        ),
      ],
    }
  })

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

  const selectedBackground = (): RGBA => props.ctx.theme.background.raised.base
  const cursorIndex = (): number => cursor()

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Everything lives inside the scrollbox: in the current OpenTUI build,
          text siblings placed before a scrollbox overlap its first rows. */}
      <scrollbox
        flexGrow={1}
        scrollY={true}
        ref={(target: unknown) => {
          scroller = target as Scroller
          // The scrollbox must not take focus: the layer above owns the keys,
          // and a focused scrollbox would swallow the arrows first.
          const focusable = target as { focusable?: boolean }
          if (focusable !== null && typeof focusable === "object") focusable.focusable = false
        }}
        verticalScrollbarOptions={{ visible: true }}
      >
        <For each={header()}>{(line) => <text fg={color(line.tone)}>{line.text}</text>}</For>
        <For each={content()}>
          {(line, index) => (
            <text
              id={`line-${index()}`}
              fg={color(line.tone)}
              bg={index() === selectedLineIndex(content(), cursorIndex()) ? selectedBackground() : undefined}
            >
              {line.text}
            </text>
          )}
        </For>
        <text fg={props.ctx.theme.text.muted}>{""}</text>
        <text fg={props.ctx.theme.text.muted}>{keysFor(view())}</text>
      </scrollbox>
    </box>
  )
}

/** Line index under the cursor, so the renderer can highlight exactly one row. */
function selectedLineIndex(lines: readonly PanelLine[], cursor: number): number {
  let seen = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.row === undefined) continue
    seen += 1
    if (seen === cursor) return index
  }
  return -1
}
