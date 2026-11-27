/** @jsxImportSource @opentui/solid */
import { TextAttributes, type RGBA } from "@opentui/core"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createRenderEffect, createSignal } from "solid-js"
import {
  GRANULARITIES,
  PANEL_VIEWS,
  RANGE_KEYS,
  defaultSort,
  filterSummary,
  formatCount,
  helpLines,
  keysFor,
  nextIn,
  nextSort,
  rangeLabel,
  sanitizeSettings,
  viewBar,
  type PanelLine,
  type PanelRow,
  type PanelSettings,
  type PanelTone,
  type PanelView,
} from "./panel-data"
import { clampPanelWidth } from "./limits"
import { usageApi } from "./rpc-client"
import type { FiltersOutput, PanelInput as UsagePanelInput } from "./rpc"
import type { DbInfo } from "./stats/maintenance"

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
  /** Bumped by the TUI when a step or an execution ends, so views re-read. */
  refresh?: (() => number) | undefined
  /**
   * Ask the TUI to rebuild every read view after a maintenance write. The
   * panel has its own tick; the sidebar observes the TUI's shared signal.
   */
  bump?: (() => void) | undefined
}

type Scroller = { scrollChildIntoView?: ((id: string) => void) | undefined }

export function Panel(props: {
  readonly input: PanelInput
  readonly ctx: Context
  readonly deps: PanelDeps
  readonly settings: PanelSettings
  readonly update: (mutation: (draft: PanelSettings) => void) => void
  readonly maintenance?: boolean | undefined
}) {
  const [anchor, setAnchor] = createSignal<string | undefined>(undefined)
  const [detail, setDetail] = createSignal<PanelRow | undefined>(undefined)
  const [help, setHelp] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  // Set when a vacuum could not take the write lock: the recorder is mid-write.
  const [busy, setBusy] = createSignal(false)
  const [lines, setLines] = createSignal<PanelLine[]>([])
  const [database, setDatabase] = createSignal<DbInfo | undefined>(undefined)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)
  let generation = 0
  let scroller: Scroller | undefined

  // The RPC schema rejects a width over the server's formatting budget. A
  // full-screen panel on a very wide terminal can exceed it, so clamp on the
  // client instead of relying on the service clamp, which runs after the
  // schema has already rejected the request.
  const width = (): number => clampPanelWidth(Math.max(60, props.input.width - 4))
  const view = (): PanelView => sanitizeSettings(props.settings).view
  const settings = (): PanelSettings => sanitizeSettings(props.settings)

  const api = () => usageApi(props.ctx.client, props.ctx.location)

  function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message
    if (cause !== null && typeof cause === "object" && "message" in cause) return String((cause as { message: unknown }).message)
    return "usage service unavailable"
  }

  const rowKey = (row: PanelRow): string => `${row.kind}:${row.value}${row.variant !== undefined ? `#${row.variant}` : ""}`

  /**
   * What the file holds. Reading it stats the file and counts rows in every
   * table, so only the `db` view (and the prune confirmation) asks for it: the
   * other views must not pay for it on every rebuild.
   */
  const request = createMemo<UsagePanelInput | undefined>(() => {
    tick()
    props.deps.refresh?.()
    if (help()) return undefined
    const current = settings()
    return {
      sessionID: props.input.sessionID,
      settings: current,
      ...(detail() !== undefined ? { detail: detail() } : {}),
      width: width(),
      busy: busy(),
    }
  })

  createEffect(() => {
    const input = request()
    const current = ++generation
    if (input === undefined) {
      setLines(helpLines(width()))
      setDatabase(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    void api()
      .panel(input)
      .then((result) => {
        if (current !== generation) return
        setLines(result.lines)
        setDatabase(result.database)
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (current !== generation) return
        setError(errorMessage(cause))
        if (lines().length === 0) setLines([])
      })
      .finally(() => {
        if (current === generation) setLoading(false)
      })
  })

  const content = createMemo<PanelLine[]>(() => {
    if (error() !== undefined && lines().length === 0) {
      return [{ text: `usage service unavailable: ${error()}`, tone: "warning" }]
    }
    const visible = (line: PanelLine): boolean => props.maintenance !== false || line.row?.kind !== "prune"
    return lines().filter(visible)
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

  /**
   * True while the session is running. The recorder writes on the agent's own
   * event path, so a maintenance action that holds the write lock for a while
   * would make the agent wait: it is refused instead, before it is even offered.
   */
  function sessionRunning(): boolean {
    try {
      return props.ctx.data.session.status(props.input.sessionID) === "running"
    } catch {
      return false
    }
  }

  /** Delete the recorded usage older than `days`, after asking. */
  async function prune(days: number): Promise<void> {
    if (props.maintenance === false) {
      props.ctx.ui.toast.show({ message: "database maintenance is disabled", variant: "warning" })
      return
    }
    if (!Number.isFinite(days)) return
    if (sessionRunning()) {
      props.ctx.ui.toast.show({ message: "the session is running: prune again when it is idle", variant: "warning" })
      return
    }
    const info = database()
    const steps = info?.removable.find((option) => option.days === days)?.steps
    const confirmed = await props.ctx.ui.dialog.confirm({
      title: `Prune older than ${days} days`,
      message: `${steps === undefined ? "The recorded usage" : `${steps} of ${formatCount(info?.tables.find((table) => table.name === "steps")?.rows ?? 0)} steps`} would be deleted. This cannot be undone.`,
      label: { confirm: "Prune", cancel: "Keep" },
    })
    if (confirmed !== true) return
    try {
      const result = await api().prune({ days, confirm: true })
      props.ctx.ui.toast.show({
        message: `pruned ${result.steps} steps · ${result.prompts} prompts · ${result.events} compactions · ${result.usage} other usage`,
        variant: "success",
      })
    } catch (cause) {
      props.ctx.ui.toast.show({ message: errorMessage(cause), variant: "warning" })
    }
    setAnchor(undefined)
    setTick((value) => value + 1)
    // A batched prune can have committed some batches before failing; the
    // sidebar reads the same server database but has no tick of its own.
    props.deps.bump?.()
  }

  /** Price the historical steps the host recorded at $0. */
  async function backfillEstimates(): Promise<void> {
    if (props.maintenance === false) {
      props.ctx.ui.toast.show({ message: "database maintenance is disabled", variant: "warning" })
      return
    }
    if (sessionRunning()) {
      props.ctx.ui.toast.show({ message: "the session is running: backfill again when it is idle", variant: "warning" })
      return
    }
    const info = database()
    if (info !== undefined && info.schemaVersion < 10) {
      props.ctx.ui.toast.show({ message: "the recorder must upgrade the database before estimates can be backfilled", variant: "warning" })
      return
    }
    const candidates = info?.unpriced ?? 0
    if (info !== undefined && candidates === 0) {
      props.ctx.ui.toast.show({ message: "every $0 step already has a list estimate" })
      return
    }
    const confirmed = await props.ctx.ui.dialog.confirm({
      title: "Backfill list-price estimates",
      message: `${formatCount(candidates)} steps recorded at $0 have no estimate. Those with a known catalog price will be filled using today's catalog; models the catalog no longer lists stay unknown.`,
      label: { confirm: "Backfill", cancel: "Cancel" },
    })
    if (confirmed !== true) return
    try {
      const result = await api().backfill({ confirm: true })
      props.ctx.ui.toast.show({
        message: `backfilled ${formatCount(result.updated)} of ${formatCount(result.candidates)} steps`,
        variant: result.updated === 0 ? "warning" : "success",
      })
    } catch (cause) {
      props.ctx.ui.toast.show({ message: errorMessage(cause), variant: "warning" })
    }
    setTick((value) => value + 1)
    // A backfill can have committed some batches before failing; re-read even
    // when the final result is unknown.
    props.deps.bump?.()
  }

  /** Give the space a prune freed back to the filesystem. */
  async function compact(): Promise<void> {
    if (props.maintenance === false) {
      props.ctx.ui.toast.show({ message: "database maintenance is disabled", variant: "warning" })
      return
    }
    if (sessionRunning()) {
      props.ctx.ui.toast.show({ message: "the session is running: compact again when it is idle", variant: "warning" })
      return
    }
    const confirmed = await props.ctx.ui.dialog.confirm({
      title: "Compact the database",
      message: "SQLite rewrites the file to reclaim the space of deleted rows. It needs the recorder to be idle, and it can take a moment.",
      label: { confirm: "Compact", cancel: "Cancel" },
    })
    if (confirmed !== true) return
    try {
      const result = await api().vacuum({ confirm: true })
      setBusy(false)
      props.ctx.ui.toast.show({
        message: `compacted: ${(result.freed / 1_048_576).toFixed(1)} MB back`,
        variant: "success",
      })
    } catch (cause) {
      setBusy(true)
      props.ctx.ui.toast.show({ message: errorMessage(cause), variant: "warning" })
    }
    setTick((value) => value + 1)
  }

  function back(): void {
    if (detail() === undefined) return
    setDetail(undefined)
    setAnchor(undefined)
  }

  async function pickFilter(kind: "model" | "provider"): Promise<void> {
    let all: FiltersOutput
    try {
      all = await api().filters()
    } catch (cause) {
      props.ctx.ui.toast.show({ message: errorMessage(cause), variant: "warning" })
      return
    }
    const list = kind === "model" ? all.models : all.providers
    const current = settings()
    const selected = kind === "model" ? current.modelID : current.providerID
    const value = await props.ctx.ui.dialog.select<string>({
      title: kind === "model" ? "Filter by model" : "Filter by provider",
      current: selected,
      options: [
        { title: `any · ${list.length} observed`, value: "" },
        ...list.map((entry) => ({ title: entry.value, value: entry.value, description: `${entry.steps} steps`, category: kind })),
      ],
    })
    if (value === undefined) return
    props.update((draft) => {
      if (kind === "model") draft.modelID = value
      else draft.providerID = value
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
        command("usage-insights.filter.provider", "Filter by provider", "p", () => void pickFilter("provider")),
        command("usage-insights.filter.clear", "Clear filters", "x", () => {
          props.update((draft) => {
            draft.modelID = ""
            draft.providerID = ""
          })
          setAnchor(undefined)
        }),
        command("usage-insights.refresh", "Refresh", "r", () => setTick((value) => value + 1)),
        command("usage-insights.backfill", "Backfill list-price estimates", "e", () => {
          if (view() === "db") void backfillEstimates()
        }),
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

  // The host paints the panel surface with `background.raised.base` (and
  // `background.base` full screen), so the cursor has to step up a rung: a
  // `raised.base` band would be invisible on the panel it sits on. `raised.high`
  // is the token the host itself uses for a selected row on a raised surface.
  const selectedBackground = (): RGBA => props.ctx.theme.background.raised.high
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
          {(line, index) => {
            const selected = () => index() === selectedLineIndex(content(), cursorIndex())
            return (
              <text
                id={`line-${index()}`}
                fg={color(line.tone)}
                bg={selected() ? selectedBackground() : undefined}
                attributes={selected() ? TextAttributes.BOLD : undefined}
              >
                {line.text}
              </text>
            )
          }}
        </For>
        <Show when={loading()}>
          <text fg={props.ctx.theme.text.muted}>loading…</text>
        </Show>
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
