import { plugin as registerBunPlugin } from "bun"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import solid from "@opentui/solid/bun-plugin"
import { createSignal } from "solid-js"

registerBunPlugin(solid)
import { formatClock } from "../src/core"
import { DEFAULT_SETTINGS, PANEL_NAME, type PanelSettings } from "../src/panel-data"
import { openStatsDb, recordPrompt, recordStep, upsertSession } from "../src/stats/db"
import { resolveDbPath } from "../src/stats/paths"

registerBunPlugin(solid)

// Isolate the stats database: the plugin resolves its path on first use, so
// the escape hatch must be set before any harness reads the line.
const stateDir = mkdtempSync(join(tmpdir(), "usage-insights-"))
process.env.OPENCODE_USAGE_INSIGHTS_DB = join(stateDir, "stats.db")

const mod = await import("../src/tui.tsx")

const at = (seconds: number) => 1_800_000_000_000 + seconds * 1_000

type RuntimeModel = { providerID: string; id: string; variant?: string }
type RuntimeTokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
type RuntimeMessage = {
  id: string
  type: string
  time?: { created?: number; streamed?: number; completed?: number }
  model?: RuntimeModel
  tokens?: RuntimeTokens
  cost?: number
  finish?: string | null
}
type SessionSeed = { id: string; created: number; tokens?: RuntimeTokens; cost?: number; messages?: RuntimeMessage[] }

type SlotClaim = { append?: string; prepend?: string; render: (input: never) => unknown }
type KeymapCommand = {
  id: string
  title: string
  description?: string
  bind?: boolean | string
  palette?: boolean
  slash?: { name: string; aliases?: string[]; arguments?: boolean }
  run: (input?: string) => void
}
type KeymapLayer = { mode?: string; commands?: KeymapCommand[] }

function createHarness(
  config: { options?: Record<string, unknown>; sessions?: SessionSeed[]; panelOpens?: boolean; confirm?: boolean } = {},
) {
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
    theme: {
      text: {
        base: RGBA.fromInts(220, 220, 220, 255),
        muted: RGBA.fromInts(120, 120, 120, 255),
        feedback: {
          warning: { base: RGBA.fromInts(255, 200, 0, 255), muted: RGBA.fromInts(180, 140, 0, 255) },
          info: { base: RGBA.fromInts(80, 160, 255, 255), muted: RGBA.fromInts(60, 120, 200, 255) },
        },
      },
      background: {
        base: RGBA.fromInts(20, 20, 20, 255),
        raised: {
          base: RGBA.fromInts(40, 40, 40, 255),
          high: RGBA.fromInts(50, 50, 50, 255),
          max: RGBA.fromInts(60, 60, 60, 255),
        },
      },
    },
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

  const cleanup = mod.default.setup(ctx as never) as unknown as (() => void) | undefined

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
    command: (id: string) => commands.find((entry) => entry.id === id),
    claim: (path: string) => claims.find((entry) => (entry.append ?? entry.prepend) === path),
    setMessages: (sessionID: string, next: RuntimeMessage[]) => messageSignals.get(sessionID)?.[1](next),
    setStatus: (sessionID: string, next: "idle" | "running") => statusSignals.get(sessionID)?.[1](next),
    lineText: (sessionID: string) => mod.__test.lineText!(sessionID),
    state: () => mod.__test.state!(),
    emit: (type: string, payload?: unknown) => {
      for (const entry of events) {
        if (entry.live && entry.type === type) entry.handler({ type, data: payload })
      }
    },
  }
}

const cleanups: Array<() => void> = []

function init(config: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(config)
  if (harness.cleanup !== undefined) cleanups.push(harness.cleanup)
  return harness
}

afterAll(() => {
  for (const cleanup of cleanups) cleanup()
  delete process.env.OPENCODE_USAGE_INSIGHTS_DB
  rmSync(stateDir, { recursive: true, force: true })
})

