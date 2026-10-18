import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { cacheDrop, stepGap, type AssistantMessage } from "../src/core"
import { openStatsDb, recordEvent, recordStep, upsertSession, type StepRecord } from "../src/stats/db"
import {
  switchesOf,
  stepRows,
  cacheDropsOf,
  cachePairs,
  cacheStatsOf,
  coverageOf,
  providerBreakdownOf,
  providerSummaryOf,
  GAP_BUCKETS,
  gapReportOf,
  isoWeek,
  latencyGroupsOf,
  latencyOf,
  periodStart,
  periodsOf,
  ttlEvidenceOf,
} from "../src/stats/aggregates"
import { filterOptions, modelKey, percentile } from "../src/stats/queries"

/**
 * What the analysis layer answers, on a database with every awkward case in it:
 * a variant of a family, a model served by two providers, a closed range, a
 * compaction, and a cache that survives one gap and not another.
 *
 * The pair rules are the ones `core.ts` defines for the live line — `cacheDrop`
 * and `stepGap`. The SQL restates them, so the expectations here are derived
 * from those functions over the same rows: if the two ever drift apart, this
 * file fails.
 */

const MIN = 60_000
const BASE = 1_800_000_000_000

const STEPS: StepRecord[] = [
  { messageID: "a1", sessionID: "s1", providerID: "opencode", modelID: "m1", createdAt: BASE, streamedAt: BASE + 300, completedAt: BASE + 1_000, input: 1_000, cacheRead: 100_000, cacheWrite: 500, output: 200, cost: 0.01, finish: "stop" },
  { messageID: "a2", sessionID: "s1", providerID: "opencode-go", modelID: "m1", createdAt: BASE + 3 * MIN, streamedAt: BASE + 3 * MIN + 200, completedAt: BASE + 3 * MIN + 1_000, input: 1_200, cacheRead: 90_000, output: 300, cost: 0.02, finish: "stop" },
  { messageID: "a3", sessionID: "s1", providerID: "opencode-go", modelID: "m2", createdAt: BASE + 4 * MIN, streamedAt: BASE + 4 * MIN + 400, completedAt: BASE + 4 * MIN + 2_000, input: 800, cacheRead: 0, output: 100, cost: 0.03, finish: "stop" },
  { messageID: "a4", sessionID: "s1", providerID: "anthropic", modelID: "m2", createdAt: BASE + 60 * MIN, streamedAt: BASE + 60 * MIN + 1_000, completedAt: BASE + 60 * MIN + 2_000, input: 2_000, cacheRead: 0, output: 400, cost: 0.04, finish: "stop" },
  { messageID: "b1", sessionID: "s2", providerID: "opencode", modelID: "m1", createdAt: BASE + 5 * MIN, streamedAt: BASE + 5 * MIN + 300, completedAt: BASE + 5 * MIN + 1_000, input: 400, cacheRead: 50_000, output: 100, cost: 0.005, finish: "stop" },
  { messageID: "b2", sessionID: "s2", providerID: "opencode", modelID: "m1", createdAt: BASE + 15 * MIN, streamedAt: BASE + 15 * MIN + 200, completedAt: BASE + 15 * MIN + 1_000, input: 500, cacheRead: 49_800, output: 120, cost: 0.006, finish: "stop" },
]

function seed(): Database {
  const db = openStatsDb(":memory:")
  upsertSession(db, { sessionID: "s1", title: "One", directory: "/code/one", startedAt: BASE })
  upsertSession(db, { sessionID: "s2", title: "Two", directory: "/code/two", startedAt: BASE })
  for (const step of STEPS) recordStep(db, step)
  return db
}

/** A recorded step in the shape the pair rules are written against. */
function message(step: StepRecord): AssistantMessage {
  return {
    type: "assistant",
    id: step.messageID,
    model: { providerID: step.providerID ?? "", id: step.modelID ?? "", ...(step.variant === undefined ? {} : { variant: step.variant }) },
    tokens: { cache: { read: step.cacheRead ?? 0 } },
    time: {
      ...(step.createdAt === undefined ? {} : { created: step.createdAt }),
      ...(step.streamedAt === undefined ? {} : { streamed: step.streamedAt }),
      ...(step.completedAt === undefined ? {} : { completed: step.completedAt }),
    },
    finish: step.finish ?? undefined,
  }
}

