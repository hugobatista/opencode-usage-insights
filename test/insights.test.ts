import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { openStatsDb, recordStep, upsertSession, type StepRecord } from "../src/stats/db"
import {
  affinityReport,
  cacheStats,
  coverageReport,
  filterOptions,
  gapReport,
  groupBy,
  isoWeek,
  latencyGroups,
  modelKey,
  periodReport,
  periodStart,
  endpointBreakdown,
  endpointSummary,
  stepFacts,
  stepPairs,
} from "../src/stats/insights"

/** One hour, in the units the recorded steps use. */
const MIN = 60_000
const BASE = 1_800_000_000_000

function seed(): Database {
  const db = openStatsDb(":memory:")
  upsertSession(db, { sessionID: "s1", title: "Session one", directory: "/tmp/s1", startedAt: BASE })
  upsertSession(db, { sessionID: "s2", title: "Session two", directory: "/tmp/s2", startedAt: BASE })
  const steps: StepRecord[] = [
    // A warm step: Fireworks served it through r1.
    { messageID: "a1", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: BASE, streamedAt: BASE + 1_000, completedAt: BASE + 2_000, input: 1_000, cacheRead: 100_000, cacheWrite: 500, output: 200, cost: 0.01, upstream: "Fireworks", router: "r1" },
    // Same model, different endpoint, and 10k of the cache gone.
    { messageID: "a2", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: BASE + 3 * MIN, streamedAt: BASE + 3 * MIN + 1_000, completedAt: BASE + 3 * MIN + 2_000, input: 1_200, cacheRead: 90_000, output: 300, cost: 0.02, upstream: "Fireworks", router: "r2" },
    // Same provider, different model: a model change.
    { messageID: "a3", sessionID: "s1", providerID: "opencode", modelID: "m2", createdAt: BASE + 4 * MIN, streamedAt: BASE + 4 * MIN + 1_000, completedAt: BASE + 4 * MIN + 2_000, input: 800, cacheRead: 0, output: 100, cost: 0.03, upstream: "DeepSeek", router: "r2" },
    // Different provider, and a gap long enough to lose the cache.
    { messageID: "a4", sessionID: "s1", providerID: "anthropic", modelID: "m2", createdAt: BASE + 60 * MIN, streamedAt: BASE + 60 * MIN + 1_000, completedAt: BASE + 60 * MIN + 2_000, input: 2_000, cacheRead: 0, output: 400, cost: 0.04, upstream: "AWS Bedrock", router: "r3" },
    // A second session, same model, cache kept across a ten-minute gap.
    { messageID: "b1", sessionID: "s2", providerID: "opencode", modelID: "m1", createdAt: BASE + 5 * MIN, streamedAt: BASE + 5 * MIN + 500, completedAt: BASE + 5 * MIN + 1_000, input: 400, cacheRead: 50_000, output: 100, cost: 0.005, upstream: "Fireworks", router: "r1" },
    { messageID: "b2", sessionID: "s2", providerID: "opencode", modelID: "m1", createdAt: BASE + 15 * MIN, streamedAt: BASE + 15 * MIN + 500, completedAt: BASE + 15 * MIN + 1_000, input: 500, cacheRead: 49_800, output: 120, cost: 0.006, upstream: "Fireworks", router: "r1" },
  ]
  for (const step of steps) recordStep(db, step)
  return db
}