const MODEL: RuntimeModel = { providerID: "opencode", id: "deepseek-v4.1-flash-free" }

function turn(messageID: string, overrides: { model?: RuntimeModel; tokens?: RuntimeTokens; completedAt?: number } = {}): RuntimeMessage[] {
  return [
    { id: `prt_${messageID}`, type: "user", time: { created: at(200) } },
    {
      id: messageID,
      type: "assistant",
      time: { created: at(201), streamed: at(202), completed: overrides.completedAt ?? at(205) },
      model: overrides.model ?? MODEL,
      tokens: overrides.tokens ?? { input: 1_000, output: 50, reasoning: 0, cache: { read: 1_534_000, write: 0 } },
      cost: 0.02,
    },
  ]
}

const FIRST_TURN: RuntimeMessage[] = [
  { id: "prt_msg_1", type: "user", time: { created: at(0) } },
  {
    id: "msg_1",
    type: "assistant",
    time: { created: at(1), streamed: at(2), completed: at(11) },
    model: MODEL,
    tokens: { input: 84_200, output: 3_700, reasoning: 0, cache: { read: 1_530_000, write: 12_000 } },
    cost: 0.12,
  },
]

function session(overrides: Partial<SessionSeed> & { id: string }): SessionSeed {
  return {
    created: at(0),
    tokens: { input: 120_000, output: 5_000, reasoning: 0, cache: { read: 2_000_000, write: 12_000 } },
    cost: 0.5,
    messages: [...FIRST_TURN, ...turn("msg_2")],
    ...overrides,
  }
}

/** A third turn with numbers that cannot be confused with the seeded two. */
const NEWEST_TURN: RuntimeMessage[] = [
  { id: "prt_msg_3", type: "user", time: { created: at(400) } },
  {
    id: "msg_3",
    type: "assistant",
    time: { created: at(401), streamed: at(402), completed: at(410) },
    model: MODEL,
    tokens: { input: 2_000, output: 60, reasoning: 0, cache: { read: 1_540_000, write: 0 } },
    cost: 0.03,
  },
]