/** The consecutive pairs of each session, in order: what every pair report sees. */
function pairs(
  steps: readonly StepRecord[] = STEPS,
): Array<{ previous: StepRecord; current: StepRecord; gap: number | undefined; lost: number | undefined; lostProvider: number | undefined }> {
  const bySession = new Map<string, StepRecord[]>()
  for (const step of steps) {
    const list = bySession.get(step.sessionID)
    if (list === undefined) bySession.set(step.sessionID, [step])
    else list.push(step)
  }
  const out: Array<{ previous: StepRecord; current: StepRecord; gap: number | undefined; lost: number | undefined; lostProvider: number | undefined }> = []
  for (const list of bySession.values()) {
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1]!
      const current = list[index]!
      out.push({
        previous,
        current,
        gap: stepGap(message(previous), message(current)),
        // The model scope: what the switch and loss reports measure, because
        // a provider switch forfeits the cache the previous provider held.
        lost: cacheDrop(message(previous), message(current), "model"),
        // The provider scope: two providers are two caches, which is what a
        // cache-survival sample requires.
        lostProvider: cacheDrop(message(previous), message(current)),
      })
    }
  }
  return out
}

describe("coverage", () => {
  test("counts what the panel cannot answer", () => {
    const db = seed()
    expect(coverageOf(db)).toEqual({
      steps: 6,
      models: 2,
      providers: 3,
      missingModel: 0,
      unsettled: 0,
      missingTps: 0,
      firstAt: BASE,
      lastAt: BASE + 60 * MIN,
    })
    db.close()
  })

  test("counts a missing model, provider, completion and throughput", () => {
    const db = seed()
    recordStep(db, { messageID: "n1", sessionID: "s2", createdAt: BASE + 70 * MIN, input: 10, output: 0, recordedAt: BASE + 70 * MIN })
    expect(coverageOf(db)).toMatchObject({ steps: 7, providers: 3, missingModel: 1, unsettled: 1, missingTps: 1 })
    db.close()
  })

  test("a model key narrows to one variant of a family", () => {
    const db = seed()
    recordStep(db, { messageID: "v1", sessionID: "s1", providerID: "opencode", modelID: "m1", variant: "max", createdAt: BASE + 80 * MIN, recordedAt: BASE + 80 * MIN })
    expect(coverageOf(db, { filters: { modelKey: modelKey("m1", "max") } })).toMatchObject({ steps: 1, models: 1 })
    expect(coverageOf(db, { filters: { modelID: "m1" } }).steps).toBe(5)
    expect(coverageOf(db, { filters: { modelID: "m1", modelKey: modelKey("m1", "max") } }).steps).toBe(1)
    db.close()
  })
})

describe("cache stats", () => {
  test("weighs the hit by tokens and reports the per-step median", () => {
    const db = seed()
    const stats = cacheStatsOf(db)
    expect(stats.steps).toBe(6)
    expect(stats.prompt).toBe(stats.input + stats.cached + stats.cacheWrite)
    expect(stats.hit).toBeCloseTo(stats.cached / stats.prompt, 12)
    const ratios = STEPS.map((step) => (step.cacheRead ?? 0) / ((step.input ?? 0) + (step.cacheRead ?? 0) + (step.cacheWrite ?? 0)))
    expect(stats.hitP50).toBeCloseTo(percentile(ratios, 50)!, 12)
    db.close()
  })

  test("has no ratio without a prompt", () => {
    const db = openStatsDb(":memory:")
    recordStep(db, { messageID: "e1", sessionID: "s", providerID: "opencode", modelID: "m", input: 0, cacheRead: 0, cacheWrite: 0, recordedAt: BASE })
    const stats = cacheStatsOf(db)
    expect(stats.hit).toBeUndefined()
    expect(stats.hitP50).toBeUndefined()
    db.close()
  })
})