describe("stepFacts", () => {
  test("orders by session and time and reports the naming both sides use", () => {
    const db = seed()
    const facts = stepFacts(db)
    expect(facts.map((fact) => fact.messageID)).toEqual(["a1", "a2", "a3", "a4", "b1", "b2"])
    expect(facts[0]!.operator).toBe("Fireworks")
    expect(facts[0]!.router).toBe("r1")
    db.close()
  })

  test("filters narrow to one endpoint or one model", () => {
    const db = seed()
    expect(stepFacts(db, { filters: { router: "r1" } }).map((fact) => fact.messageID)).toEqual(["a1", "b1", "b2"])
    expect(stepFacts(db, { filters: { modelID: "m2" } }).map((fact) => fact.messageID)).toEqual(["a3", "a4"])
    db.close()
  })

  test("withPredecessor loads the step before the range, so a pair is comparable", () => {
    const db = seed()
    const bounded = stepFacts(db, { range: { from: BASE + 3 * MIN } })
    expect(bounded.map((fact) => fact.messageID)).toEqual(["a2", "a3", "a4", "b1", "b2"])
    const withbefore = stepFacts(db, { range: { from: BASE + 3 * MIN }, withPredecessor: true })
    expect(withbefore[0]!.messageID).toBe("a1")
    db.close()
  })

  test("keeps the raw usage of the range when filtering", () => {
    const db = seed()
    const facts = stepFacts(db, { filters: { modelID: "m1" } })
    expect(facts).toHaveLength(4)
    expect(facts.reduce((sum, fact) => sum + fact.cached, 0)).toBe(289_800)
    db.close()
  })
})

describe("stepPairs", () => {
  test("pairs only consecutive steps of the same session", () => {
    const db = seed()
    const pairs = stepPairs(stepFacts(db))
    expect(pairs.map((pair) => `${pair.previous.messageID}->${pair.current.messageID}`)).toEqual(["a1->a2", "a2->a3", "a3->a4", "b1->b2"])
    db.close()
  })
})

describe("cacheStats", () => {
  test("weighs the hit by tokens and reports the per-step median", () => {
    const db = seed()
    const stats = cacheStats(stepFacts(db, { filters: { modelID: "m1" } }))
    // prompt = cached + input + write over the four m1 steps.
    const prompt = 100_000 + 1_000 + 500 + 90_000 + 1_200 + 50_000 + 400 + 49_800 + 500
    expect(stats.cached).toBe(289_800)
    expect(stats.prompt).toBe(prompt)
    expect(stats.hit).toBeCloseTo(289_800 / prompt, 6)
    // Medians of [0.985, 0.987, 0.992, 0.990] stay in the high nineties.
    expect(stats.hitP50).toBeGreaterThan(0.98)
    expect(stats.hitP50).toBeLessThan(0.995)
    db.close()
  })

  test("has no ratio without a prompt", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "z1", sessionID: "s", modelID: "m", createdAt: BASE, completedAt: BASE + 1 })
    const stats = cacheStats(stepFacts(db))
    expect(stats.hit).toBeUndefined()
    expect(stats.hitP50).toBeUndefined()
    db.close()
  })
})

describe("endpointBreakdown", () => {
  test("splits a model by the endpoint that served it, with its share", () => {
    const db = seed()
    const rows = endpointBreakdown(stepFacts(db))
    const m1 = rows.filter((row) => row.modelID === "m1")
    expect(m1).toHaveLength(2)
    expect(m1.find((row) => row.endpoint === "r1")!.usage.steps).toBe(3)
    expect(m1.find((row) => row.endpoint === "r1")!.share).toBeCloseTo(3 / 4, 6)
    expect(m1.find((row) => row.endpoint === "r2")!.usage.steps).toBe(1)
    expect(rows[0]!.usage.steps).toBeGreaterThanOrEqual(rows[rows.length - 1]!.usage.steps)
    db.close()
  })

  test("carries the throughput and wall time of the group", () => {
    const db = seed()
    const row = endpointBreakdown(stepFacts(db)).find((entry) => entry.endpoint === "r1" && entry.modelID === "m1")!
    // 200, 200 and 240 produced tokens per second: the median is 200.
    expect(row.tps).toBeCloseTo(200, 6)
    // Wall times of 2s, 1s and 1s: the median is 1s.
    expect(row.wall).toBe(1_000)
    db.close()
  })

  test("keeps requests whose endpoint was never observed apart", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "x1", sessionID: "s", modelID: "m", createdAt: BASE, completedAt: BASE + 1 })
    const rows = endpointBreakdown(stepFacts(db))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.endpoint).toBeUndefined()
    db.close()
  })
})

