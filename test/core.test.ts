import { describe, expect, test } from "bun:test"
import {
  identityKey,
  cacheDrop,
  computeTurn,
  displayTotals,
  formatClock,
  formatCost,
  formatDuration,
  formatLine,
  formatLineSegments,
  formatTokens,
  isNoiseDrop,
  stepEnd,
  stepGap,
  stepTps,
  stepStreamMs,
  tokensPerSecond,
  totalize,
  transcriptSegments,
  transcriptTail,
  type AssistantMessage,
  type ModelRefLike,
  type Totals,
  type TurnStats,
  type TranscriptMessage,
} from "../src/core"

const MODEL = "deepseek-v4.1-flash-free"

type StepOptions = {
  provider?: string
  model?: string
  variant?: string
  input?: number
  output?: number
  reasoning?: number
  read?: number
  write?: number
  cost?: number
  streamed?: number
  completed?: number
}

function step(id: string, created: number, options: StepOptions = {}): AssistantMessage {
  const model: ModelRefLike = {
    providerID: options.provider ?? "opencode",
    id: options.model ?? MODEL,
  }
  if (options.variant !== undefined) model.variant = options.variant

  const time: NonNullable<AssistantMessage["time"]> = { created }
  if (options.streamed !== undefined) time.streamed = options.streamed
  if (options.completed !== undefined) time.completed = options.completed

  return {
    type: "assistant",
    id,
    time,
    model,
    tokens: {
      input: options.input ?? 0,
      output: options.output ?? 0,
      reasoning: options.reasoning ?? 0,
      cache: { read: options.read ?? 0, write: options.write ?? 0 },
    },
    cost: options.cost ?? 0,
  }
}

function prompt(id: string, created: number): TranscriptMessage {
  return { type: "user", id, time: { created } }
}

function idle(id: string, created: number): TranscriptMessage {
  return { type: "idle", id, time: { created } }
}