/** A turn whose response has not settled yet: no completion, no final tokens. */
const LIVE_TURN: RuntimeMessage[] = [
  { id: "prt_live", type: "user", time: { created: at(400) } },
  {
    id: "msg_live",
    type: "assistant",
    time: { created: at(401), streamed: at(402) },
    model: MODEL,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
]

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Diagnostic: the renderable tree mounted by a render, with its text content. */
function treeText(setup: unknown, depth = 0): string {
  const root = (setup as { renderer: { root?: Record<string, unknown> } }).renderer.root
  if (root === undefined) return ""
  const read = (node: Record<string, unknown>, level: number): string => {
    if (level > 6) return ""
    let text = ""
    const content = node.content
    if (typeof content === "string") text += content
    else if (content !== null && typeof content === "object" && Array.isArray((content as { chunks?: unknown[] }).chunks)) {
      text += (content as { chunks: { text?: string }[] }).chunks.map((chunk) => chunk.text ?? "").join("")
    }
    // A text renderable that was filled through its `content` property ignores
    // its children; everything else is composed of them.
    if (node._hasManualStyledText !== true) {
      for (const child of ((node.getChildren as (() => Record<string, unknown>[]) | undefined)?.() ?? [])) text += read(child, level + 1)
      const textChildren = (node.getTextChildren as (() => Record<string, unknown>[]) | undefined)?.()
      if (Array.isArray(textChildren) && textChildren.length > 0) {
        for (const child of textChildren) text += read(child, level + 1)
      } else {
        const own = node.children
        if (Array.isArray(own)) {
          for (const child of own) text += typeof child === "string" ? child : read(child as Record<string, unknown>, level + 1)
        }
      }
    }
    return text
  }
  void depth
  return read(root, depth)
}

describe("module shape", () => {
  test("exports a TUI plugin definition", () => {
    expect(mod.default.id).toBe("usage-insights")
    expect(typeof mod.default.setup).toBe("function")
  })
})

describe("slots", () => {
  test("appends a line above the composer and claims the session panel", () => {
    const harness = init({ sessions: [session({ id: "ses_slots" })] })
    expect(harness.claim("session.composer.top")).toBeDefined()
    expect(harness.claim("session.panel")).toBeDefined()
  })

  test("the panel slot only renders for its own name", () => {
    // The matching name is covered by the rendering test below, which needs a
    // live renderer; a foreign name must stay inert without one.
    const harness = init({ sessions: [session({ id: "ses_panel_name" })] })
    const claim = harness.claim("session.panel")!
    const input = { name: "someone-else", sessionID: "ses_panel_name", width: 100, presentation: "panel", focused: false }
    expect(claim.render(input as never)).toBeNull()
  })

  test("cleanup releases every slot and subscription", () => {
    const harness = init({ sessions: [session({ id: "ses_cleanup" })] })
    // The line, the panel and the sidebar history.
    expect(harness.claims).toHaveLength(3)
    expect(harness.events.length).toBeGreaterThan(0)
    harness.cleanup!()
    expect(harness.claims).toHaveLength(0)
    expect(harness.events.every((entry) => !entry.live)).toBe(true)
  })
})

describe("telemetry line", () => {
  test("reports end time, gap, provider, turn and session totals", () => {
    const harness = init({ sessions: [session({ id: "ses_line" })] })
    expect(harness.lineText("ses_line")).toBe(
      `${formatClock(at(205))} · Δ 3m20s · opencode/deepseek-v4.1-flash-free · in 1k (1.53M), cached 1.53M, out 50 · sess in 132k (2.13M), cached 2M, out 5k`,
    )
    expect(harness.state()).toEqual({ view: "overview", range: "all" })
  })

  test("has no line before the first response and after cleanup", () => {
    const harness = init({ sessions: [session({ id: "ses_idle", messages: [{ id: "prt_1", type: "user", time: { created: at(0) } }] })] })
    expect(harness.lineText("ses_idle")).toBe("")
    expect(harness.lineText("ses_missing")).toBe("")
  })

  test("flags a provider change since the previous prompt", () => {
    const harness = init({
      sessions: [session({ id: "ses_provider", messages: [...FIRST_TURN, ...turn("msg_2", { model: { providerID: "anthropic", id: "claude-opus-4.6" } })] })],
    })
    expect(harness.lineText("ses_provider")).toContain("anthropic/claude-opus-4.6 · changed")
  })

  test("warns about a lost prompt cache", () => {
    const harness = init({
      sessions: [
        session({
          id: "ses_cache",
          messages: [...FIRST_TURN, ...turn("msg_2", { tokens: { input: 12_700, output: 50, reasoning: 0, cache: { read: 1_518_300, write: 0 } } })],
        }),
      ],
    })
    expect(harness.lineText("ses_cache")).toContain("⚠ cache expired (−11.7k)")
  })

  test("honours field and label options", () => {
    const harness = init({
      options: { fields: { clock: false, delta: false, session: false }, labels: { turn: "step" } },
      sessions: [session({ id: "ses_options" })],
    })
    expect(harness.lineText("ses_options")).toBe("opencode/deepseek-v4.1-flash-free · step in 1k (1.53M), cached 1.53M, out 50")
  })

  test("never shows a reported operator on the line", () => {
    const db = openStatsDb(resolveDbPath())
    upsertSession(db, { sessionID: "ses_upstream", startedAt: at(0) })
    recordStep(db, { messageID: "msg_1", sessionID: "ses_upstream", providerID: MODEL.providerID, modelID: MODEL.id, input: 100, output: 10 })
    db.close()

    const harness = init({ sessions: [session({ id: "ses_upstream" })] })
    expect(harness.lineText("ses_upstream")).not.toContain("via")
  })

  test("keeps the message list out of the path of a running turn", async () => {
    const harness = init({ sessions: [session({ id: "ses_deltas" })] })
    const claim = harness.claim("session.composer.top")!
    const setup = await testRender(() => claim.render({ sessionID: "ses_deltas" } as never) as never, { width: 140, height: 4 })
    try {
      await setup.renderOnce()
      // The host publishes the message list as a store, so the line is
      // recomputed on every streamed delta; while the turn runs it must not
      // read the messages at all.
      harness.setStatus("ses_deltas", "running")
      await setup.renderOnce()
      const before = harness.listReads()
      for (let index = 0; index < 20; index += 1) {
        harness.setMessages("ses_deltas", [
          ...(session({ id: "ses_deltas" }).messages ?? []),
          { id: `live_${index}`, type: "assistant", time: { created: at(600 + index) }, model: MODEL, tokens: { input: 1, output: index } },
        ])
        await setup.renderOnce()
      }
      expect(harness.listReads()).toBe(before)
    } finally {
      await setup.dispose()
    }
  })

  test("drops its cached upstream lookup when a step ends", () => {
    const harness = init({ sessions: [session({ id: "ses_upstream_events" })] })
    expect(harness.lineText("ses_upstream_events")).not.toContain("via")
    harness.emit("session.step.ended")
    expect(harness.lineText("ses_upstream_events")).not.toContain("via")
  })

  test("renders nothing when disabled", () => {
    const harness = init({ options: { enabled: false }, sessions: [session({ id: "ses_disabled" })] })
    expect(harness.claims).toHaveLength(0)
    expect(harness.commands).toHaveLength(0)
    expect(harness.cleanup).toBeUndefined()
  })
})

describe("stats command", () => {
  test("registers a slash command without stealing a key binding", () => {
    const harness = init({ sessions: [session({ id: "ses_command" })] })
    const command = harness.command("usage-insights.stats")!
    expect(command).toBeDefined()
    expect(command.bind).toBe(false)
    expect(command.palette).toBe(true)
    expect(command.slash).toEqual({ name: "usage", aliases: ["insights"], arguments: true })
  })

  test("registers its layer as global so /usage is reachable", () => {
    // Without `mode: "global"` the host pins the layer to the default `base`
    // input mode, where its slash and palette commands are never reachable:
    // `/usage` was invisible in the prompt completion and the command palette.
    const harness = init({ sessions: [session({ id: "ses_command_mode" })] })
    expect(harness.layers).toHaveLength(1)
    expect(harness.layers[0]?.mode).toBe("global")
  })

  test("switches the view and range from the arguments and opens the panel", () => {
    const harness = init({ sessions: [session({ id: "ses_command_args" })] })
    const command = harness.command("usage-insights.stats")!
    command.run("models 7d")
    expect(harness.opened).toEqual([PANEL_NAME])
    expect(harness.state()).toEqual({ view: "models", range: "7d" })
    command.run("bogus")
    expect(harness.state()).toEqual({ view: "models", range: "7d" })
    expect(harness.toasts).toHaveLength(0)
  })

  test("toggles the panel closed when /usage runs again with no arguments", () => {
    const harness = init({ sessions: [session({ id: "ses_command_toggle" })] })
    const command = harness.command("usage-insights.stats")!
    command.run(undefined)
    expect(harness.panel()?.name).toBe(PANEL_NAME)
    expect(harness.opened).toEqual([PANEL_NAME])
    // A slash command declared with `arguments: true` receives its raw input,
    // command token included.
    command.run("/usage")
    expect(harness.panel()).toBeUndefined()
    // Running it again reopens the panel.
    command.run(undefined)
    expect(harness.opened).toEqual([PANEL_NAME, PANEL_NAME])
  })

  test("arguments keep the panel open", () => {
    const harness = init({ sessions: [session({ id: "ses_command_keep" })] })
    const command = harness.command("usage-insights.stats")!
    command.run("/usage models")
    command.run("/usage cache 7d")
    // Unknown tokens are ignored, not treated as "close".
    command.run("/usage bogus")
    expect(harness.panel()?.name).toBe(PANEL_NAME)
    expect(harness.state()).toEqual({ view: "cache", range: "7d" })
  })

  test("the panel can be turned off without losing the line or the sidebar", () => {
    const harness = init({ options: { panel: false }, sessions: [session({ id: "ses_no_panel" })] })
    expect(harness.claim("session.panel")).toBeUndefined()
    expect(harness.claim("session.composer.top")).toBeDefined()
    expect(harness.claim("sidebar.content")).toBeDefined()
    expect(harness.commands).toHaveLength(0)
  })

  test("explains itself when no session is open", () => {
    const harness = init({ sessions: [session({ id: "ses_command_none" })], panelOpens: false })
    harness.command("usage-insights.stats")!.run(undefined)
    expect(harness.toasts).toEqual([{ message: "Open a session first, then run /usage", variant: "warning" }])
  })
})

describe("rendering", () => {
  test("draws the telemetry line", async () => {
    const harness = init({ sessions: [session({ id: "ses_render_line" })] })
    const claim = harness.claim("session.composer.top")!
    const setup = await testRender(() => claim.render({ sessionID: "ses_render_line" } as never) as never, { width: 140, height: 4 })
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("Δ 3m20s")
      expect(frame).toContain("opencode/deepseek-v4.1-flash-free")
      expect(frame).toContain("in 1k (1.53M), cached 1.53M, out 50")
    } finally {
      await setup.dispose()
    }
  })

  // Regression: a StyledText passed as a child of <text> is appended as chunks
  // that are never removed, so the line grew one full copy per reactive update.
  // The renderable tree must always hold exactly one line.
  test("replaces the line on update instead of appending a copy", async () => {
    const harness = init({ sessions: [session({ id: "ses_render_update" })] })
    const claim = harness.claim("session.composer.top")!
    const setup = await testRender(() => claim.render({ sessionID: "ses_render_update" } as never) as never, { width: 140, height: 8 })
    try {
      await setup.renderOnce()
      const before = treeText(setup)
      expect(countOccurrences(before, MODEL.id)).toBe(1)
      expect(before).toContain("in 1k (1.53M), cached 1.53M, out 50")

      harness.setMessages("ses_render_update", [...FIRST_TURN, ...turn("msg_2"), ...NEWEST_TURN])
      await setup.renderOnce()
      const after = treeText(setup)
      expect(countOccurrences(after, MODEL.id)).toBe(1)
      expect(after).toContain("in 2k (1.54M), cached 1.54M, out 60")
      expect(after).not.toContain("in 1k (1.53M)")
    } finally {
      await setup.dispose()
    }
  })

  test("leads with the routing endpoint the recorder learned, and warns when it changed", async () => {
    const db = openStatsDb(resolveDbPath())
    recordStep(db, {
      messageID: "prev_step",
      sessionID: "ses_render_router",
      providerID: MODEL.providerID,
      modelID: MODEL.id,
      createdAt: at(100),
      completedAt: at(105),
      router: "router-a",
      recordedAt: at(100),
    })
    recordStep(db, {
      messageID: "current_step",
      sessionID: "ses_render_router",
      providerID: MODEL.providerID,
      modelID: MODEL.id,
      createdAt: at(210),
      completedAt: at(215),
      router: "router-b",
      recordedAt: at(210),
    })
    db.close()

    const harness = init({ sessions: [session({ id: "ses_render_router" })] })
    const claim = harness.claim("session.composer.top")!
    const setup = await testRender(() => claim.render({ sessionID: "ses_render_router" } as never) as never, { width: 140, height: 8 })
    try {
      await setup.renderOnce()
      const text = treeText(setup)
      expect(countOccurrences(text, "router-b")).toBe(1)
      expect(text).toContain("changed")
      // The endpoint replaces the provider/model identity on the line.
      expect(text).not.toContain(MODEL.id)
    } finally {
      await setup.dispose()
    }
  })

  test("hides the line while the session is running a turn", async () => {
    const harness = init({ sessions: [session({ id: "ses_render_running" })] })
    const claim = harness.claim("session.composer.top")!
    const setup = await testRender(() => claim.render({ sessionID: "ses_render_running" } as never) as never, { width: 140, height: 8 })
    try {
      await setup.renderOnce()
      expect(treeText(setup)).toContain(MODEL.id)

      harness.setStatus("ses_render_running", "running")
      await setup.renderOnce()
      expect(treeText(setup)).not.toContain(MODEL.id)

      harness.setStatus("ses_render_running", "idle")
      await setup.renderOnce()
      expect(countOccurrences(treeText(setup), MODEL.id)).toBe(1)
    } finally {
      await setup.dispose()
    }
  })

  test("hides the line while the newest turn is still streaming", async () => {
    const harness = init({ sessions: [session({ id: "ses_render_live" })] })
    const claim = harness.claim("session.composer.top")!
    const setup = await testRender(() => claim.render({ sessionID: "ses_render_live" } as never) as never, { width: 140, height: 8 })
    try {
      await setup.renderOnce()
      expect(treeText(setup)).toContain(MODEL.id)

      harness.setMessages("ses_render_live", [...FIRST_TURN, ...turn("msg_2"), ...LIVE_TURN])
      await setup.renderOnce()
      const streaming = treeText(setup)
      expect(streaming).not.toContain(MODEL.id)
      expect(streaming).not.toContain("cache expired")

      const settled = LIVE_TURN.map((message, index) =>
        index === 0
          ? message
          : {
              ...message,
              time: { created: at(401), streamed: at(402), completed: at(410) },
              tokens: { input: 500, output: 20, reasoning: 0, cache: { read: 1_540_000, write: 0 } },
            },
      )
      harness.setMessages("ses_render_live", [...FIRST_TURN, ...turn("msg_2"), ...settled])
      await setup.renderOnce()
      const frame = treeText(setup)
      expect(countOccurrences(frame, MODEL.id)).toBe(1)
      expect(frame).toContain("in 500 (1.54M), cached 1.54M, out 20")
    } finally {
      await setup.dispose()
    }
  })

  test("draws the stats panel from the database", async () => {
    const db = openStatsDb(resolveDbPath())
    upsertSession(db, { sessionID: "ses_render_panel", startedAt: at(0), title: "Panel session" })
    recordPrompt(db, { sessionID: "ses_render_panel", messageID: "prt_panel", createdAt: at(0) })
    recordStep(db, {
      messageID: "msg_panel",
      sessionID: "ses_render_panel",
      providerID: MODEL.providerID,
      modelID: MODEL.id,
      input: 1_234_567,
      cacheRead: 7_654_321,
      output: 4_200,
      cost: 1.5,
      createdAt: at(1),
      completedAt: at(5),
    })
    db.close()

    const harness = init({ sessions: [session({ id: "ses_render_panel" })] })
    const claim = harness.claim("session.panel")!
    const input = { name: PANEL_NAME, sessionID: "ses_render_panel", width: 110, presentation: "panel", focused: false }
    const setup = await testRender(() => claim.render(input as never) as never, { width: 120, height: 40 })
    try {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      expect(frame).toContain("usage insights")
      expect(frame).toContain("all time")
      expect(frame).toContain("cached")
      expect(frame).toContain("[1 overview]")
      expect(frame).toContain("? help")
    } finally {
      await setup.dispose()
    }
  })

  test("closes the panel with escape and toggles full screen with f", async () => {
    const harness = init({ sessions: [session({ id: "ses_panel_keys" })] })
    const claim = harness.claim("session.panel")!
    const closed: string[] = []
    const fullscreen: string[] = []
    const input = {
      name: PANEL_NAME,
      sessionID: "ses_panel_keys",
      width: 110,
      presentation: "panel",
      focused: false,
      close: () => {
        closed.push("close")
      },
      toggleFullscreen: () => {
        fullscreen.push("fullscreen")
      },
    }
    const setup = await testRender(() => claim.render(input as never) as never, { width: 120, height: 30 })
    try {
      await setup.renderOnce()
      const close = harness.command("usage-insights.close")!
      const toggle = harness.command("usage-insights.fullscreen")!
      expect(close.bind).toBe("escape")
      expect(toggle.bind).toBe("f")
      close.run()
      toggle.run()
      expect(closed).toHaveLength(1)
      expect(fullscreen).toHaveLength(1)
    } finally {
      await setup.dispose()
    }
  })

  test("updates the panel in place when the view changes", async () => {
    const harness = init({ sessions: [session({ id: "ses_render_panel_view" })] })
    const claim = harness.claim("session.panel")!
    const input = { name: PANEL_NAME, sessionID: "ses_render_panel_view", width: 110, presentation: "panel", focused: false }
    const setup = await testRender(() => claim.render(input as never) as never, { width: 120, height: 40 })
    try {
      await setup.renderOnce()
      expect(countOccurrences(treeText(setup), "usage insights")).toBe(1)

      harness.command("usage-insights.stats")!.run("models 30d")
      await setup.renderOnce()
      const text = treeText(setup)
      expect(countOccurrences(text, "usage insights")).toBe(1)
      expect(text).toContain("[2 models]")
      expect(text).toContain("30 days")
    } finally {
      await setup.dispose()
    }
  })
})

