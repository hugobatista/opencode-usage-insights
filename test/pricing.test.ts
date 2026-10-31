import { describe, expect, test } from "bun:test"
import { costOf, priceOf, priceTable, type ModelInfoLike } from "../src/pricing"

const GO = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }

function table(cost: ModelInfoLike["cost"], overrides: Partial<ModelInfoLike> = {}) {
  return priceTable([{ ...GO, cost, ...overrides }])
}

describe("priceTable", () => {
  test("keys by provider and model, and skips models without prices", () => {
    const prices = priceTable([
      { ...GO, cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }] },
      { providerID: "opencode", modelID: "no-price" },
      { providerID: "opencode", modelID: "empty", cost: [] },
    ])
    expect([...prices.keys()]).toEqual(["opencode-go/deepseek-v4.1-flash"])
    expect(priceOf(prices, GO)?.tiers).toHaveLength(1)
    expect(priceOf(prices, { providerID: "opencode", modelID: "no-price" })).toBeUndefined()
  })

  test("accepts the model's `id` when `modelID` is absent", () => {
    const prices = priceTable([{ providerID: "p", id: "m", cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] }])
    expect(priceOf(prices, { providerID: "p", modelID: "m" })).toBeDefined()
  })
})

describe("costOf", () => {
  test("prices every bucket per million tokens", () => {
    const prices = table([{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0.3 } }])
    expect(
      costOf(prices, GO, {
        input: 1_000_000,
        output: 1_000_000,
        reasoning: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      }),
    ).toBeCloseTo(0.15 + 1.2 + 0.003 + 0.3, 12)
  })

  test("reproduces the three costs recorded by OpenCode 2.1.4", () => {
    const prices = table([{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }])
    const steps = [
      { input: 2_591, output: 564, reasoning: 3_239, cacheRead: 514_944, cacheWrite: 0, recorded: 0.004215282 },
      { input: 3_407, output: 521, reasoning: 1_540, cacheRead: 511_616, cacheWrite: 0, recorded: 0.003282498 },
      { input: 878, output: 1_504, reasoning: 1_761, cacheRead: 510_848, cacheWrite: 0, recorded: 0.003623244 },
    ]
    for (const step of steps) {
      const cost = costOf(prices, GO, step)
      expect(cost).toBeDefined()
      expect(Math.abs(cost! - step.recorded)).toBeLessThan(1e-9)
    }
  })

  test("bills reasoning at the output price", () => {
    const prices = table([{ input: 0, output: 1, cache: { read: 0, write: 0 } }])
    expect(costOf(prices, GO, { output: 1_000, reasoning: 2_000 })).toBeCloseTo(0.003, 12)
  })

  test("selects a context tier only above its size, and falls back to the untiered price", () => {
    const prices = table([
      { input: 1, output: 2, cache: { read: 0, write: 0 } },
      { tier: { type: "context", size: 1_000 }, input: 2, output: 4, cache: { read: 0, write: 0 } },
    ])
    // At the threshold the host uses the untiered price: `prompt > size`, not `>=`.
    expect(costOf(prices, GO, { input: 1_000 })).toBeCloseTo(1_000 / 1_000_000, 12)
    // One token above the threshold switches to the tier.
    expect(costOf(prices, GO, { input: 1_001 })).toBeCloseTo((1_001 * 2) / 1_000_000, 12)
  })

  test("uses the largest applicable tier", () => {
    const prices = table([
      { input: 1, output: 0, cache: { read: 0, write: 0 } },
      { tier: { type: "context", size: 100 }, input: 2, output: 0, cache: { read: 0, write: 0 } },
      { tier: { type: "context", size: 1_000 }, input: 3, output: 0, cache: { read: 0, write: 0 } },
    ])
    expect(costOf(prices, GO, { input: 1_001 })).toBeCloseTo((1_001 * 3) / 1_000_000, 12)
  })

  test("needs an untiered entry when no tier applies", () => {
    const prices = table([{ tier: { type: "context", size: 1_000 }, input: 2, output: 4, cache: { read: 0, write: 0 } }])
    expect(costOf(prices, GO, { input: 500 })).toBeUndefined()
    expect(costOf(prices, GO, { input: 1_001 })).toBeCloseTo((1_001 * 2) / 1_000_000, 12)
  })

  test("does not price an unknown model", () => {
    const prices = table([{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
    expect(costOf(prices, { providerID: "opencode", modelID: "other" }, { input: 1_000 })).toBeUndefined()
    expect(costOf(prices, {}, { input: 1_000 })).toBeUndefined()
  })

  test("distinguishes a known free model from an unknown price", () => {
    const free = table([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
    // 0 means "known free", so a backfill can stop treating it as unpriced.
    expect(costOf(free, GO, { input: 1_000, output: 500 })).toBe(0)
    expect(costOf(priceTable([]), GO, { input: 1_000 })).toBeUndefined()
  })

  test("clamps nonsensical token counts and ignores a zero bill", () => {
    const prices = table([{ input: 1, output: 1, cache: { read: 1, write: 1 } }])
    expect(costOf(prices, GO, { input: -10, output: Number.NaN })).toBeUndefined()
    expect(costOf(prices, GO, { input: 1_000 })).toBeCloseTo(0.001, 12)
  })
})