describe("endpointSummary", () => {
  test("aggregates every model an endpoint served", () => {
    const db = seed()
    const rows = endpointSummary(stepFacts(db))
    const r1 = rows.find((row) => row.endpoint === "r1")!
    // r1 served m1 from two sessions.
    expect(r1.usage.steps).toBe(3)
    expect(r1.models).toEqual(["m1"])
    expect(rows.find((row) => row.endpoint === "r2")!.models.sort()).toEqual(["m1", "m2"])
    expect(rows.map((row) => row.usage.steps)).toEqual([...rows.map((row) => row.usage.steps)].sort((a, b) => b - a))
    db.close()
  })
})

describe("affinityReport", () => {
  test("counts each dimension and the cache a change actually cost", () => {
    const db = seed()
    const report = affinityReport(stepFacts(db))
    const m1 = report.rows.find((row) => row.modelID === "m1")!
    // m1 pairs: a1->a2 (endpoint), b1->b2 (nothing).
    expect(m1.pairs).toBe(2)
    expect(m1.endpointChanges).toBe(1)
    expect(m1.changes).toBe(1)
    expect(m1.cacheLost).toBe(10_000)
    const m2 = report.rows.find((row) => row.modelID === "m2")!
    // m2 pairs: a2->a3 (a model change) and a3->a4 (an endpoint change).
    expect(m2.modelChanges).toBe(1)
    expect(m2.endpointChanges).toBe(1)
    expect(m2.changes).toBe(2)
    browser: {
      // A model change has no comparable cache, so nothing is reported as lost.
      expect(m2.cacheLost).toBe(0)
    }
    expect(report.totals.pairs).toBe(4)
    expect(report.totals.changes).toBe(3)
    db.close()
  })

  test("lists the transitions, most frequent first", () => {
    const db = seed()
    const report = affinityReport(stepFacts(db))
    expect(report.transitions.map((entry) => `${entry.dimension}:${entry.from}->${entry.to}`)).toContain("endpoint:r1->r2")
    expect(report.transitions.map((entry) => `${entry.dimension}:${entry.from}->${entry.to}`)).toContain("model:m1->m2")
    db.close()
  })
})

describe("gapReport", () => {
  test("buckets reuse against the idle gap", () => {
    const db = seed()
    const report = gapReport(stepFacts(db))
    // Comparable pairs: a1->a2 (3m), b1->b2 (10m), a3->a4 (56m, provider change
    // but the same model, so the cache rule still applies).
    expect(report.samples).toBe(3)
    const buckets = report.buckets.filter((bucket) => bucket.samples > 0)
    expect(buckets.map((bucket) => bucket.label)).toEqual(["1–5m", "5–15m", "15–60m"])
    expect(buckets[0]!.drops).toBe(1)
    expect(buckets[0]!.lostTokens).toBe(10_000)
    expect(buckets[0]!.retainedRatio).toBe(0)
    expect(buckets[1]!.lostTokens).toBe(200)
    expect(buckets[2]!.retainedRatio).toBe(1)
    db.close()
  })

  test("summarises reuse per endpoint", () => {
    const db = seed()
    const report = gapReport(stepFacts(db))
    // The pair is attributed to the endpoint that served the second request.
    const r1 = report.endpoints.find((row) => row.endpoint === "r1")!
    expect(r1.samples).toBe(1)
    expect(r1.retained).toBe(0)
    expect(r1.lostTokens).toBe(200)
    expect(report.endpoints.find((row) => row.endpoint === "r2")!.lostTokens).toBe(10_000)
    db.close()
  })

  test("leaves steps without a comparable neighbour out", () => {
    const db = seed()
    const report = gapReport(stepFacts(db, { filters: { router: "r3" } }))
    expect(report.samples).toBe(0)
    db.close()
  })
})

