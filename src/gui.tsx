/** @jsxImportSource solid-js */
import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Slot,
  Store,
  Style,
  createKeyed,
  createLatest,
  type Command as CommandItem,
  type MenuItem as MenuItemItem,
  type MountedSession,
  type PanelTab,
} from "@opencode/plugin/gui"
import { Schema } from "effect"
import { Suspense, createMemo, createSignal, lazy, onCleanup } from "solid-js"
import type { LineFields, LineLabels, TurnStats, TurnTotalsView } from "./core"
import { DEFAULT_SETTINGS, defaultSort, parseArgs, sanitizeSettings, type PanelSettings, type PanelView } from "./panel-data"
import { costOf, priceTable, type PriceFn, type PriceTable } from "./pricing"
import { usageApi } from "./rpc-client"
import type { RuntimeMessage, RuntimeSessionInfo } from "./line"
import { lineFor, type GuiLineOptions } from "./gui/line"
import { UsageBadge } from "./gui/badge"
import css from "./gui/usage.css?inline"
import icon from "./gui/icons/usage.svg?raw"
import en from "./gui/i18n/en"

const UsagePanel = lazy(() => import("./gui/panel").then((module) => ({ default: module.UsagePanel })))
const TurnsPanel = lazy(() => import("./gui/turns").then((module) => ({ default: module.TurnsPanel })))

/**
 * OpenCode Desktop side of the plugin. The window has no Bun and no SQLite:
 * the line comes from the server-synced transcript plus a tiny `listCost` RPC,
 * and the panel and the turn history come from the server's worker-backed
 * service. The same RPC is used by the TUI.
 */

export type Options = {
  enabled?: boolean | undefined
  /** Server-side; the GUI reads the database through the RPC. */
  db?: string | undefined
  pricing?: "auto" | "off" | undefined
  maintenance?: boolean | undefined
  exposePaths?: boolean | undefined
  turnTotals?: TurnTotalsView | undefined
  fields?: Partial<LineFields> | undefined
  labels?: Partial<LineLabels> | undefined
  sidebarTurns?: number | undefined
  panel?: boolean | undefined
}

const PanelStore = Store.global(
  Schema.Struct({
    view: Schema.String,
    range: Schema.String,
    sort: Schema.String,
    sortDesc: Schema.Boolean,
    granularity: Schema.String,
    turnsScope: Schema.String,
    modelID: Schema.String,
    providerID: Schema.String,
  }),
  DEFAULT_SETTINGS,
)

const PRICE_TTL_MS = 5 * 60 * 1000
const REFRESH_THROTTLE_MS = 300

