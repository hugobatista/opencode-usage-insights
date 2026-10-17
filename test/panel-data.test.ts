import { describe, expect, test } from "bun:test"
import { formatClock } from "../src/core"
import type { TurnUsage } from "../src/stats/queries"
import {
  count,
  PANEL_NAME,
  PANEL_VIEWS,
  RANGE_KEYS,
  cacheLines,
  formatCount,
  formatGap,
  formatMs,
  formatPercent,
  formatTableRow,
  formatTps,
  kvGrid,
  latencyLines,
  modelsLines,
  overviewLines,
  padCell,
  parseArgs,
  rangeFor,
  rangeLabel,
  sessionsLines,
  sidebarLines,
  truncate,
  turnsLines,
  type PanelLine,
} from "../src/panel-data"
import type { CacheDropRow, LatencyReport, ModelUsage, Overview, SessionUsage, TtlEvidenceRow } from "../src/stats/queries"

const text = (lines: readonly PanelLine[]) => lines.map((line) => line.text).join("\n")
const find = (lines: readonly PanelLine[], needle: string) => lines.find((line) => line.text.includes(needle))

function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    steps: 3,
    input: 12_000,
    cached: 340_000,
    cacheWrite: 5_000,
    output: 900,
    reasoning: 0,
    cost: 0.42,
    sessions: 2,
    prompts: 4,
    firstAt: undefined,
    lastAt: undefined,
    cacheHitRatio: 340_000 / 352_000,
    ...overrides,
  }
}

function model(overrides: Partial<ModelUsage> & { modelID: string }): ModelUsage {
  return {
    variant: undefined,
    providers: [
      {
        providerID: "opencode",
        upstreams: [], upstreamModels: [], routers: [],
        steps: 4,
        input: 12_000,
        cached: 340_000,
        cacheWrite: 5_000,
        output: 900,
        reasoning: 0,
        cost: 0.42,
        firstAt: undefined,
        lastAt: undefined,
      },
    ],
    totals: { steps: 4, input: 12_000, cached: 340_000, cacheWrite: 5_000, output: 900, reasoning: 0, cost: 0.42 },
    ...overrides,
  }
}

function drop(overrides: Partial<CacheDropRow> = {}): CacheDropRow {
  return {
    sessionID: "ses_1",
    messageID: "msg_1",
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash-free",
    variant: undefined,
    at: 1_800_000_000_000,
    tokens: 11_700,
    gapMs: 1_200_000,
    prevCached: 1_530_000,
    reason: "expired",
    ...overrides,
  }
}

function latency(overrides: Partial<LatencyReport> = {}): LatencyReport {
  return {
    wall: { count: 12, p50: 4_200, p90: 9_800, p99: 21_000 },
    stream: { count: 12, p50: 700, p90: 1_400, p99: 2_900 },
    tps: { count: 12, p50: 42.5, p90: 61.2, p99: 88.75 },
    ...overrides,
  }
}

describe("parseArgs", () => {
  test("accepts a view, a range, or both in any order", () => {
    expect(parseArgs(undefined)).toEqual({})
    expect(parseArgs("   ")).toEqual({})
    expect(parseArgs("models")).toEqual({ view: "models" })
    expect(parseArgs("7d")).toEqual({ range: "7d" })
    expect(parseArgs("models 7d")).toEqual({ view: "models", range: "7d" })
    expect(parseArgs("today sessions")).toEqual({ view: "sessions", range: "today" })
  })

  test("is case-insensitive, ignores unknown tokens and keeps the last match", () => {
    expect(parseArgs("MODELS")).toEqual({ view: "models" })
    expect(parseArgs("models bogus 30d")).toEqual({ view: "models", range: "30d" })
    expect(parseArgs("overview latency")).toEqual({ view: "latency" })
    expect(parseArgs("all")).toEqual({ range: "all" })
  })

  test("exposes the view and range catalogue", () => {
    expect(PANEL_NAME).toBe("usage-insights")
    expect(PANEL_VIEWS).toContain("overview")
    expect(RANGE_KEYS).toEqual(["session", "today", "7d", "30d", "all"])
  })
})