describe("periodReport", () => {
  test("buckets by local day, week and month, oldest first", () => {
    const db = seed()
    const facts = stepFacts(db)
    const days = periodReport(facts, "day")
    expect(days).toHaveLength(1)
    expect(days[0]!.steps).toBe(6)
    expect(days[0]!.sessions).toBe(2)
    const months = periodReport(facts, "month")
    expect(months).toHaveLength(1)
    expect(months[0]!.key).toBe(periodStart(BASE, "month").key)
    expect(periodReport(facts, "week")[0]!.key).toBe(periodStart(BASE, "week").key)
    db.close()
  })

  test("splits across midnight in local time", () => {
    const db = openStatsDb(":memory:")
    const midnight = new Date(BASE)
    midnight.setHours(0, 0, 0, 0)
    const before = midnight.getTime() - MIN
    const after = midnight.getTime() + MIN
    recordStep(db, { messageID: "n1", sessionID: "s", modelID: "m", createdAt: before, completedAt: before + 1 })
    recordStep(db, { messageID: "n2", sessionID: "s", modelID: "m", createdAt: after, completedAt: after + 1 })
    const days = periodReport(stepFacts(db), "day")
    expect(days).toHaveLength(2)
    expect(days[0]!.at).toBeLessThan(days[1]!.at)
    db.close()
  })

  test("computes ISO weeks with their Monday", () => {
    const date = new Date(2026, 0, 1) // a Thursday
    const week = isoWeek(date)
    expect(week.week).toBe(1)
    expect(week.monday.getDay()).toBe(1)
    expect(week.monday.getFullYear()).toBe(2025)
  })
})

describe("latencyGroups", () => {
  test("groups percentiles by model, provider or operator", () => {
    const db = seed()
    const facts = stepFacts(db)
    const byModel = latencyGroups(facts, "model")
    const m1 = byModel.find((row) => row.key === modelKey("m1", undefined))!
    expect(m1.count).toBe(4)
    expect(m1.tps.p50).toBeGreaterThan(0)
    expect(byModel.find((row) => row.key === modelKey("m2", undefined))!.count).toBe(2)
    const byOperator = latencyGroups(facts, "operator")
    expect(byOperator.map((row) => row.key)).toContain("AWS Bedrock")
    const byProvider = latencyGroups(facts, "provider")
    expect(byProvider.map((row) => row.key).sort()).toEqual(["anthropic", "opencode"])
    db.close()
  })
})

describe("coverageReport", () => {
  test("counts what the panel cannot answer", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "c1", sessionID: "s", providerID: "p", modelID: "m", upstream: "DeepSeek", router: "r", createdAt: BASE, completedAt: BASE + 1 })
    recordStep(db, { messageID: "c2", sessionID: "s", createdAt: BASE + 2 })
    const coverage = coverageReport(stepFacts(db))
    expect(coverage.steps).toBe(2)
    expect(coverage.missingModel).toBe(1)
    expect(coverage.missingEndpoint).toBe(1)
    expect(coverage.unsettled).toBe(1)
    expect(coverage.models).toBe(1)
    expect(coverage.firstAt).toBe(BASE)
    expect(coverage.lastAt).toBe(BASE + 2)
    db.close()
  })
})

describe("filterOptions", () => {
  test("lists the observed values, most used first", () => {
    const db = seed()
    const options = filterOptions(db)
    expect(options.models[0]!.value).toBe("m1")
    expect(options.models[0]!.steps).toBe(4)
    // The endpoint is the identity that served the request, so it is filterable too.
    expect(options.endpoints.map((entry) => entry.value).sort()).toEqual(["r1", "r2", "r3"])
    db.close()
  })
})

describe("groupBy", () => {
  test("keeps the insertion order of the keys", () => {
    const groups = groupBy([1, 2, 3, 4], (value) => value % 2)
    expect([...groups.keys()]).toEqual([1, 0])
    expect(groups.get(0)).toEqual([2, 4])
  })
})