describe("transcriptSegments", () => {
  test("splits runs of assistants at prompt boundaries", () => {
    const segments = transcriptSegments([
      prompt("u1", 1),
      step("a1", 2),
      step("a2", 3),
      prompt("u2", 4),
      step("a3", 5),
    ])
    expect(segments).toHaveLength(2)
    expect(segments[0]!.assistants.map((s) => s.id)).toEqual(["a1", "a2"])
    expect(segments[1]!.assistants.map((s) => s.id)).toEqual(["a3"])
  })

  test("keeps a run open across idle, info, compaction and shell messages", () => {
    const segments = transcriptSegments([
      prompt("u1", 1),
      step("a1", 2),
      idle("i1", 3),
      { type: "compaction" },
      idle("i2", 4),
      step("a2", 5),
      { type: "shell", id: "sh1" },
      step("a3", 6),
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.assistants.map((s) => s.id)).toEqual(["a1", "a2", "a3"])
  })

  test("attaches the most recent prompt to the run", () => {
    const segments = transcriptSegments([prompt("u1", 1), prompt("u2", 2), step("a1", 3)])
    expect(segments[0]!.prompt?.id).toBe("u2")
  })

  test("ignores runs that never happened", () => {
    expect(transcriptSegments([prompt("u1", 1), idle("i1", 2)])).toHaveLength(0)
    expect(transcriptSegments([])).toHaveLength(0)
  })
})

describe("transcriptTail", () => {
  /** A transcript the two walks must agree on, whatever it holds. */
  const samples: TranscriptMessage[][] = [
    [],
    [step("a1", 1)],
    [prompt("u1", 1), step("a1", 2)],
    [prompt("u1", 1), step("a1", 2), step("a2", 3), prompt("u2", 4), step("a3", 5)],
    [step("a0", 1), prompt("u1", 2), step("a1", 3), prompt("u2", 4), step("a2", 5), idle("i1", 6), step("a3", 7)],
    [prompt("u1", 1), prompt("u2", 2), step("a1", 3), prompt("u3", 4), idle("i1", 5)],
    [idle("i1", 1), { type: "compaction" }, step("a1", 2)],
  ]

  test("agrees with the full walk on the turns it returns", () => {
    for (const messages of samples) {
      const all = transcriptSegments(messages)
      const tail = transcriptTail(messages, 2)
      const expected = all.slice(Math.max(0, all.length - 2))
      expect(tail.map((segment) => ({ ids: segment.assistants.map((s) => s.id), prompt: segment.prompt?.id }))).toEqual(
        expected.map((segment) => ({ ids: segment.assistants.map((s) => s.id), prompt: segment.prompt?.id })),
      )
    }
  })

  test("stops at the requested number of turns", () => {
    const messages = [prompt("u1", 1), step("a1", 2), prompt("u2", 3), step("a2", 4), prompt("u3", 5), step("a3", 6)]
    expect(transcriptTail(messages, 1).map((segment) => segment.assistants[0]!.id)).toEqual(["a3"])
    expect(transcriptTail(messages, 3)).toHaveLength(3)
  })

  test("computeTurn reads the same turn through the tail walk", () => {
    const messages = [
      prompt("u1", 1),
      step("a1", 2, { read: 5_000, completed: 1_100 }),
      prompt("u2", 1_200),
      step("a2", 1_300, { read: 5_000, completed: 1_900 }),
      idle("i1", 2_000),
      step("a3", 2_100, { read: 5_000, completed: 2_600 }),
    ]
    const stats = computeTurn(messages)
    expect(stats?.steps).toBe(2)
    expect(stats?.drops).toHaveLength(0)
    expect(stats?.totals.cached).toBe(10_000)
  })
})

describe("token accounting", () => {
  test("totalize sums usage across steps", () => {
    const totals = totalize([
      step("a1", 1, { input: 100, output: 10, reasoning: 5, read: 900, write: 50, cost: 0.001 }),
      step("a2", 2, { input: 20, output: 30, reasoning: 1, read: 800, write: 10, cost: 0.002 }),
    ])
    expect(totals).toEqual({
      input: 120,
      cached: 1700,
      output: 40,
      reasoning: 6,
      cacheWrite: 60,
      cost: 0.003,
      steps: 2,
    })
  })

  test("totalize tolerates partial messages", () => {
    const totals = totalize([{ type: "assistant", id: "a1" }])
    expect(totals).toEqual({ input: 0, cached: 0, output: 0, reasoning: 0, cacheWrite: 0, cost: 0, steps: 1 })
  })

  test("identityKey includes the variant when present", () => {
    expect(identityKey({ providerID: "opencode", id: "m" })).toBe("opencode/m")
    expect(identityKey({ providerID: "opencode", id: "m", variant: "max" })).toBe("opencode/m#max")
    expect(identityKey(undefined)).toBeUndefined()
  })
})

describe("cacheDrop", () => {
  test("flags a reuse loss on the same model", () => {
    expect(cacheDrop(step("a0", 1, { read: 1_541_700 }), step("a1", 2, { read: 1_530_000 }))).toBe(11_700)
  })

  test("ignores drops when the model changed", () => {
    expect(cacheDrop(step("a0", 1, { read: 500_000 }), step("a1", 2, { read: 10_000, model: "other" }))).toBeUndefined()
    expect(cacheDrop(step("a0", 1, { read: 500_000 }), step("a1", 2, { read: 10_000, provider: "other" }))).toBeUndefined()
    expect(
      cacheDrop(step("a0", 1, { read: 500_000, variant: "max" }), step("a1", 2, { read: 10_000, variant: "high" })),
    ).toBeUndefined()
  })

  test("measures a drop across a provider switch only when asked to", () => {
    const before = step("a0", 1, { provider: "opencode-go", read: 500_000 })
    const after = step("a1", 2, { provider: "deepseek", read: 10_000 })
    // The strict rule: two providers are two caches, and a switch between them
    // is not a loss but a different cache.
    expect(cacheDrop(before, after)).toBeUndefined()
    // The reports that measure what an identity change costs ask for the model
    // scope: forfeiting the previous provider's cache is exactly that cost.
    expect(cacheDrop(before, after, "model")).toBe(490_000)
    // The model must still be the same for either scope to apply.
    expect(cacheDrop(before, step("a1", 2, { provider: "deepseek", read: 10_000, model: "other" }), "model")).toBeUndefined()
  })

  test("ignores reads that merely grew or stayed equal", () => {
    expect(cacheDrop(step("a0", 1, { read: 100 }), step("a1", 2, { read: 100 }))).toBeUndefined()
    expect(cacheDrop(step("a0", 1, { read: 100 }), step("a1", 2, { read: 200 }))).toBeUndefined()
    expect(cacheDrop(undefined, step("a1", 2, { read: 100 }))).toBeUndefined()
  })

  test("ignores small OpenAI cache reads as provider noise between 1024 and 2048 tokens", () => {
    const before = step("a0", 1, { provider: "openai", read: 500_000 })
    expect(cacheDrop(before, step("a1", 2, { provider: "openai", read: 498_500 }))).toBeUndefined()
    expect(cacheDrop(before, step("a1", 2, { provider: "openai", read: 495_000 }))).toBe(5_000)
    expect(isNoiseDrop("openai", 2_000)).toBe(true)
    expect(isNoiseDrop("openai", 4_000)).toBe(false)
    expect(isNoiseDrop("opencode", 2_000)).toBe(false)
    expect(isNoiseDrop(undefined, 2_000)).toBe(false)
  })

  test("gap, streaming window and throughput helpers", () => {
    const before = step("a0", 1_000, { completed: 2_600 })
    const after = step("a1", 3_000, { streamed: 3_250, completed: 3_850, output: 50, reasoning: 10 })
    expect(stepGap(before, after)).toBe(400)
    expect(stepGap(undefined, after)).toBeUndefined()
    expect(stepStreamMs(after)).toBe(250)
    expect(stepTps(after)).toBe(240)
    expect(stepTps(step("a2", 1, { output: 10 }))).toBeUndefined()
    expect(stepEnd(before)).toBe(2_600)
    expect(stepEnd(step("a3", 1, { streamed: 5 }))).toBe(5)
    expect(stepEnd(step("a4", 7))).toBe(7)
  })
})

describe("computeTurn", () => {
  test("returns undefined when no assistant step exists", () => {
    expect(computeTurn([])).toBeUndefined()
    expect(computeTurn([prompt("u1", 1), idle("i1", 2)])).toBeUndefined()
  })

  test("computes the final turn and its totals", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { input: 100, output: 10, read: 900, write: 50, completed: 2_600 }),
      idle("i1", 2_700),
    ])
    expect(stats).toBeDefined()
    expect(stats!.endAt).toBe(2_600)
    expect(stats!.promptAt).toBe(1_000)
    expect(stats!.promptGapMs).toBeUndefined()
    expect(stats!.steps).toBe(1)
    expect(stats!.providerID).toBe("opencode")
    expect(stats!.modelID).toBe(MODEL)
    expect(stats!.providerChanged).toBe(false)
    expect(stats!.modelChanged).toBe(false)
    expect(stats!.cacheExpired).toBe(false)
    expect(stats!.totals).toEqual({
      input: 100,
      cached: 900,
      output: 10,
      reasoning: 0,
      cacheWrite: 50,
      cost: 0,
      steps: 1,
    })
  })

  test("measures the gap between prompt N-1 and prompt N", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { completed: 2_600 }),
      prompt("u2", 1_000 + 192_000),
      step("a2", 200_000, { completed: 200_600 }),
    ])
    expect(stats!.promptGapMs).toBe(192_000)
  })

  test("counts only the steps that settled", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { completed: 2_600 }),
      prompt("u2", 3_000),
      step("a2", 4_000, { completed: 4_600 }),
      step("a3", 5_000),
      step("a4", 6_000, { completed: 6_600 }),
    ])
    // A step that never settled has no final numbers: it is neither counted nor
    // a cache reference.
    expect(stats!.steps).toBe(2)
  })

  test("flags a provider change against the previous turn", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { provider: "github-copilot", model: "gpt-4o", read: 500_000, completed: 2_600 }),
      prompt("u2", 10_000),
      step("a2", 11_000, { provider: "opencode", read: 400_000, completed: 11_600 }),
    ])
    expect(stats!.providerChanged).toBe(true)
    expect(stats!.modelChanged).toBe(false)
    expect(stats!.cacheExpired).toBe(false)
  })

  test("flags a model change when the provider stays the same", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { model: "big-pickle", completed: 2_600 }),
      prompt("u2", 10_000),
      step("a2", 11_000, { model: MODEL, completed: 11_600 }),
    ])
    expect(stats!.providerChanged).toBe(false)
    expect(stats!.modelChanged).toBe(true)
  })

  test("detects cache reuse loss across the turn boundary", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { read: 1_541_700, completed: 2_600 }),
      prompt("u2", 10_000),
      step("a2", 11_000, { read: 1_530_000, completed: 11_600 }),
    ])
    expect(stats!.cacheExpired).toBe(true)
    expect(stats!.cacheDropTokens).toBe(11_700)
    expect(stats!.drops).toHaveLength(1)
    expect(stats!.drops[0]!.messageID).toBe("a2")
    expect(stats!.drops[0]!.gapMs).toBe(8_400)
    expect(stats!.drops[0]!.prevCached).toBe(1_541_700)
  })

  test("detects reuse loss between steps inside one turn", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { read: 400_000, completed: 2_600 }),
      step("a2", 3_000, { read: 300_000, completed: 3_600 }),
    ])
    expect(stats!.steps).toBe(2)
    expect(stats!.cacheDropTokens).toBe(100_000)
    expect(stats!.drops[0]!.messageID).toBe("a2")
  })

  test("passes session totals through", () => {
    const session: Totals = { input: 1, cached: 2, output: 3, reasoning: 4, cacheWrite: 5, cost: 6, steps: 7 }
    const stats = computeTurn([prompt("u1", 1_000), step("a1", 2_000, { completed: 2_600 })], session)
    expect(stats!.session).toEqual(session)
  })
})