describe("switches", () => {
  test("counts each dimension, as the pair rules see it", () => {
    const db = seed()
    const report = switchesOf(cachePairs(db))
    const expected = pairs().filter((pair) => pair.previous.modelID !== undefined && pair.current.modelID !== undefined)
    const changes = expected.filter((pair) => {
      const modelChanged = modelKey(pair.previous.modelID!, pair.previous.variant) !== modelKey(pair.current.modelID!, pair.current.variant)
      const providerChanged = pair.previous.providerID !== undefined && pair.current.providerID !== undefined && pair.previous.providerID !== pair.current.providerID
      return modelChanged || providerChanged
    })
    expect(report.totals.pairs).toBe(expected.length)
    expect(report.totals.changes).toBe(changes.length)
    // The cost rule: the model is the same, so the two steps share a cache to
    // lose, whichever provider served them.
    const lost = changes.filter(
      (pair) => modelKey(pair.previous.modelID!, pair.previous.variant) === modelKey(pair.current.modelID!, pair.current.variant) && (pair.lost ?? 0) > 0,
    )
    expect(report.totals.cacheLost).toBe(lost.reduce((sum, pair) => sum + (pair.lost ?? 0), 0))
    expect(report.totals.cacheLostEvents).toBe(lost.length)
    // The m1 family switched provider once (a1 → a2), losing the cache it held.
    const m1 = report.rows.find((row) => row.modelID === "m1")!
    expect(m1).toMatchObject({ steps: 2, pairs: 2, changes: 1, modelChanges: 0, providerChanges: 1, cacheLost: 10_000, cacheLostEvents: 1 })
    const m2 = report.rows.find((row) => row.modelID === "m2")!
    expect(m2).toMatchObject({ steps: 2, pairs: 2, changes: 2, modelChanges: 1, providerChanges: 1, cacheLost: 0 })
    // No transition list: the rows are the whole report.
    expect(Object.keys(report).sort()).toEqual(["rows", "totals"])
    db.close()
  })
})

