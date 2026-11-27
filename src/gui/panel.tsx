/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from "solid-js"
import { createLatest, usePanel, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import {
  GRANULARITIES,
  PANEL_VIEWS,
  RANGE_KEYS,
  SORT_KEYS,
  defaultSort,
  filterSummary,
  formatCount,
  sanitizeSettings,
  type PanelRow,
  type PanelSettings,
  type PanelView,
  type RangeKey,
  type Granularity,
} from "../panel-data"
import { usageApi } from "../rpc-client"
import type { FiltersOutput, PanelInput } from "../rpc"
import { toneClass } from "./line"

/**
 * The desktop `/usage` panel. The server formats the rows exactly as it does
 * for the TUI; this component adds the desktop controls (selects, filters,
 * maintenance buttons) and keeps the previous rows while a new query runs.
 */

type Props = {
  readonly session: MountedSession
  readonly settings: () => PanelSettings
  readonly update: (mutation: (draft: PanelSettings) => void) => void
  readonly refresh: () => number
  readonly bump: () => void
  readonly pricing: boolean
  readonly maintenance: boolean
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (cause !== null && typeof cause === "object" && "message" in cause) return String((cause as { message: unknown }).message)
  return ""
}

export function UsagePanel(props: Props) {
  const ctx = usePlugin()
  const panel = usePanel()
  const [detail, setDetail] = createSignal<PanelRow | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const settings = createMemo(() => sanitizeSettings(props.settings()))
  const view = (): PanelView => settings().view
  const width = (): number => (panel.placement() === "mobile" ? 48 : 72)
  const api = () => usageApi(props.session.server.client, { directory: props.session.directory })

  const request = createMemo<PanelInput | undefined>(() => {
    props.refresh()
    if (!panel.visible()) return undefined
    const current = settings()
    return {
      sessionID: props.session.id,
      settings: current,
      ...(detail() !== undefined ? { detail: detail() } : {}),
      width: width(),
      busy: busy(),
    }
  })

  const source = createMemo(() => {
    const input = request()
    if (input === undefined) return undefined
    return { input, client: props.session.server.client, directory: props.session.directory }
  })

  const result = createLatest(source, (value, signal) =>
    usageApi(value.client, { directory: value.directory }).panel(value.input, signal),
  )
  const lines = createMemo(() =>
    (result.latest?.lines ?? []).filter(
      (line) => line.hint !== true && (props.maintenance || line.row?.kind !== "prune"),
    ),
  )
  const database = createMemo(() => result.latest?.database)

  const toast = (title: string, description?: string, variant: "default" | "success" | "error" = "default"): void => {
    ctx.toast.show({ title, description, variant })
  }

  const update = (mutation: (draft: PanelSettings) => void): void => {
    props.update(mutation)
  }

  const setView = (value: PanelView): void => {
    update((draft) => {
      draft.view = value
      draft.sort = defaultSort(value)
      draft.sortDesc = true
    })
    setDetail(undefined)
  }

  const setRange = (value: RangeKey): void => update((draft) => { draft.range = value })
  const setGranularity = (value: Granularity): void => update((draft) => { draft.granularity = value })
  const setScope = (value: "session" | "all"): void => update((draft) => { draft.turnsScope = value })
  const setSort = (value: string): void => update((draft) => { draft.sort = value })
  const toggleDirection = (): void => update((draft) => { draft.sortDesc = !draft.sortDesc })

  async function pickFilter(kind: "model" | "provider"): Promise<void> {
    let all: FiltersOutput
    try {
      all = await api().filters()
    } catch (cause) {
      toast(ctx.t("panel.unavailable"), errorMessage(cause), "error")
      return
    }
    const current = settings()
    const list = kind === "model" ? all.models : all.providers
    const label = kind === "model" ? ctx.t("panel.model") : ctx.t("panel.provider")
    const value = await ctx.dialogs.select<string>({
      title: label,
      options: [
        { title: kind === "model" ? ctx.t("panel.allModels") : ctx.t("panel.allProviders"), value: "" },
        ...list.map((entry) => ({ title: `${entry.value} · ${entry.steps}`, value: entry.value })),
      ],
    })
    if (value === undefined) return
    update((draft) => {
      if (kind === "model") draft.modelID = value
      else draft.providerID = value
    })
    setDetail(undefined)
  }

  const sessionRunning = (): boolean => {
    try {
      return props.session.server.data.session.status(props.session.id) === "running"
    } catch {
      return false
    }
  }

  async function prune(days: number): Promise<void> {
    if (sessionRunning()) {
      toast(ctx.t("panel.title"), ctx.t("panel.busy"), "error")
      return
    }
    const info = database()
    const steps = info?.removable.find((option) => option.days === days)?.steps
    const total = info?.tables.find((table) => table.name === "steps")?.rows ?? 0
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("panel.confirmPrune", { days }),
      description: ctx.t("panel.confirmPruneDetail", { steps: steps ?? 0, total }),
      confirm: ctx.t("panel.prune", { days }),
      cancel: ctx.t("panel.cancel"),
      danger: true,
    })
    if (!confirmed) return
    try {
      const result = await api().prune({ days, confirm: true })
      toast(
        ctx.t("panel.pruned", { steps: result.steps, prompts: result.prompts, events: result.events }),
        undefined,
        "success",
      )
      setBusy(false)
    } catch (cause) {
      setBusy(true)
      toast(ctx.t("panel.title"), errorMessage(cause), "error")
    }
    props.bump()
  }

  async function backfill(): Promise<void> {
    if (!props.pricing) {
      toast(ctx.t("panel.pricingOff"))
      return
    }
    if (sessionRunning()) {
      toast(ctx.t("panel.title"), ctx.t("panel.busy"), "error")
      return
    }
    const info = database()
    const count = info?.unpriced ?? 0
    if (info !== undefined && count === 0) {
      toast(ctx.t("panel.noUnpriced"))
      return
    }
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("panel.confirmBackfill"),
      description: ctx.t("panel.confirmBackfillDetail", { count }),
      confirm: ctx.t("panel.backfill"),
      cancel: ctx.t("panel.cancel"),
    })
    if (!confirmed) return
    try {
      const result = await api().backfill({ confirm: true })
      toast(ctx.t("panel.backfilled", { updated: formatCount(result.updated), candidates: formatCount(result.candidates) }), undefined, "success")
      setBusy(false)
    } catch (cause) {
      setBusy(true)
      toast(ctx.t("panel.title"), errorMessage(cause), "error")
    }
    props.bump()
  }

  async function vacuum(): Promise<void> {
    if (sessionRunning()) {
      toast(ctx.t("panel.title"), ctx.t("panel.busy"), "error")
      return
    }
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("panel.confirmVacuum"),
      description: ctx.t("panel.confirmVacuumDetail"),
      confirm: ctx.t("panel.vacuum"),
      cancel: ctx.t("panel.cancel"),
    })
    if (!confirmed) return
    try {
      const result = await api().vacuum({ confirm: true })
      toast(ctx.t("panel.vacuumed", { size: (result.freed / 1_048_576).toFixed(1) }), undefined, "success")
      setBusy(false)
    } catch (cause) {
      setBusy(true)
      toast(ctx.t("panel.title"), errorMessage(cause), "error")
    }
    props.bump()
  }

  async function copyPath(): Promise<void> {
    const path = database()?.path
    if (path === undefined) return
    try {
      await ctx.system.copy(path)
      toast(ctx.t("panel.pathCopied"))
    } catch (cause) {
      toast(ctx.t("panel.title"), errorMessage(cause), "error")
    }
  }

  const drill = (row: PanelRow): void => {
    if (row.kind === "prune") {
      void prune(Number.parseInt(row.value, 10))
      return
    }
    setDetail(row)
  }

  const rangeLabel = (): string => ctx.t(`range.${settings().range}`)
  const filter = (): string | undefined => filterSummary(settings())
  const sortKeys = (): readonly string[] => SORT_KEYS[view()] ?? []
  const detailTitle = (): string => lines()[0]?.text ?? ""

  return (
    <div data-component="oui-panel">
      <div data-slot="oui-header">
        <div data-slot="oui-title-row">
          <span data-slot="oui-title">{ctx.t("panel.title")}</span>
          <span data-slot="oui-subtitle">
            {rangeLabel()}
            {filter() !== undefined ? ` · ${filter()}` : ""}
            {result.loading ? " · …" : ""}
          </span>
        </div>
        <div data-slot="oui-controls">
          <ctx.ui.Select
            label={ctx.t("panel.view")}
            value={view()}
            options={PANEL_VIEWS.map((name) => ({ value: name, label: ctx.t(`view.${name}`) }))}
            onChange={(value) => setView(value as PanelView)}
          />
          <ctx.ui.Select
            label={ctx.t("panel.range")}
            value={settings().range}
            options={RANGE_KEYS.map((key) => ({ value: key, label: ctx.t(`range.${key}`) }))}
            onChange={(value) => setRange(value as RangeKey)}
          />
          <Show when={sortKeys().length > 0}>
            <ctx.ui.Select
              label={ctx.t("panel.sort")}
              value={settings().sort === "" ? defaultSort(view()) : settings().sort}
              options={sortKeys().map((key) => ({ value: key, label: ctx.t(`sort.${key}`) }))}
              onChange={setSort}
            />
            <ctx.ui.Button size="small" variant="ghost" onClick={toggleDirection}>
              {settings().sortDesc ? "↓" : "↑"}
            </ctx.ui.Button>
          </Show>
          <ctx.ui.Button size="small" variant="ghost" onClick={() => void pickFilter("model")}>
            {settings().modelID === "" ? ctx.t("panel.model") : settings().modelID}
          </ctx.ui.Button>
          <ctx.ui.Button size="small" variant="ghost" onClick={() => void pickFilter("provider")}>
            {settings().providerID === "" ? ctx.t("panel.provider") : settings().providerID}
          </ctx.ui.Button>
          <Show when={view() === "turns"}>
            <ctx.ui.Select
              label={ctx.t("panel.scope")}
              value={settings().turnsScope}
              options={[
                { value: "session", label: ctx.t("panel.thisSession") },
                { value: "all", label: ctx.t("panel.allSessions") },
              ]}
              onChange={(value) => setScope(value as "session" | "all")}
            />
          </Show>
          <Show when={view() === "periods"}>
            <ctx.ui.Select
              label={ctx.t("panel.granularity")}
              value={settings().granularity}
              options={GRANULARITIES.map((value) => ({ value, label: ctx.t(`granularity.${value}`) }))}
              onChange={(value) => setGranularity(value as Granularity)}
            />
          </Show>
          <ctx.ui.Button size="small" variant="ghost" onClick={() => props.bump()}>
            {ctx.t("panel.refresh")}
          </ctx.ui.Button>
        </div>
      </div>

      <Show when={detail()}>
        {(row) => (
          <div data-slot="oui-detail-head">
            <ctx.ui.Button size="small" variant="ghost" onClick={() => setDetail(undefined)}>
              ← {ctx.t("panel.back")}
            </ctx.ui.Button>
            <span data-slot="oui-subtitle">{detailTitle()}</span>
          </div>
        )}
      </Show>

      <div data-slot="oui-body" data-scrollable>
        <Show when={result.latest !== undefined} fallback={
          <Show when={result.error !== undefined} fallback={<div data-slot="oui-loading">{ctx.t("panel.loading")}</div>}>
            <div data-slot="oui-error" title={errorMessage(result.error)}>{ctx.t("panel.unavailable")}</div>
          </Show>
        }>
          <Show when={lines().length === 0}>
            <div data-slot="oui-empty">{ctx.t("panel.empty")}</div>
          </Show>
          <div data-slot="oui-lines" style={{ "font-family": ctx.appearance.font("mono") }}>
            <For each={lines()}>
              {(line) => (
                <Show
                  when={line.row !== undefined}
                  fallback={<div data-slot="oui-line" class={toneClass(line.tone)}>{line.text}</div>}
                >
                  <button
                    type="button"
                    data-slot="oui-line"
                    data-selectable="true"
                    class={toneClass(line.tone)}
                    onClick={() => drill(line.row!)}
                  >
                    {line.text}
                  </button>
                </Show>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div data-slot="oui-actions">
        <ctx.ui.Button
          size="small"
          variant="neutral"
          onClick={() => ctx.layout.open(`${ctx.id}:turns`, props.session, { tab: "select" })}
        >
          {ctx.t("panel.openTurns")}
        </ctx.ui.Button>
        <Show when={props.maintenance && view() === "db" && database()}>
          {(info) => (
            <>
              <ctx.ui.Button
                size="small"
                variant="neutral"
                disabled={!props.pricing || info().unpriced === 0}
                onClick={() => void backfill()}
              >
                {ctx.t("panel.backfill")} ({formatCount(info().unpriced)})
              </ctx.ui.Button>
              <For each={info().removable}>
                {(option) => (
                  <ctx.ui.Button size="small" variant="danger" onClick={() => void prune(option.days)}>
                    {ctx.t("panel.prune", { days: option.days })}
                  </ctx.ui.Button>
                )}
              </For>
              <ctx.ui.Button size="small" variant="neutral" onClick={() => void vacuum()}>
                {ctx.t("panel.vacuum")}
              </ctx.ui.Button>
              <ctx.ui.Button size="small" variant="ghost-muted" onClick={() => void copyPath()}>
                {ctx.t("panel.copyPath")}
              </ctx.ui.Button>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