describe("rangeFor", () => {
  const now = new Date(2026, 6, 15, 14, 30, 30).getTime()

  test("all time has no bounds", () => {
    expect(rangeFor("all", now)).toBeUndefined()
  })

  test("relative ranges count back from now", () => {
    expect(rangeFor("7d", now)).toEqual({ from: now - 7 * 24 * 60 * 60 * 1000 })
    expect(rangeFor("30d", now)).toEqual({ from: now - 30 * 24 * 60 * 60 * 1000 })
  })

  test("today starts at local midnight", () => {
    const range = rangeFor("today", now)!
    const from = new Date(range.from!)
    expect(from.getHours()).toBe(0)
    expect(from.getMinutes()).toBe(0)
    expect(from.getSeconds()).toBe(0)
    expect(range.from! <= now).toBe(true)
  })

  test("the session range needs a session start", () => {
    expect(rangeFor("session", now)).toBeUndefined()
    expect(rangeFor("session", now, 1_799_000_000_000)).toEqual({ from: 1_799_000_000_000 })
  })

  test("labels every range", () => {
    expect(rangeLabel("session")).toBe("this session")
    expect(rangeLabel("today")).toBe("today")
    expect(rangeLabel("7d")).toBe("7 days")
    expect(rangeLabel("30d")).toBe("30 days")
    expect(rangeLabel("all")).toBe("all time")
  })
})

describe("formatting helpers", () => {
  test("percent, count, milliseconds, throughput and gaps", () => {
    expect(formatPercent(0.875)).toBe("87.5%")
    expect(formatPercent(undefined)).toBe("–")
    expect(formatCount(1_234_567)).toBe("1,234,567")
    expect(formatMs(250)).toBe("250ms")
    expect(formatMs(1_500)).toBe("1.5s")
    expect(formatMs(90_000)).toBe("1m30s")
    expect(formatMs(undefined)).toBe("–")
    expect(formatTps(42.54)).toBe("42.5/s")
    expect(formatTps(undefined)).toBe("–")
    expect(formatGap(5_000)).toBe("5s")
    expect(formatGap(120_000)).toBe("2m")
    expect(formatGap(7_200_000)).toBe("2.0h")
    expect(formatGap(172_800_000)).toBe("2.0d")
    expect(formatGap(undefined)).toBe("–")
  })

  test("counts read as prose", () => {
    expect(count(1, "step")).toBe("1 step")
    expect(count(3, "step")).toBe("3 steps")
    expect(count(1_234, "prompt")).toBe("1,234 prompts")
    expect(count(1, "more model")).toBe("1 more model")
    expect(count(2, "more model")).toBe("2 more models")
  })

  test("truncate and padCell respect the panel width", () => {
    expect(truncate("exact", 5)).toBe("exact")
    expect(truncate("too long", 5)).toBe("too…")
    expect(truncate("anything", 1)).toBe("")
    expect(padCell("ab", 4)).toBe("ab  ")
    expect(padCell("ab", 4, "right")).toBe("  ab")
    expect(padCell("abcdef", 4)).toBe("abcdef")
  })

  test("formatTableRow truncates, pads and aligns cells", () => {
    expect(formatTableRow(["model", "steps"], [6, 5], ["left", "right"])).toBe(`${padCell("model", 6)} ${padCell("steps", 5, "right")}`)
    expect(formatTableRow(["a very long model", "1"], [6, 5], ["left", "right"])).toBe(`${padCell(truncate("a very long model", 6), 6)} ${padCell("1", 5, "right")}`)
    expect(formatTableRow(["x"], [])).toBe(padCell("x", 8))
  })

  test("kvGrid pairs columns when they fit and stacks them when they do not", () => {
    const wide = kvGrid(
      [
        ["steps", "3"],
        ["cached", "340k"],
        ["input", "12k"],
        ["output", "900"],
      ],
      100,
    )
    expect(wide).toHaveLength(2)
    expect(wide[0]!.text).toBe(`${padCell("steps", 11)}3${" ".repeat(38)}${padCell("cached", 11)}340k`)
    expect(wide[1]!.text).toContain(`${padCell("input", 11)}12k`)
    expect(wide[1]!.text).toContain(`${padCell("output", 11)}900`)

    const narrow = kvGrid(
      [
        ["steps", "3"],
        ["input", "12k"],
      ],
      24,
    )
    expect(narrow.map((line) => line.text)).toEqual([`${padCell("steps", 11)}3`, `${padCell("input", 11)}12k`])
  })
})