describe("cache survival", () => {
  /** The bucket the rule puts a gap in. */
  const bucketOf = (gap: number) => GAP_BUCKETS.findIndex(([, from, to]) => gap >= from && (to === undefined || gap < to))

  test("buckets reuse against the idle gap, as the pair rules see it", () => {
    const db = seed()
    const report = gapReportOf(cachePairs(db))
    const comparable = pairs().filter(
      (pair) =>
        pair.previous.modelID !== undefined &&
        pair.current.modelID !== undefined &&
        pair.previous.providerID === pair.current.providerID &&
        modelKey(pair.previous.modelID, pair.previous.variant) === modelKey(pair.current.modelID, pair.current.variant) &&
        pair.gap !== undefined,
    )
    expect(report.samples).toBe(comparable.length)
    for (const [index, [label]] of GAP_BUCKETS.entries()) {
      const inBucket = comparable.filter((pair) => bucketOf(pair.gap!) === index)
      const bucket = report.buckets.find((entry) => entry.label === label)!
      expect({ label, samples: bucket.samples, drops: bucket.drops }).toEqual({
        label,
        samples: inBucket.length,
        drops: inBucket.filter((pair) => pair.lostProvider !== undefined).length,
      })
    }
    db.close()
  })

  test("summarises reuse per provider", () => {
    const db = seed()
    const comparable = pairs().filter(
      (pair) =>
        pair.previous.modelID !== undefined &&
        pair.current.modelID !== undefined &&
        pair.previous.providerID === pair.current.providerID &&
        modelKey(pair.previous.modelID, pair.previous.variant) === modelKey(pair.current.modelID, pair.current.variant) &&
        pair.gap !== undefined,
    )
    const rows = gapReportOf(cachePairs(db)).providers
    for (const row of rows) {
      const provider = row.provider
      const inProvider = comparable.filter((pair) => (pair.current.providerID ?? pair.previous.providerID ?? "(unknown)") === provider)
      expect({ provider, samples: row.samples, retained: row.retained, drops: row.drops }).toEqual({
        provider,
        samples: inProvider.length,
        retained: inProvider.filter((pair) => pair.lostProvider === undefined).length,
        drops: inProvider.filter((pair) => pair.lostProvider !== undefined).length,
      })
    }
    db.close()
  })

  test("bounds the TTL from the observations", () => {
    const db = seed()
    const evidence = ttlEvidenceOf(cachePairs(db))
    expect(evidence).toHaveLength(1)
    const m1 = evidence[0]!
    const comparable = pairs().filter(
      (pair) =>
        pair.previous.modelID !== undefined &&
        pair.current.modelID !== undefined &&
        message(pair.previous).model!.providerID === message(pair.current).model!.providerID &&
        message(pair.previous).model!.id === message(pair.current).model!.id,
    )
    expect(m1).toEqual({
      providerID: "opencode",
      modelID: "m1",
      samples: comparable.length,
      maxHitGapMs: undefined,
      minDropGapMs: Math.min(...comparable.filter((pair) => pair.lostProvider !== undefined).map((pair) => pair.gap!)),
    })
    db.close()
  })

  test("names the losses, with their reasons and reference tokens", () => {
    const db = seed()
    const losses = pairs().filter((pair) => pair.lost !== undefined)
    const rows = cacheDropsOf(db, cachePairs(db))
    expect(rows.map((row) => [row.messageID, row.tokens, row.gapMs, row.prevCached, row.reason])).toEqual(
      losses.map((pair) => [pair.current.messageID, pair.lost, pair.gap, pair.previous.cacheRead, "unknown"]),
    )
    db.close()
  })

  test("names a loss after a compaction a compaction", () => {
    const db = seed()
    recordEvent(db, { sessionID: "s2", kind: "compaction", at: BASE + 10 * MIN })
    // A compaction outside the pair's window explains nothing: a2 keeps its
    // unknown, even though the session had one later.
    recordEvent(db, { sessionID: "s1", kind: "compaction", at: BASE + 30 * MIN })
    const rows = cacheDropsOf(db, cachePairs(db))
    expect(rows.find((row) => row.sessionID === "s2")).toMatchObject({ reason: "compaction" })
    expect(rows.find((row) => row.sessionID === "s1")).toMatchObject({ reason: "unknown" })
    // A short TTL hint turns a long gap into an expiry — unless a compaction
    // happened in between, which is the stronger explanation.
    expect(cacheDropsOf(db, cachePairs(db), { ttlHintMs: 100_000 }).find((row) => row.sessionID === "s2")).toMatchObject({ reason: "compaction" })
    expect(cacheDropsOf(db, cachePairs(db), { ttlHintMs: 100_000 }).find((row) => row.sessionID === "s1")).toMatchObject({ reason: "expired" })
    db.close()
  })

  test("respects the range on the loss itself", () => {
    const db = seed()
    expect(cacheDropsOf(db, cachePairs(db, { range: { from: BASE + 4 * MIN, to: BASE + 20 * MIN } })).map((row) => row.messageID)).toEqual(["b2"])
    db.close()
  })

  test("loads the step before the range, so the first step is comparable", () => {
    const db = seed()
    // From a2 onwards: the loss at a2 is only visible because a1 is loaded.
    expect(cacheDropsOf(db, cachePairs(db, { range: { from: BASE + 3 * MIN } })).map((row) => row.messageID)).toContain("a2")
    db.close()
  })
})