describe("turn totals views", () => {
  /** The three steps of the turn shown in the live report (real values). */
  const multiStep = (): TranscriptMessage[] => [
    prompt("u1", 1_000),
    step("a1", 2_000, { input: 924, output: 242, read: 290_048, completed: 2_600 }),
    step("a2", 3_000, { input: 723, output: 148, reasoning: 351, read: 290_944, completed: 3_600 }),
    step("a3", 4_000, { input: 1_020, output: 463, reasoning: 1_030, read: 291_584, completed: 4_600 }),
  ]
  const plain = { fields: { clock: false, delta: false, model: false, session: false } }

  test("latest is the prompt size the turn ended with, totals is every step", () => {
    const stats = computeTurn(multiStep())!
    expect(stats.latest).toMatchObject({ input: 1_020, cached: 291_584, output: 463, reasoning: 1_030, steps: 1 })
    expect(stats.totals).toMatchObject({ input: 2_667, cached: 872_576, output: 853, reasoning: 1_381, steps: 3 })
    expect(stats.steps).toBe(3)
  })

  test("the line reads the latest step by default and the sum on request", () => {
    const stats = computeTurn(multiStep())!
    expect(formatLine(stats, plain)).toBe("opencode · 3 steps · in 1.02k (292.6k), cached 291.6k, out 1.49k")
    expect(formatLine(stats, { ...plain, turnTotals: "sum" })).toBe("opencode · 3 steps · in 2.67k (875.2k), cached 872.6k, out 2.23k")
  })

  test("a single-step turn reads the same in both views", () => {
    const stats = computeTurn([prompt("u1", 1_000), step("a1", 2_000, { input: 1_000, output: 50, completed: 2_600 })])!
    expect(formatLine(stats, plain)).toBe("opencode · in 1k, cached 0, out 50")
    expect(formatLine(stats, { ...plain, turnTotals: "sum" })).toBe("opencode · in 1k, cached 0, out 50")
  })

  // The displayed buckets must reconcile with OpenCode's own debug line, which
  // reports `new = input + output + reasoning + cacheWrite` and
  // `total = new + cacheRead` for the latest step. These are the real numbers of
  // the step that first showed the mismatch (2,682 new / 425,728 cached).
  test("displayed buckets reconcile with the host's debug numbers", () => {
    const display = displayTotals({ input: 1_617, cached: 425_728, cacheWrite: 0, output: 434, reasoning: 631, cost: 0, steps: 1 })
    const hostNew = 1_617 + 434 + 631 + 0
    const hostTotal = hostNew + 425_728
    expect(display.input).toBe(1_617)
    expect(display.prompt).toBe(427_345)
    expect(display.cached).toBe(425_728)
    expect(display.output).toBe(1_065)
    expect(display.input + display.output).toBe(hostNew)
    expect(display.prompt + display.output).toBe(hostTotal)
  })
})