export default Plugin.define({
  stores: { panel: PanelStore },
  icons: { usage: icon },
  i18n: { en },
  setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    if (options.enabled === false) return

    const panelEnabled = options.panel !== false
    const pricing = options.pricing !== "off"
    const key = `${ctx.id}:usage`
    const limit = Math.max(1, Math.round(options.sidebarTurns ?? 8))

    const settings = createMemo(() => sanitizeSettings(ctx.stores.panel.value as Partial<PanelSettings>))
    const update = (mutation: (draft: PanelSettings) => void): void => {
      ctx.stores.panel.update((draft) => {
        mutation(draft as unknown as PanelSettings)
      })
    }

    const lineOptions = (): GuiLineOptions => ({
      labels: options.labels,
      fields: options.fields,
      turnTotals: options.turnTotals,
      estimates: pricing,
    })

    const [refresh, setRefresh] = createSignal(0)
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let lastRefresh = 0

    function bumpRefresh(): void {
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
    }
    onCleanup(() => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    })

    // The server emits `recorded` after a write. Re-read the panel and the
    // session estimate only after that event, not on every transcript delta.
    createKeyed(
      () => ctx.servers.get("sidecar")?.client ?? ctx.client,
      (client) =>
        onCleanup(
          (() => {
            try {
              return usageApi(client).onRecorded(() => bumpRefresh())
            } catch {
              return () => {}
            }
          })(),
        ),
    )

    const listCost = createLatest(
      () => {
        if (!pricing) return
        const session = ctx.sessions.current()
        if (!session) return
        return {
          key: session.key,
          client: session.server.client,
          id: session.id,
          directory: session.directory,
          refresh: refresh(),
        }
      },
      (target, signal) => usageApi(target.client, { directory: target.directory }).listCost({ sessionID: target.id }, signal),
    )

    function listCostFor(session: MountedSession): number {
      const current = ctx.sessions.current()
      if (current?.key !== session.key) return 0
      return listCost.latest?.cost ?? 0
    }

    let priceCache: { key: string; table: PriceTable; at: number } | undefined
    function priceFor(session: MountedSession): PriceFn | undefined {
      if (!pricing) return undefined
      const cacheKey = `${session.server.id}\n${session.location?.directory ?? session.directory}`
      const now = Date.now()
      if (priceCache === undefined || priceCache.key !== cacheKey || now - priceCache.at >= PRICE_TTL_MS) {
        try {
          const models = session.server.data.location.model.list(session.location)
          if (models !== undefined && models.length > 0) {
            priceCache = { key: cacheKey, table: priceTable(models as never), at: now }
          }
        } catch {
          // Keep the previous table, exactly like the TUI line.
        }
      }
      if (priceCache === undefined || priceCache.key !== cacheKey) return undefined
      const table = priceCache.table
      return (ref, tokens) => costOf(table, ref, tokens)
    }

    createKeyed(
      () => ctx.servers.get("sidecar")?.data,
      (data) => onCleanup(data.on("model.updated", () => {
        priceCache = undefined
      })),
    )

    function lineForSession(session: MountedSession): TurnStats | undefined {
      try {
        return lineFor({
          messages: session.server.data.session.message.list(session.id) as unknown as RuntimeMessage[],
          info: session.server.data.session.get(session.id) as unknown as RuntimeSessionInfo | undefined,
          listCost: listCostFor(session),
          status: session.server.data.session.status(session.id),
          price: priceFor(session),
        })
      } catch {
        return undefined
      }
    }

    function openTurns(session: MountedSession): void {
      ctx.layout.open(`${ctx.id}:turns`, session, { tab: "select" })
    }

    function openPanel(session: MountedSession, view?: PanelView, toggle = false): void {
      if (view !== undefined) {
        update((draft) => {
          draft.view = view
          draft.sort = defaultSort(view)
          draft.sortDesc = true
        })
      }
      if (toggle) {
        const state = ctx.layout.state(key, session)
        if (state === "visible" || state === "active") {
          ctx.layout.close(key, session)
          return
        }
      }
      ctx.layout.open(key, session, { tab: "select" })
    }

    function runCommand(input?: string): void {
      const session = ctx.sessions.current()
      if (!session) {
        ctx.toast.show({ title: ctx.t("command.title"), description: ctx.t("command.noSession"), variant: "error" })
        return
      }
      const parsed = parseArgs(input)
      if (parsed.view !== undefined || parsed.range !== undefined) {
        update((draft) => {
          if (parsed.view !== undefined) {
            draft.view = parsed.view
            draft.sort = defaultSort(parsed.view)
          }
          if (parsed.range !== undefined) draft.range = parsed.range
        })
      }
      openPanel(session, undefined, (input ?? "").trim() === "")
    }

    ctx.add(Style, css)

    if (panelEnabled) {
      const command = (id: string, name: string, hidden?: true): CommandItem => ({
        id,
        title: ctx.t("command.title"),
        description: ctx.t("command.description"),
        group: ctx.t("command.group"),
        section: "session",
        ...(hidden === true ? { hidden: true as const } : {}),
        slash: { name, arguments: true },
        run: (input) => runCommand(input),
      })
      ctx.add(Command, () => command("usage", "usage"))
      // The GUI slash type has no aliases: a hidden second command keeps
      // `/insights` working without a duplicate palette entry.
      ctx.add(Command, () => command("insights", "insights", true))

      const usageTab: PanelTab = {
        id: "usage",
        get title() {
          return ctx.t("panel.title")
        },
        closable: "hover",
        fallback: true,
      }
      const turnsTab: PanelTab = {
        id: "turns",
        get title() {
          return ctx.t("panel.turns")
        },
        closable: "hover",
      }

      ctx.add(Panel, {
        id: "usage",
        region: "side",
        width: 520,
        mobile: {
          get title() {
            return ctx.t("panel.title")
          },
          order: 50,
          kind: "tab",
          icon: ctx.icons.usage,
          cached: true,
        },
        list: (input) =>
          input.open
            .map((id) => (id === "usage" ? usageTab : id === "turns" ? turnsTab : undefined))
            .filter((tab): tab is PanelTab => tab !== undefined),
        render: (props) =>
          props.tab.id === "turns" ? (
            <Suspense fallback={<div data-slot="oui-loading">{ctx.t("panel.loading")}</div>}>
              <TurnsPanel session={props.session} refresh={refresh} limit={limit} />
            </Suspense>
          ) : (
            <Suspense fallback={<div data-slot="oui-loading">{ctx.t("panel.loading")}</div>}>
              <UsagePanel
                session={props.session}
                settings={settings}
                update={update}
                refresh={refresh}
                bump={bumpRefresh}
                pricing={pricing}
                maintenance={options.maintenance !== false}
              />
            </Suspense>
          ),
      })

      ctx.add(MenuItem, (): MenuItemItem => {
        const session = ctx.sessions.current()
        return {
          menu: "session.panel",
          id: "usage",
          title: ctx.t("panel.title"),
          icon: ctx.icons.usage,
          opened: session !== undefined && ctx.layout.state(key, session) !== "closed",
          run: () => {
            const current = ctx.sessions.current()
            if (current) openPanel(current)
          },
        }
      })

      ctx.add(MenuItem, (): MenuItemItem => {
        const session = ctx.sessions.current()
        return {
          menu: "session.panel",
          id: "turns",
          title: ctx.t("panel.turns"),
          icon: ctx.icons.usage,
          opened: session !== undefined && ctx.layout.state(`${ctx.id}:turns`, session) !== "closed",
          run: () => {
            const current = ctx.sessions.current()
            if (current) openTurns(current)
          },
        }
      })
    }

    ctx.add(Slot, {
      at: "session.header",
      order: 90,
      render: (input) => (
        <UsageBadge
          line={() => lineForSession(input.session)}
          options={lineOptions()}
          icon={ctx.icons.usage}
          compact={input.compact}
          panelEnabled={panelEnabled}
          open={() => openTurns(input.session)}
        />
      ),
    })
  },
})