describe("providers", () => {
  test("splits a model by the provider it ran through, with its share", () => {
    const db = seed()
    const rows = providerBreakdownOf(stepRows(db))
    // m1 ran four times: a1, b1 and b2 through opencode, a2 through opencode-go.
    expect(rows.map((row) => [row.modelID, row.provider, row.usage.steps, row.share])).toEqual([
      ["m1", "opencode", 3, 0.75],
      ["m1", "opencode-go", 1, 0.25],
      ["m2", "opencode-go", 1, 0.5],
      ["m2", "anthropic", 1, 0.5],
    ])
    // a1 + b1 + b2 read 199,800 from the cache through opencode.
    expect(rows.find((row) => row.modelID === "m1" && row.provider === "opencode")!.cache.cached).toBe(199_800)
    db.close()
  })

  test("names the model of each row the way the summary does", () => {
    const db = seed()
    recordStep(db, { messageID: "v1", sessionID: "s1", providerID: "opencode", modelID: "m1", variant: "max", createdAt: BASE + 80 * MIN, recordedAt: BASE + 80 * MIN })
    const rows = providerBreakdownOf(stepRows(db))
    // A row is one model, named as a label (`m1 max`) and never as its key.
    expect(rows.find((row) => row.variant === "max")!.models).toEqual(["m1 max"])
    expect(rows.every((row) => row.models.length === 1 && !row.models[0]!.includes("#"))).toBe(true)
    db.close()
  })

  test("aggregates every model a provider served", () => {
    const db = seed()
    const rows = providerSummaryOf(stepRows(db))
    const opencode = rows.find((row) => row.provider === "opencode")!
    expect(opencode.usage.steps).toBe(3)
    expect(opencode.share).toBe(0.5)
    expect(opencode.models).toEqual(["m1"])
    expect(rows.find((row) => row.provider === "anthropic")!.share).toBeCloseTo(1 / 6, 12)
    db.close()
  })
})

describe("periods", () => {
  test("buckets by local day, week and month, oldest first", () => {
    const db = seed()
    for (const granularity of ["day", "week", "month"] as const) {
      const rows = periodsOf(stepRows(db), granularity)
      expect(rows.reduce((sum, row) => sum + row.steps, 0)).toBe(6)
      expect(rows.reduce((sum, row) => sum + row.sessions, 0)).toBeGreaterThanOrEqual(2)
      expect(rows[0]!.at).toBe(periodStart(BASE, granularity).start)
      expect(rows[0]!.key).toBe(periodStart(BASE, granularity).key)
      expect([...rows].sort((left, right) => left.at - right.at)).toEqual(rows)
    }
    db.close()
  })

  test("counts distinct sessions per bucket", () => {
    const db = seed()
    const day = periodsOf(stepRows(db), "day")[0]!
    expect(day.sessions).toBe(2)
    expect(day.cache.steps).toBe(6)
    db.close()
  })

  test("computes ISO weeks with their Monday", () => {
    const monday = new Date(2026, 9, 12)
    const week = isoWeek(monday)
    expect(week.monday.getDay()).toBe(1)
    expect(periodStart(monday.getTime(), "week").start).toBe(week.monday.getTime())
    expect(periodStart(monday.getTime(), "week").label).toBe(`${week.year}-W${String(week.week).padStart(2, "0")}`)
  })
})

describe("latency", () => {
  test("groups percentiles by model or provider", () => {
    const db = seed()
    const byModel = latencyGroupsOf(stepRows(db), "model")
    const m1 = byModel.find((row) => row.label === "m1")!
    expect(m1.count).toBe(4)
    expect(m1.wall.count).toBe(4)
    expect(m1.wall.p50).toBe(1_000)
    expect(latencyGroupsOf(stepRows(db), "provider").map((row) => row.key).sort()).toEqual(["anthropic", "opencode", "opencode-go"])
    const overall = latencyOf(stepRows(db))
    expect(overall.wall.count).toBe(6)
    expect(overall.wall.p50).toBe(1_000)
    expect(overall.tps.count).toBe(6)
    db.close()
  })
})

describe("filters", () => {
  test("lists the observed values, most used first", () => {
    const db = seed()
    expect(filterOptions(db).models).toEqual([
      { value: "m1", steps: 4 },
      { value: "m2", steps: 2 },
    ])
    expect(filterOptions(db).providers.map((option) => option.value)).toEqual(["opencode", "opencode-go", "anthropic"])
    db.close()
  })
})
