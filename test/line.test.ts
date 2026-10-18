import { describe, expect, test } from "bun:test"
import { computeTurn, formatClock, type AssistantMessage, type Totals, type TranscriptMessage } from "../src/core"
import { lineParts, lineText, sessionTotals, toTranscript, toTranscriptTail, type RuntimeMessage } from "../src/line"

const BASE = 1_800_000_000_000
const at = (seconds: number) => BASE + seconds * 1_000

function assistant(overrides: Partial<AssistantMessage> & { id: string }): AssistantMessage {
  return {
    type: "assistant",
    model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    tokens: { input: 1_000, output: 50, reasoning: 0, cache: { read: 900, write: 0 } },
    cost: 0.02,
    time: { created: at(201), streamed: at(202), completed: at(205) },
    ...overrides,
  }
}

const firstTurn: TranscriptMessage[] = [
  { type: "user", id: "prt_1", time: { created: at(0) } },
  {
    type: "assistant",
    id: "msg_1",
    model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
    tokens: { input: 84_200, output: 3_700, reasoning: 0, cache: { read: 1_530_000, write: 12_000 } },
    cost: 0.12,
    time: { created: at(1), streamed: at(2), completed: at(11) },
  },
]

// The second turn reuses the whole prompt cache, so it carries no drop.
const secondTurn: TranscriptMessage[] = [
  { type: "user", id: "prt_2", time: { created: at(200) } },
  assistant({ id: "msg_2", tokens: { input: 1_000, output: 50, reasoning: 0, cache: { read: 1_534_000, write: 0 } } }),
]

const sessionTotalsFixture: Totals = {
  input: 85_200,
  cached: 3_064_000,
  output: 3_750,
  reasoning: 0,
  cacheWrite: 12_000,
  cost: 0.14,
  steps: 2,
}

describe("toTranscriptTail", () => {
  /** A transcript of `turns` turns, six messages each, like a real session. */
  function session(turns: number): RuntimeMessage[] {
    const messages: RuntimeMessage[] = []
    let at = 1_800_000_000_000
    for (let turn = 0; turn < turns; turn += 1) {
      messages.push({ id: `prt_${turn}`, type: "user", time: { created: at } })
      for (let step = 0; step < 5; step += 1) {
        at += 1_000
        messages.push({
          id: `msg_${turn}_${step}`,
          type: "assistant",
          time: { created: at, streamed: at + 400, completed: at + 1_000 },
          model: { providerID: "opencode", id: "m1" },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 900, write: 5 } },
          cost: 0.001,
          finish: "stop",
        })
      }
      at += 1_000
      // Things that are not a turn boundary keep the run open.
      messages.push({ id: `idle_${turn}`, type: "idle", time: { created: at } })
    }
    return messages
  }

  test("converts only the last turns, and answers what the whole transcript would", () => {
    const messages = session(40)
    const tail = toTranscriptTail(messages, 2)
    // Two turns: their prompts, their five steps each, and nothing else.
    expect(tail.length).toBeLessThanOrEqual(12)
    expect(computeTurn(tail)).toEqual(computeTurn(toTranscript(messages)))
  })

  test("never returns fewer than the two turns computeTurn reads", () => {
    const messages = session(6)
    const two = toTranscriptTail(messages, 2)
    // One segment would answer differently (no `promptGapMs`, no cache
    // reference), so the floor is part of the contract.
    expect(toTranscriptTail(messages, 1).map((message) => message.id)).toEqual(two.map((message) => message.id))
    expect(toTranscriptTail(messages, 0).map((message) => message.id)).toEqual(two.map((message) => message.id))
    expect(computeTurn(toTranscriptTail(messages, 1))).toEqual(computeTurn(toTranscript(messages)))
  })

  test("keeps a trailing run that no prompt opened", () => {
    const messages: RuntimeMessage[] = [
      { id: "prt_1", type: "user", time: { created: at(0) } },
      { id: "msg_1", type: "assistant", time: { created: at(1), completed: at(2) }, model: { providerID: "opencode", id: "m1" }, tokens: { input: 1, output: 1 }, cost: 0 },
      { id: "msg_2", type: "assistant", time: { created: at(3), completed: at(4) }, model: { providerID: "opencode", id: "m1" }, tokens: { input: 1, output: 1 }, cost: 0 },
    ]
    expect(toTranscriptTail(messages, 2).map((message) => message.id)).toEqual(["prt_1", "msg_1", "msg_2"])
  })

  test("has nothing to convert without messages", () => {
    expect(toTranscriptTail([], 2)).toEqual([])
    expect(toTranscriptTail([{ id: "idle_1", type: "idle" }], 2)).toEqual([])
  })
})