describe("line identity", () => {
  const transcript = (): TranscriptMessage[] => [prompt("u1", 1_000), step("a1", 2_000, { input: 100, output: 10, completed: 2_600 })]
  const plain = { fields: { clock: false, delta: false, session: false } }

  test("leads with the provider and the model that ran the turn", () => {
    expect(formatLine(computeTurn(transcript())!, plain)).toBe("opencode/deepseek-v4.1-flash-free · in 100, cached 0, out 10")
  })

  test("marks a changed provider with the same warning", () => {
    const stats: TurnStats = { ...computeTurn(transcript())!, providerChanged: true }
    expect(formatLine(stats, plain)).toBe("opencode/deepseek-v4.1-flash-free · changed · in 100, cached 0, out 10")
  })

  test("marks a model change inside one provider separately", () => {
    const stats: TurnStats = { ...computeTurn(transcript())!, modelChanged: true }
    expect(formatLine(stats, plain)).toBe("opencode/deepseek-v4.1-flash-free · model changed · in 100, cached 0, out 10")
  })

  test("keeps the variant of the model when it has one", () => {
    const stats: TurnStats = { ...computeTurn(transcript())!, variant: "max" }
    expect(formatLine(stats, plain)).toBe("opencode/deepseek-v4.1-flash-free max · in 100, cached 0, out 10")
  })
})