describe("overviewLines", () => {
  test("summarises the range with counts and cached ratio", () => {
    const lines = overviewLines({ usage: overview(), session: undefined, range: "7d" }, 100)
    expect(lines[0]!.text).toBe("7 days · 3 steps · 2 sessions · 4 prompts")
    expect(lines[0]!.tone).toBe("muted")
    expect(text(lines)).toContain(`${padCell("cached", 11)}340k (96.6% hit)`)
    expect(text(lines)).toContain(`${padCell("cost", 11)}$0.42`)
    expect(text(lines)).not.toContain("reasoning")
    expect(text(lines)).not.toContain("this session")
  })

  test("adds reasoning, first/last and a session block when available", () => {
    const lines = overviewLines(
      {
        usage: overview({ reasoning: 2_500, firstAt: 1_799_000_000_000, lastAt: 1_800_000_000_000 }),
        session: overview({ steps: 1, cost: 0.01 }),
        range: "all",
      },
      100,
    )
    const body = text(lines)
    expect(body).toContain(`${padCell("reasoning", 11)}2.5k`)
    expect(body).toContain("first")
    expect(body).toContain("last")
    expect(find(lines, "this session")?.tone).toBe("accent")
    expect(body).toContain(`${padCell("cost", 11)}$0.01`)
  })
})

describe("modelsLines", () => {
  test("lists each provider behind a model, including upstream operators", () => {
    const rows = [
      model({
        modelID: "deepseek-v4.1-flash-free",
        providers: [
          {
            providerID: "opencode",
            upstreams: ["fireworks", "deepseek"], upstreamModels: [], routers: [],
            steps: 4,
            input: 12_000,
            cached: 340_000,
            cacheWrite: 0,
            output: 900,
            reasoning: 0,
            cost: 0.42,
            firstAt: undefined,
            lastAt: undefined,
          },
          {
            providerID: "deepseek",
            upstreams: [], upstreamModels: [], routers: [],
            steps: 1,
            input: 500,
            cached: 0,
            cacheWrite: 0,
            output: 20,
            reasoning: 0,
            cost: 0.01,
            firstAt: undefined,
            lastAt: undefined,
          },
        ],
      }),
    ]
    const lines = modelsLines(rows, 100)
    expect(lines[0]!.text).toContain("model")
    expect(lines[0]!.text).toContain("provider")
    expect(lines[0]!.text).toContain("cost")
    // A long operator list continues on its own line instead of being cut.
    const row = find(lines, "opencode")!
    expect(row.text).toContain("deepseek-v4.1-flash-free")
    expect(row.text).not.toContain("via")
    const continuation = find(lines, "via fireworks, deepseek")!
    expect(continuation.tone).toBe("muted")
    expect(continuation.text).toBe(`${" ".repeat(31)}via fireworks, deepseek`)
    expect(text(lines)).toContain(`${padCell("deepseek", 22)}`)
    expect(text(lines)).toContain("12k")
    expect(text(lines)).toContain("$0.4200")
  })

  test("keeps a short operator list inside the provider cell", () => {
    const rows = [model({ modelID: "glm-5.3-flash", providers: [{ providerID: "opencode", upstreams: ["fireworks"], upstreamModels: [], routers: [], steps: 2, input: 1, cached: 0, cacheWrite: 0, output: 1, reasoning: 0, cost: 0, firstAt: undefined, lastAt: undefined }] })]
    const lines = modelsLines(rows, 100)
    expect(text(lines)).toContain("opencode via fireworks")
    expect(text(lines)).not.toContain("  via fireworks")
  })

  test("shows the upstream model and the routing endpoint the gateway reported", () => {
    const rows = [
      model({
        modelID: "deepseek-v4.1-flash",
        providers: [
          {
            providerID: "opencode",
            upstreams: ["DeepSeek"],
            upstreamModels: ["deepseek/deepseek-v4.1-flash"],
            routers: ["orcarouter-dsv4.1flash"],
            steps: 3,
            input: 1_000,
            cached: 291_584,
            cacheWrite: 0,
            output: 463,
            reasoning: 1_030,
            cost: 0.01,
            firstAt: undefined,
            lastAt: undefined,
          },
        ],
      }),
    ]
    const lines = modelsLines(rows, 130)
    expect(text(lines)).toContain("opencode via DeepSeek")
    expect(text(lines)).toContain("upstream deepseek/deepseek-v4.1-flash · endpoint orcarouter-dsv4.1flash")
  })

  test("drops the cost column on narrow panels and notes hidden models", () => {
    const rows = Array.from({ length: 4 }, (_, index) => model({ modelID: `model-${index}` }))
    const narrow = modelsLines(rows, 60, 2)
    expect(narrow[0]!.text).not.toContain("cost")
    expect(text(narrow)).toContain("… 2 more models")
  })

  test("explains an empty range", () => {
    const lines = modelsLines([], 100)
    expect(lines).toHaveLength(2)
    expect(lines[1]!.text).toBe("no usage recorded for this range")
    expect(lines[1]!.tone).toBe("muted")
  })
})