describe("toTranscript", () => {
  test("keeps the assistant fields core accounts for", () => {
    const transcript = toTranscript([
      {
        id: "msg_1",
        type: "assistant",
        time: { created: at(1), streamed: at(2), completed: at(3) },
        model: { providerID: "opencode", id: "glm-5.3-flash", variant: "high" },
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } },
        cost: 0.5,
        finish: null,
      },
    ])
    expect(transcript).toEqual([
      {
        type: "assistant",
        id: "msg_1",
        time: { created: at(1), streamed: at(2), completed: at(3) },
        model: { providerID: "opencode", id: "glm-5.3-flash", variant: "high" },
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } },
        cost: 0.5,
        finish: undefined,
        rawFinish: undefined,
      },
    ])
  })

  test("maps prompt-like boundaries without copying unrelated fields", () => {
    const transcript = toTranscript([{ id: "prt_1", type: "user", time: { created: at(0) }, tokens: { input: 1 } } as RuntimeMessage])
    expect(transcript).toEqual([{ type: "user", id: "prt_1", time: { created: at(0) } }])
  })

  test("drops messages that carry no id or no type", () => {
    const transcript = toTranscript([
      { type: "assistant" },
      { id: "msg_x" },
      { id: "msg_y", type: "idle" },
      { id: "msg_z", type: "compaction", time: { created: at(9) } },
    ])
    expect(transcript).toEqual([{ type: "idle", id: "msg_y", time: undefined }, { type: "compaction", id: "msg_z", time: { created: at(9) } }])
  })

  test("drops an incomplete model ref instead of inventing a provider", () => {
    const transcript = toTranscript([{ id: "msg_1", type: "assistant", model: { providerID: "opencode" } }])
    expect(transcript).toEqual([
      { type: "assistant", id: "msg_1", time: undefined, model: undefined, tokens: undefined, cost: undefined, finish: undefined, rawFinish: undefined },
    ])
  })

  test("round-trips the host shapes used by the TUI line", () => {
    const stats = computeTurn(toTranscript([{ id: "prt_1", type: "user", time: { created: at(0) } }, { id: "msg_1", type: "assistant", time: { created: at(1), completed: at(5) }, model: { providerID: "opencode", id: "m" }, tokens: { input: 100, output: 10, cache: { read: 0 } } }]))
    expect(stats?.providerID).toBe("opencode")
    expect(stats?.modelID).toBe("m")
    expect(stats?.endAt).toBe(at(5))
  })
})

describe("sessionTotals", () => {
  test("maps host session totals with zero defaults", () => {
    expect(sessionTotals({ tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 30 } }, cost: 1.5 })).toEqual({
      input: 10,
      cached: 30,
      output: 4,
      reasoning: 2,
      cacheWrite: 0,
      cost: 1.5,
      steps: 0,
    })
  })

  test("is undefined when the host has no session yet", () => {
    expect(sessionTotals(undefined)).toBeUndefined()
    expect(sessionTotals({})).toEqual({ input: 0, cached: 0, output: 0, reasoning: 0, cacheWrite: 0, cost: 0, steps: 0 })
  })
})