describe("formatDuration", () => {
  test("seconds only", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(1_200)).toBe("1s")
    expect(formatDuration(59_999)).toBe("59s")
  })
  test("minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m00s")
    expect(formatDuration(192_000)).toBe("3m12s")
  })
  test("hours and days", () => {
    expect(formatDuration(3_600_000)).toBe("1h00m")
    expect(formatDuration(47_520_000)).toBe("13h12m")
    expect(formatDuration(90_000_000)).toBe("1d1h")
  })
})

describe("formatTokens", () => {
  test("scales with magnitude", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1_000)).toBe("1k")
    expect(formatTokens(1_530)).toBe("1.53k")
    expect(formatTokens(3_700)).toBe("3.7k")
    expect(formatTokens(84_200)).toBe("84.2k")
    expect(formatTokens(88_000)).toBe("88k")
    expect(formatTokens(999_000)).toBe("999k")
    expect(formatTokens(1_530_000)).toBe("1.53M")
    expect(formatTokens(12_400_000)).toBe("12.4M")
    expect(formatTokens(150_000_000)).toBe("150M")
  })
})

describe("formatCost", () => {
  test("keeps sub-cent precision", () => {
    expect(formatCost(0)).toBe("$0")
    expect(formatCost(0.0231)).toBe("$0.0231")
    expect(formatCost(2.5)).toBe("$2.50")
  })
})

