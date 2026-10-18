/**
 * Harness that drives the TUI plugin outside a terminal.
 *
 * `bun test` loads this through `bunfig.toml`, which preloads
 * `test/preload.ts` so the harness, the plugin and the renderer share the
 * client build of Solid. `scripts/screenshot.ts` loads the same harness to
 * render the real slots, commands and components into images, so anything the
 * harness mounts behaves exactly like it does in a test.
 */
import { plugin as registerBunPlugin } from "bun"
import { RGBA } from "@opentui/core"
import solid from "@opentui/solid/bun-plugin"
import { createSignal } from "solid-js"
import { DEFAULT_SETTINGS, type PanelSettings } from "../src/panel-data"
import type { RuntimeMessage, RuntimeModelRef, RuntimeTokenUsage } from "../src/line"

registerBunPlugin(solid)

/** The plugin module under test. Named exports carry the test hooks. */
export const pluginModule = await import("../src/tui.tsx")

// The host message shapes are shadowed structurally by the plugin, so the
// harness reuses those definitions instead of duplicating them: a fixture the
// plugin accepts is a fixture the harness accepts.
export type RuntimeModel = RuntimeModelRef
export type RuntimeTokens = RuntimeTokenUsage
export type { RuntimeMessage }
export type SessionSeed = { id: string; created: number; tokens?: RuntimeTokens; cost?: number; messages?: RuntimeMessage[] }

export type SlotClaim = { append?: string; prepend?: string; render: (input: never) => unknown }
export type KeymapCommand = {
  id: string
  title: string
  description?: string
  bind?: boolean | string
  palette?: boolean
  slash?: { name: string; aliases?: string[]; arguments?: boolean }
  run: (input?: string) => void
}
export type KeymapLayer = { mode?: string; commands?: KeymapCommand[] }

/**
 * Theme tokens the plugin reads. The defaults read like a test terminal; the
 * screenshot script passes its own palette so the images look like a session.
 */
export type HarnessTheme = {
  text: {
    base: RGBA
    muted: RGBA
    feedback: { warning: { base: RGBA }; info: { base: RGBA } }
  }
  background: {
    base: RGBA
    raised: { base: RGBA; high: RGBA }
  }
}

export const DEFAULT_HARNESS_THEME: HarnessTheme = {
  text: {
    base: RGBA.fromInts(220, 220, 220, 255),
    muted: RGBA.fromInts(120, 120, 120, 255),
    feedback: {
      warning: { base: RGBA.fromInts(255, 200, 0, 255) },
      info: { base: RGBA.fromInts(80, 160, 255, 255) },
    },
  },
  background: {
    base: RGBA.fromInts(20, 20, 20, 255),
    raised: { base: RGBA.fromInts(40, 40, 40, 255), high: RGBA.fromInts(64, 64, 64, 255) },
  },
}

/** Theme overrides, merged over the defaults token by token. */
export type HarnessThemeOverrides = {
  text?: {
    base?: RGBA
    muted?: RGBA
    feedback?: { warning?: { base?: RGBA }; info?: { base?: RGBA } }
  }
  background?: {
    base?: RGBA
    raised?: { base?: RGBA; high?: RGBA }
  }
}

export type HarnessConfig = {
  options?: Record<string, unknown>
  sessions?: SessionSeed[]
  panelOpens?: boolean
  confirm?: boolean
  theme?: HarnessThemeOverrides
}