describe("the db view's maintenance", () => {
  /** One step old enough to be prunable, one step that is not. */
  function seedOldAndNew(): void {
    const old = Date.now() - 400 * 24 * 60 * 60 * 1000
    const db = openStatsDb(resolveDbPath())
    upsertSession(db, { sessionID: "ses_panel_prune", startedAt: old, title: "Old session" })
    recordStep(db, { messageID: "msg_old", sessionID: "ses_panel_prune", input: 10, createdAt: old, recordedAt: old })
    recordStep(db, { messageID: "msg_new", sessionID: "ses_panel_prune", input: 20, createdAt: Date.now(), recordedAt: Date.now() })
    db.close()
  }

  function stepIDs(): string[] {
    const db = openStatsDb(resolveDbPath())
    const ids = (db.query("SELECT message_id FROM steps WHERE session_id = 'ses_panel_prune' ORDER BY message_id").all() as { message_id: string }[]).map(
      (row) => row.message_id,
    )
    db.close()
    return ids
  }

  async function openDbView(sessionID: string) {
    const harness = init({ sessions: [session({ id: sessionID })], confirm: true })
    harness.command("usage-insights.stats")!.run("db")
    const claim = harness.claim("session.panel")!
    const input = { name: PANEL_NAME, sessionID, width: 110, presentation: "panel", focused: false }
    const setup = await testRender(() => claim.render(input as never) as never, { width: 120, height: 30 })
    await setup.renderOnce()
    return { harness, setup }
  }

  test("prunes the retention the user picks, after asking", async () => {
    seedOldAndNew()
    const { harness, setup } = await openDbView("ses_panel_prune")
    try {
      // The cursor starts on the first retention the db view offers (30 days).
      harness.command("usage-insights.drill")!.run()
      await Bun.sleep(1)
      expect(harness.dialogs).toHaveLength(1)
      expect(harness.dialogs[0]!.title).toBe("Prune older than 30 days")
      expect(harness.dialogs[0]!.message).toContain("would be deleted")
      expect(harness.toasts[0]?.message).toContain("pruned 1 steps")
      expect(stepIDs()).toEqual(["msg_new"])
    } finally {
      await setup.dispose()
    }
  })

  test("refuses to touch the file while the session is running", async () => {
    seedOldAndNew()
    const { harness, setup } = await openDbView("ses_panel_prune")
    try {
      harness.setStatus("ses_panel_prune", "running")
      harness.command("usage-insights.drill")!.run()
      await Bun.sleep(1)
      // Not even offered: the recorder writes on the agent's event path, so a
      // prune that holds the write lock would make the agent wait.
      expect(harness.dialogs).toHaveLength(0)
      expect(harness.toasts).toEqual([{ message: "the session is running: prune again when it is idle", variant: "warning" }])
      expect(stepIDs()).toEqual(["msg_new", "msg_old"])
    } finally {
      await setup.dispose()
    }
  })

  test("declining the confirmation keeps the history", async () => {
    seedOldAndNew()
    const harness = init({ sessions: [session({ id: "ses_panel_prune" })], confirm: false })
    harness.command("usage-insights.stats")!.run("db")
    const claim = harness.claim("session.panel")!
    const input = { name: PANEL_NAME, sessionID: "ses_panel_prune", width: 110, presentation: "panel", focused: false }
    const setup = await testRender(() => claim.render(input as never) as never, { width: 120, height: 30 })
    try {
      await setup.renderOnce()
      harness.command("usage-insights.drill")!.run()
      await Bun.sleep(1)
      expect(harness.dialogs).toHaveLength(1)
      expect(harness.toasts).toHaveLength(0)
      expect(stepIDs()).toEqual(["msg_new", "msg_old"])
    } finally {
      await setup.dispose()
    }
  })
})