describe("lineParts", () => {
  const stats = computeTurn([...firstTurn, ...secondTurn], sessionTotalsFixture)!

  test("is empty without a turn", () => {
    expect(lineParts(undefined)).toEqual([])
    expect(lineText([])).toBe("")
  })

  test("renders the default line with muted separators", () => {
    const parts = lineParts(stats)
    expect(lineText(parts)).toBe(
      `${formatClock(at(205))} · Δ 3m20s · opencode/deepseek-v4.1-flash-free · in 1k (1.53M), cached 1.53M, out 50, cost $0.0200 · sess in 97.2k (3.16M), cached 3.06M, out 3.75k, cost $0.1400`,
    )
    expect(parts.filter((part) => part.text === " · ").every((part) => part.tone === "muted")).toBe(true)
    expect(parts.find((part) => part.text.startsWith("Δ"))?.tone).toBe("muted")
    expect(parts.find((part) => part.text === "opencode/deepseek-v4.1-flash-free")?.tone).toBe("base")
  })

  test("honours field toggles and label overrides", () => {
    const parts = lineParts(stats, {
      labels: { delta: "gap", turn: "step", session: "total" },
      fields: { clock: false, variant: false },
    })
    expect(lineText(parts)).toBe(
      "gap 3m20s · opencode/deepseek-v4.1-flash-free · step in 1k (1.53M), cached 1.53M, out 50, cost $0.0200 · total in 97.2k (3.16M), cached 3.06M, out 3.75k, cost $0.1400",
    )
  })

  test("marks a provider change and keeps the model-change hint quiet", () => {
    const changed = computeTurn([
      ...firstTurn,
      { type: "user", id: "prt_2", time: { created: at(200) } },
      assistant({ id: "msg_2", model: { providerID: "anthropic", id: "claude-opus-4.6" } }),
    ])!
    const parts = lineParts(changed)
    expect(changed.providerChanged).toBe(true)
    expect(parts.find((part) => part.text === "anthropic/claude-opus-4.6")?.tone).toBe("warning")
    expect(parts.find((part) => part.text === "changed")?.tone).toBe("warning")

    const sameProvider = computeTurn([
      ...firstTurn,
      { type: "user", id: "prt_2", time: { created: at(200) } },
      assistant({ id: "msg_2", model: { providerID: "opencode", id: "glm-5.3-flash" } }),
    ])!
    expect(sameProvider.providerChanged).toBe(false)
    expect(sameProvider.modelChanged).toBe(true)
    expect(lineText(lineParts(sameProvider))).toContain("opencode/glm-5.3-flash")
    expect(lineText(lineParts(sameProvider))).not.toContain("changed · model changed")
  })

  test("never shows a reported operator", () => {
    const withUpstream = { ...stats, upstream: "fireworks" } as never
    expect(lineText(lineParts(withUpstream))).not.toContain("fireworks")
  })

  test("shows the cache warning only when a drop was detected", () => {
    expect(stats.cacheExpired).toBe(false)
    expect(lineText(lineParts(stats))).not.toContain("cache expired")

    // Same provider and model, but the second turn re-used 11.7k tokens less.
    const expired = computeTurn([
      ...firstTurn,
      { type: "user", id: "prt_2", time: { created: at(200) } },
      assistant({ id: "msg_2", tokens: { input: 12_700, output: 50, reasoning: 0, cache: { read: 1_518_300, write: 0 } } }),
    ])!
    expect(expired.cacheExpired).toBe(true)
    expect(expired.cacheDropTokens).toBe(11_700)
    expect(expired.drops).toEqual([{ messageID: "msg_2", tokens: 11_700, prevCached: 1_530_000, gapMs: 190_000 }])
    const parts = lineParts(expired)
    const warning = parts[parts.length - 1]!
    expect(warning.tone).toBe("warning")
    expect(warning.text).toBe("⚠ cache expired (−11.7k)")
    expect(lineText(lineParts(expired, { fields: { cacheExpiry: false } }))).not.toContain("cache expired")
  })

  test("counts every dropped step of a multi-step turn", () => {
    const expired = computeTurn([
      ...firstTurn,
      { type: "user", id: "prt_2", time: { created: at(200) } },
      assistant({ id: "msg_2a", tokens: { input: 12_700, output: 50, cache: { read: 1_518_300, write: 0 } }, time: { created: at(201), completed: at(205) } }),
      assistant({ id: "msg_2b", tokens: { input: 18_300, output: 60, cache: { read: 1_500_000, write: 0 } }, time: { created: at(206), completed: at(210) } }),
    ])!
    expect(expired.steps).toBe(2)
    expect(expired.drops.map((drop) => drop.tokens)).toEqual([11_700, 18_300])
    expect(lineText(lineParts(expired))).toContain("⚠ cache expired (−30k×2)")
  })

  test("suppresses the small OpenAI cache reads that are provider noise", () => {
    const noisy = (cacheRead: number) =>
      computeTurn([
        { type: "user", id: "prt_1", time: { created: at(0) } },
        assistant({ id: "msg_1", model: { providerID: "openai", id: "gpt-5.4" }, tokens: { input: 900, output: 10, cache: { read: 10_000, write: 0 } } }),
        { type: "user", id: "prt_2", time: { created: at(200) } },
        assistant({ id: "msg_2", model: { providerID: "openai", id: "gpt-5.4" }, tokens: { input: 900, output: 10, cache: { read: cacheRead, write: 0 } } }),
      ])!
    expect(noisy(8_500).cacheExpired).toBe(false) // 1500 tokens: inside the noise window
    expect(noisy(7_000).cacheExpired).toBe(true) // 3000 tokens: a real drop
  })
})