export function createHarness(config: HarnessConfig = {}) {
  const claims: SlotClaim[] = []
  const commands: KeymapCommand[] = []
  const layers: KeymapLayer[] = []
  const opened: string[] = []
  let currentPanel: { name: string; sessionID: string } | undefined
  const toasts: Array<{ message: string; variant?: string }> = []
  const dialogs: Array<{ title: string; message: string }> = []
  let listReads = 0
  const events: Array<{ type: string; handler: (payload: unknown) => void; live: boolean }> = []
  const sessions = new Map<string, SessionSeed>()
  // The panel keeps its view, range, sort and filters in the host's durable
  // store. The mock mirrors it with a signal-backed proxy: property reads track
  // and a mutation replaces the draft, exactly like the host's store does for
  // the plugin.
  const [panelSettings, setPanelSettings] = createSignal<PanelSettings>({ ...DEFAULT_SETTINGS }, { equals: false })
  const settingsProxy = new Proxy({} as PanelSettings, {
    get: (_target, key) => (panelSettings() as Record<string | symbol, unknown>)[key],
    set: () => true,
    // A spread reads own keys, not properties: without these two traps the
    // panel would only ever see the defaults.
    ownKeys: () => Reflect.ownKeys(panelSettings()),
    getOwnPropertyDescriptor: (_target, key) => ({
      enumerable: true,
      configurable: true,
      value: (panelSettings() as Record<string | symbol, unknown>)[key],
    }),
  })
  // The reactive message store: the real host publishes session messages
  // through a store, so render tests must be able to trigger updates.
  const messageSignals = new Map<string, [() => RuntimeMessage[], (next: RuntimeMessage[]) => void]>()
  // The host publishes a session's run state from its execution events; the
  // line reads it to stay hidden while a turn is still running.
  const statusSignals = new Map<string, [() => "idle" | "running", (next: "idle" | "running") => void]>()
  for (const session of config.sessions ?? []) {
    sessions.set(session.id, session)
    const [messages, setMessages] = createSignal<RuntimeMessage[]>(session.messages ?? [])
    messageSignals.set(session.id, [messages, setMessages])
    const [status, setStatus] = createSignal<"idle" | "running">("idle")
    statusSignals.set(session.id, [status, setStatus])
  }

  const theme = mergeTheme(DEFAULT_HARNESS_THEME, config.theme)

  const ctx = {
    options: config.options ?? {},
    location: { directory: "/project" },
    data: {
      on: (type: string, handler: (payload: unknown) => void) => {
        const entry = { type, handler, live: true }
        events.push(entry)
        return () => {
          entry.live = false
        }
      },
      session: {
        get: (id: string) => {
          const session = sessions.get(id)
          return session === undefined ? undefined : { id, time: { created: session.created }, tokens: session.tokens, cost: session.cost }
        },
        status: (id: string) => statusSignals.get(id)?.[0]() ?? "idle",
        message: {
          list: (id: string) => {
            listReads += 1
            return messageSignals.get(id)?.[0]() ?? []
          },
        },
      },
    },
    theme,
    ui: {
      slot: (claim: SlotClaim) => {
        claims.push(claim)
        return () => {
          const index = claims.indexOf(claim)
          if (index >= 0) claims.splice(index, 1)
        }
      },
      panel: {
        open: (name: string) => {
          opened.push(name)
          const ok = config.panelOpens ?? true
          if (ok) currentPanel = { name, sessionID: "ses_panel" }
          return ok
        },
        current: () => currentPanel,
        close: () => {
          currentPanel = undefined
        },
      },
      toast: {
        show: (options: { message: string; variant?: string }) => {
          toasts.push(options)
        },
      },
      dialog: {
        confirm: (options: { title: string; message: string }) => {
          dialogs.push(options)
          return Promise.resolve(config.confirm ?? true)
        },
      },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        const layer = factory()
        layers.push(layer)
        commands.push(...(layer.commands ?? []))
      },
    },
    storage: {
      store: () => [
        settingsProxy,
        (mutation: (draft: PanelSettings) => void) => {
          const draft = { ...panelSettings() }
          mutation(draft)
          setPanelSettings(draft)
          return Promise.resolve()
        },
      ],
    },
  }

  const cleanup = pluginModule.default.setup(ctx as never) as unknown as (() => void) | undefined

  return {
    claims,
    commands,
    layers,
    opened,
    panel: () => currentPanel,
    toasts,
    dialogs,
    listReads: () => listReads,
    events,
    sessions,
    cleanup,
    theme,
    command: (id: string) => commands.find((entry) => entry.id === id),
    claim: (path: string) => claims.find((entry) => (entry.append ?? entry.prepend) === path),
    setMessages: (sessionID: string, next: RuntimeMessage[]) => messageSignals.get(sessionID)?.[1](next),
    setStatus: (sessionID: string, next: "idle" | "running") => statusSignals.get(sessionID)?.[1](next),
    lineText: (sessionID: string) => pluginModule.__test.lineText!(sessionID),
    state: () => pluginModule.__test.state!(),
    emit: (type: string, payload?: unknown) => {
      for (const entry of events) {
        if (entry.live && entry.type === type) entry.handler({ type, data: payload })
      }
    },
  }
}

export type Harness = ReturnType<typeof createHarness>

function mergeTheme(base: HarnessTheme, overrides: HarnessThemeOverrides | undefined): HarnessTheme {
  if (overrides === undefined) return base
  return {
    text: {
      base: overrides.text?.base ?? base.text.base,
      muted: overrides.text?.muted ?? base.text.muted,
      feedback: {
        warning: { base: overrides.text?.feedback?.warning?.base ?? base.text.feedback.warning.base },
        info: { base: overrides.text?.feedback?.info?.base ?? base.text.feedback.info.base },
      },
    },
    background: {
      base: overrides.background?.base ?? base.background.base,
      raised: {
        base: overrides.background?.raised?.base ?? base.background.raised.base,
        high: overrides.background?.raised?.high ?? base.background.raised.high,
      },
    },
  }
}