describe("history", () => {
  function seedHistory(): void {
    const db = openStatsDb(resolveDbPath())
    recordPrompt(db, { sessionID: "ses_history", messageID: "prt_h1", createdAt: at(10) })
    recordStep(db, {
      messageID: "msg_h1",
      sessionID: "ses_history",
      providerID: MODEL.providerID,
      modelID: MODEL.id,
      createdAt: at(11),
      completedAt: at(20),
      finish: "stop",
      input: 1_617,
      cacheRead: 425_728,
      output: 434,
      reasoning: 631,
      router: "orcarouter-dsv4.1flash",
      recordedAt: at(20),
    })
    db.close()
  }

  test("registers the sidebar history and renders the finished turns", async () => {
    seedHistory()
    const harness = init({ sessions: [session({ id: "ses_history" })] })
    const claim = harness.claim("sidebar.content")!
    expect(claim).toBeDefined()
    const setup = await testRender(() => claim.render({ sessionID: "ses_history" } as never) as never, { width: 60, height: 12 })
    try {
      await setup.renderOnce()
      const text = treeText(setup)
      // The accumulated session usage comes first, then the per-turn history.
      expect(text).toContain("session")
      expect(text).toContain("1 step")
      expect(text).toContain("hit")
      expect(text).toContain("turns")
      expect(text).toContain("orcarouter-dsv4.1flash")
      // The cost of the turn is on its line; the prompt in parentheses gives way.
      expect(text).toContain("in 1.62k · out 1.06k")
    } finally {
      await setup.dispose()
    }
  })

  test("the sidebar can be turned off", () => {
    const harness = init({ sessions: [session({ id: "ses_history_off" })], options: { sidebar: false } })
    const claim = harness.claim("sidebar.content")!
    expect(claim.render({ sessionID: "ses_history_off" } as never)).toBeNull()
  })

  test("the /usage turns view renders the per-prompt history", async () => {
    seedHistory()
    const harness = init({ sessions: [session({ id: "ses_history" })] })
    const claim = harness.claim("session.panel")!
    const input = { name: PANEL_NAME, sessionID: "ses_history", width: 120, presentation: "panel", focused: false }
    const setup = await testRender(() => claim.render(input as never) as never, { width: 140, height: 30 })
    try {
      harness.command("usage-insights.stats")!.run("turns")
      await setup.renderOnce()
      const text = treeText(setup)
      expect(text).toContain("[9 turns]")
      expect(text).toContain("orcarouter-dsv4.1flash · in 1.62k (427.3k), cached 425.7k, out 1.06k")
    } finally {
      await setup.dispose()
    }
  })
})