describe("cacheLines", () => {
  test("groups losses by reason and warns on expired entries", () => {
    const lines = cacheLines(
      {
        drops: [drop(), drop({ reason: "compaction", tokens: 4_000, at: 1_800_000_100_000 }), drop({ reason: "unknown", tokens: 100 })],
        evidence: [{ providerID: "opencode", modelID: "deepseek-v4.1-flash-free", samples: 9, maxHitGapMs: 540_000, minDropGapMs: 1_200_000 }],
      },
      100,
    )
    expect(lines[0]!.text).toBe("reuse losses  3 events · 15.8k tokens")
    expect(lines[0]!.tone).toBe("warning")
    expect(find(lines, "expired")?.text).toBe(`  ${padCell("expired", 11)}1 · 11.7k`)
    expect(find(lines, "expired")?.tone).toBe("warning")
    expect(find(lines, "compaction")?.tone).toBe("muted")
    expect(find(lines, "observed cache TTL bounds")?.tone).toBe("accent")
    expect(text(lines)).toContain("opencode/deepseek-v4.1-flash-free")
    expect(text(lines)).toContain("9m")
    expect(text(lines)).toContain("20m")
    expect(text(lines)).toContain("recent losses")
  })

  test("names a single loss in the singular", () => {
    const lines = cacheLines({ drops: [drop()], evidence: [] }, 100)
    expect(lines[0]!.text).toBe("reuse losses  1 event · 11.7k tokens")
    expect(text(lines)).toContain("recent losses")
  })

  test("says so when the cache held and there is no evidence yet", () => {
    const lines = cacheLines({ drops: [], evidence: [] }, 100)
    expect(lines[0]!.text).toBe("reuse losses  0 events · 0 tokens")
    expect(lines[0]!.tone).toBe("base")
    expect(text(lines)).toContain("none: prompt cache held through every gap")
    expect(text(lines)).toContain("no comparable step pairs yet")
    expect(text(lines)).not.toContain("recent losses")
  })
})

describe("latencyLines", () => {
  test("prints percentiles for wall time, streaming window and throughput", () => {
    const lines = latencyLines(latency(), 100)
    expect(lines[0]!.text).toContain("wall")
    expect(lines[0]!.text).toContain("4.2s")
    expect(lines[0]!.text).toContain("n 12")
    expect(lines[1]!.text).toContain("700ms")
    expect(lines[2]!.text).toContain("42.5/s")
    expect(text(lines)).not.toContain("no completed steps for this range")
  })

  test("marks a range with no measured steps", () => {
    const lines = latencyLines(
      { wall: { count: 0, p50: undefined, p90: undefined, p99: undefined }, stream: { count: 0, p50: undefined, p90: undefined, p99: undefined }, tps: { count: 0, p50: undefined, p90: undefined, p99: undefined } },
      60,
    )
    expect(lines[0]!.text).toContain("n 0")
    expect(text(lines)).toContain("no completed steps for this range")
    expect(text(lines)).toContain("–")
  })
})