describe("formatClock", () => {
  test("renders local wall clock as HH:MM:SS", () => {
    expect(formatClock(new Date(2026, 9, 15, 14, 32, 7).getTime())).toBe("14:32:07")
    expect(formatClock(new Date(2026, 9, 15, 3, 4, 5).getTime())).toBe("03:04:05")
  })
})

describe("formatLineSegments", () => {
  const end = new Date(2026, 9, 15, 14, 32, 7).getTime()

  function lineTranscript(): TranscriptMessage[] {
    const u2 = end - 4_000
    const u1 = u2 - 192_000
    return [
      prompt("u1", u1),
      step("a1", u1 + 100, { read: 1_541_700, completed: u1 + 600 }),
      prompt("u2", u2),
      step("a2", u2 + 1_000, {
        input: 84_200,
        output: 3_700,
        read: 1_530_000,
        write: 1_200,
        completed: end,
      }),
    ]
  }

  const session: Totals = { input: 2_100_000, cached: 12_400_000, output: 88_000, reasoning: 0, cacheWrite: 0, cost: 0, steps: 9 }

  test("renders the telemetry line", () => {
    const stats = computeTurn(lineTranscript(), session)!
    expect(formatLine(stats)).toBe(
      "14:32:07 · Δ 3m12s · opencode/deepseek-v4.1-flash-free · " +
        "in 85.4k (1.62M), cached 1.53M, out 3.7k · sess in 2.1M (14.5M), cached 12.4M, out 88k · " +
        "⚠ cache expired (−11.7k)",
    )
  })

  test("marks a changed provider in warning tone", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { provider: "github-copilot", model: "gpt-4o", completed: 2_600 }),
      prompt("u2", 10_000),
      step("a2", 11_000, { provider: "opencode", completed: 11_600 }),
    ])!
    const segments = formatLineSegments(stats)
    expect(segments.find((s) => s.text === "opencode/deepseek-v4.1-flash-free")).toEqual({
      text: "opencode/deepseek-v4.1-flash-free",
      tone: "warning",
    })
    expect(segments.find((s) => s.text === "changed")).toEqual({ text: "changed", tone: "warning" })
  })

  test("marks a changed model in muted tone and keeps the provider calm", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { model: "big-pickle", completed: 2_600 }),
      prompt("u2", 10_000),
      step("a2", 11_000, { model: MODEL, completed: 11_600 }),
    ])!
    const segments = formatLineSegments(stats)
    expect(segments.find((s) => s.text.startsWith("opencode/"))!.tone).toBe("base")
    expect(segments.find((s) => s.text === "model changed")!.tone).toBe("muted")
  })

  test("never mentions an operator the model did not run through", () => {
    const stats = computeTurn(lineTranscript(), session)!
    expect(formatLineSegments(stats).find((s) => s.text.includes("via"))).toBeUndefined()
    expect(formatLineSegments(stats, { fields: { upstream: true } } as never).find((s) => s.text.includes("via"))).toBeUndefined()
  })

  test("respects field toggles and label overrides", () => {
    const stats = computeTurn(lineTranscript(), session)!
    const line = formatLine(stats, {
      fields: { delta: false, session: false, model: false, clock: false },
      labels: { turn: "turno", cached: "cache", output: "saida", cacheExpired: "cache expirada" },
    })
    expect(line).toBe("opencode · turno in 85.4k (1.62M), cache 1.53M, saida 3.7k · ⚠ cache expirada (−11.7k)")
  })

  test("adds reasoning on request, with the cost already there", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { input: 1_000, output: 2_000, reasoning: 3_000, cost: 0.0123, completed: 2_600 }),
    ])!
    const line = formatLine(stats, { fields: { clock: false, delta: false, model: false, session: false, reasoning: true } })
    expect(line).toBe("opencode · in 1k, cached 0, out 5k, reason 3k, cost $0.0123")
  })

  test("leaves the cost out when nothing was paid", () => {
    const stats = computeTurn([prompt("u1", 1_000), step("a1", 2_000, { input: 100, output: 10, completed: 2_600 })], session)!
    const line = formatLine(stats, { fields: { clock: false, delta: false } })
    expect(line).not.toContain("cost")
    // The session's own cost is left out the same way.
    expect(line).toContain("sess in 2.1M (14.5M), cached 12.4M, out 88k")
  })

  test("counts the whole turn's cost, not the last step's", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { input: 100, output: 10, cost: 0.0103, completed: 2_600 }),
      step("a2", 4_000, { input: 200, output: 20, cost: 0.0011, completed: 4_600 }),
    ])!
    // `latest` shows the context the turn ended with (200 in, 20 out), but money
    // is paid per step: the cost is the two steps together.
    const line = formatLine(stats, { fields: { clock: false, delta: false, model: false, session: false } })
    expect(line).toBe("opencode · 2 steps · in 200, cached 0, out 20, cost $0.0114")
  })

  test("omits the cache warning when reuse held", () => {
    const stats = computeTurn([prompt("u1", 1_000), step("a1", 2_000, { completed: 2_600 })])!
    expect(formatLine(stats)).not.toContain("cache expired")
  })
})

describe("settled turns", () => {
  test("stays undefined while the newest step is still streaming", () => {
    expect(
      computeTurn([
        prompt("u1", 1_000),
        step("a1", 2_000, { input: 100, output: 10, read: 900, completed: 2_600 }),
        prompt("u2", 3_000),
        step("a2", 4_000),
      ]),
    ).toBeUndefined()
  })

  test("shows the turn once the response settles", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { input: 100, output: 10, read: 900, completed: 2_600 }),
      prompt("u2", 3_000),
      step("a2", 4_000, { input: 250, output: 30, read: 900, streamed: 4_200, completed: 4_600 }),
    ])!
    expect(stats.endAt).toBe(4_600)
    expect(stats.totals.input).toBe(250)
    expect(stats.cacheExpired).toBe(false)
  })

  test("a terminal finish settles a step without a completion time", () => {
    const aborted: AssistantMessage = { ...step("a1", 2_000, { input: 100 }), finish: "error" }
    const stats = computeTurn([prompt("u1", 1_000), aborted])
    expect(stats).toBeDefined()
    expect(stats!.totals.input).toBe(100)
  })

  test("never reads a cache drop out of an unsettled step", () => {
    const stats = computeTurn([
      prompt("u1", 1_000),
      step("a1", 2_000, { read: 900_000, completed: 2_600 }),
      step("a2", 3_000),
      step("a3", 4_000, { read: 900_000, completed: 4_600 }),
    ])!
    expect(stats.drops).toEqual([])
    expect(stats.cacheExpired).toBe(false)
    expect(stats.steps).toBe(2)
  })
})

describe("tokensPerSecond", () => {
  test("spreads produced tokens over the streaming window", () => {
    expect(tokensPerSecond(350, 1_000, 1_500)).toBe(700)
    expect(tokensPerSecond(25, 550, 900)).toBe((25 / 350) * 1000)
  })

  test("needs a window and something produced", () => {
    expect(tokensPerSecond(100, undefined, 1_500)).toBeUndefined()
    expect(tokensPerSecond(100, 1_000, undefined)).toBeUndefined()
    expect(tokensPerSecond(100, 1_500, 1_500)).toBeUndefined()
    expect(tokensPerSecond(100, 1_600, 1_500)).toBeUndefined()
    expect(tokensPerSecond(0, 1_000, 1_500)).toBeUndefined()
  })
})