describe("sessionsLines", () => {
  test("lists sessions with their providers", () => {
    const rows: SessionUsage[] = [
      {
        sessionID: "ses_1",
        title: "Fix the recorder",
        directory: "/project",
        providers: ["opencode", "deepseek"],
        models: ["deepseek-v4.1-flash-free"],
        prompts: 3,
        firstAt: undefined,
        lastAt: undefined,
        steps: 6,
        input: 20_000,
        cached: 500_000,
        cacheWrite: 0,
        output: 1_200,
        reasoning: 0,
        cost: 1.25,
      },
    ]
    const lines = sessionsLines(rows, 100)
    expect(lines[0]!.tone).toBe("accent")
    expect(lines[0]!.text).toContain("title")
    expect(text(lines)).toContain("Fix the recorder [opencode,deepseek]")
    expect(text(lines)).toContain("$1.25")
  })

  test("falls back to the session id and explains an empty range", () => {
    const lines = sessionsLines(
      [
        {
          sessionID: "ses_untitled",
          title: undefined,
          directory: undefined,
          providers: [],
          models: [],
          prompts: 0,
          firstAt: undefined,
          lastAt: undefined,
          steps: 1,
          input: 10,
          cached: 0,
          cacheWrite: 0,
          output: 1,
          reasoning: 0,
          cost: 0,
        },
      ],
      100,
    )
    expect(text(lines)).toContain("ses_untitled")
    expect(sessionsLines([], 100).at(-1)!.text).toBe("no sessions recorded for this range")
  })
})

describe("turnsLines", () => {
  const usage = { steps: 1, input: 1_617, cached: 425_728, cacheWrite: 0, output: 434, reasoning: 631, cost: 0.01 }
  const turn = (overrides: Partial<TurnUsage> = {}): TurnUsage => ({
    sessionID: "s1",
    promptAt: 1_000,
    endAt: 1_500,
    promptGapMs: 1_000,
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    variant: "max",
    upstream: "DeepSeek",
    upstreamModel: "deepseek/deepseek-v4.1-flash",
    router: "orcarouter-dsv4.1flash",
    routerChanged: false,
    providerChanged: false,
    modelChanged: false,
    steps: 1,
    latest: usage,
    totals: usage,
    drops: [],
    finish: "stop",
    ...overrides,
  })

  test("renders every turn with the line's own format, without the session segment", () => {
    const lines = turnsLines([turn()], 160)
    expect(lines[0]!.text).toBe("1 turn · newest first")
    expect(lines[1]!.text).toBe(
      `${formatClock(1_500)} · Δ 1s · orcarouter-dsv4.1flash · in 1.62k (427.3k), cached 425.7k, out 1.06k`,
    )
    expect(lines[1]!.text).not.toContain("sess")
    expect(lines[1]!.tone).toBe("base")
  })

  test("counts the steps of a tool-call loop and flags a changed endpoint", () => {
    const lines = turnsLines([turn({ steps: 3, routerChanged: true })], 160)
    expect(lines[1]!.text).toContain("orcarouter-dsv4.1flash · changed · 3 steps ·")
  })

  test("highlights a turn that lost cache reuse", () => {
    const lines = turnsLines([turn({ drops: [{ messageID: "m", tokens: 12_400, gapMs: 900_000 }] })], 160)
    expect(lines[1]!.text).toContain("⚠ cache expired (−12.4k)")
    expect(lines[1]!.tone).toBe("warning")
  })

  test("falls back to provider/model when no endpoint was recorded", () => {
    const lines = turnsLines([turn({ router: undefined })], 160)
    expect(lines[1]!.text).toContain("opencode-go/deepseek-v4.1-flash max")
  })

  test("says so when there is no finished turn", () => {
    const lines = turnsLines([], 100)
    expect(text(lines)).toContain("no finished turns for this range")
  })

  test("sidebarLines shows two compact lines per turn within the budget", () => {
    const lines = sidebarLines([turn({ steps: 2 }), turn({ endAt: 1_500, router: "orcarouter-glm-5.3" })], { budget: 34 })
    expect(lines).toHaveLength(4)
    expect(lines[0]!.text).toBe(`${formatClock(1_500).slice(0, 5)} orcarouter-dsv4.1flash`)
    expect(lines[1]!.text).toBe("  in 1.62k (427.3k) · out 1.06k")
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(34)
    expect(sidebarLines([], {})).toEqual([{ text: "no finished turns yet", tone: "muted" }])
  })
})
