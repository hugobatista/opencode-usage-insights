/**
 * The seeded throwaway database both documentation CLIs render from.
 *
 * `scripts/demo.ts` prints the telemetry line and every panel view as plain
 * text; `scripts/screenshot.ts` renders the same content into images. One seed
 * keeps the two outputs — and every number quoted in the docs — honest.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import type { Totals } from "../src/core"
import type { RuntimeMessage, RuntimeModelRef, RuntimeTokenUsage } from "../src/line"
import { openStatsDb, recordPrompt, recordStep, upsertSession } from "../src/stats/db"

/** Monday 12 October 2026, 08:00 UTC — the clock the demo data is built on. */
const BASE = Date.UTC(2026, 9, 12, 8, 0, 0)

/** A time on the demo clock, in the machine's local zone when rendered. */
export const demoAt = (hours: number, minutes = 0): number => BASE + (hours * 60 + minutes) * 60 * 1000

/** How many turns the demo sidebar history shows. */
export const DEMO_SIDEBAR_TURNS = 3

/** The session the demo panels open on. */
export const DEMO_SESSION_ID = "ses_recorder"

/** The seeded database, where it lives, and when the demo "now" is. */
export type DemoDatabase = { db: Database; root: string; path: string; now: number }

/** Open a throwaway database with the sessions, prompts and steps of the demo. */
export function openDemoDatabase(): DemoDatabase {
  const root = mkdtempSync(join(tmpdir(), "usage-insights-demo-"))
  const path = join(root, "usage.db")
  const db = openStatsDb(path)
  const at = demoAt

  upsertSession(db, { sessionID: "ses_recorder", directory: "/code/opencode-usage-insights", title: "Refactor the recorder", startedAt: at(0) })
  upsertSession(db, { sessionID: "ses_cache", directory: "/code/opencode-usage-insights", title: "Fix the cache regression", startedAt: at(30) })
  upsertSession(db, { sessionID: "ses_docs", directory: "/code/opencode-usage-insights", title: "Docs pass", startedAt: at(70) })

  const steps = [
    { sessionID: "ses_recorder", messageID: "msg_r1", promptID: "prt_r1", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", input: 84_200, cacheRead: 1_530_000, cacheWrite: 12_000, output: 3_700, cost: 0.21, started: at(0, 1), streamed: at(0, 1) + 1_400, completed: at(0, 1) + 52_000, finish: "tool-calls" },
    { sessionID: "ses_recorder", messageID: "msg_r2", promptID: "prt_r2", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", input: 9_400, cacheRead: 1_614_000, cacheWrite: 900, output: 1_250, cost: 0.06, started: at(0, 24), streamed: at(0, 24) + 900, completed: at(0, 24) + 20_000, samePrompt: true },
    { sessionID: "ses_recorder", messageID: "msg_r3", promptID: "prt_r3", providerID: "anthropic", modelID: "claude-opus-4.6", input: 12_800, cacheRead: 96_000, cacheWrite: 11_000, output: 2_400, reasoning: 900, cost: 1.42, started: at(0, 41), streamed: at(0, 41) + 2_800, completed: at(0, 41) + 74_000 },
    { sessionID: "ses_cache", messageID: "msg_c1", promptID: "prt_c1", providerID: "opencode", modelID: "glm-5.3-flash", input: 41_000, cacheRead: 620_000, cacheWrite: 8_000, output: 5_100, cost: 0.32, started: at(30, 2), streamed: at(30, 2) + 1_100, completed: at(30, 2) + 61_000 },
    { sessionID: "ses_cache", messageID: "msg_c2", promptID: "prt_c2", providerID: "opencode", modelID: "glm-5.3-flash", input: 63_700, cacheRead: 12_400, cacheWrite: 9_000, output: 4_800, cost: 0.44, started: at(54, 0), streamed: at(54, 0) + 1_600, completed: at(54, 0) + 58_000 },
    { sessionID: "ses_docs", messageID: "msg_d1", promptID: "prt_d1", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", input: 22_500, cacheRead: 310_000, cacheWrite: 4_000, output: 6_300, cost: 0.18, started: at(70, 0), streamed: at(70, 0) + 1_200, completed: at(70, 0) + 88_000 },
    { sessionID: "ses_docs", messageID: "msg_d2", promptID: "prt_d2", providerID: "opencode-go", modelID: "deepseek-v4.1-flash", input: 7_900, cacheRead: 402_000, cacheWrite: 700, output: 2_100, cost: 0.07, started: at(70, 20), streamed: at(70, 20) + 800, completed: at(70, 20) + 31_000 },
  ]

  for (const step of steps) {
    if (step.samePrompt !== true) recordPrompt(db, { sessionID: step.sessionID, messageID: step.promptID, createdAt: step.started - 20_000 })
    recordStep(db, {
      messageID: step.messageID,
      sessionID: step.sessionID,
      providerID: step.providerID,
      modelID: step.modelID,
      input: step.input,
      cacheRead: step.cacheRead,
      cacheWrite: step.cacheWrite,
      output: step.output,
      reasoning: step.reasoning ?? 0,
      cost: step.cost,
      createdAt: step.started,
      streamedAt: step.streamed,
      completedAt: step.completed,
      finish: step.finish ?? "stop",
      recordedAt: step.completed,
    })
  }

  return { db, root, path, now: at(90) }
}

const prompt = (id: string, created: number): RuntimeMessage => ({ id, type: "user", time: { created } })

const assistant = (
  id: string,
  model: RuntimeModelRef,
  tokens: RuntimeTokenUsage,
  created: number,
  streamed: number,
  completed: number,
  cost = 0,
): RuntimeMessage => ({
  id,
  type: "assistant",
  model,
  tokens,
  cost,
  time: { created, streamed, completed },
})

const DEEPSEEK: RuntimeModelRef = { providerID: "opencode", id: "deepseek-v4.1-flash-free" }
const OPUS: RuntimeModelRef = { providerID: "anthropic", id: "claude-opus-4.6" }
const GLM: RuntimeModelRef = { providerID: "opencode", id: "glm-5.3-flash" }
const at = demoAt

export const recorderTurn1 = [prompt("prt_r1", at(0, 0)), assistant("msg_r1", DEEPSEEK, { input: 84_200, output: 3_700, cache: { read: 1_530_000 } }, at(0, 1), at(0, 3), at(0, 9), 0.21)]
export const recorderTurn2 = [prompt("prt_r2", at(0, 24)), assistant("msg_r2", DEEPSEEK, { input: 9_400, output: 1_250, cache: { read: 1_614_000 } }, at(0, 24), at(0, 25), at(0, 29), 0.06)]
export const recorderTurn3 = [prompt("prt_r3", at(0, 41)), assistant("msg_r3", OPUS, { input: 12_800, output: 2_400, reasoning: 900, cache: { read: 96_000 } }, at(0, 41), at(0, 44), at(0, 52), 1.42)]
export const cacheTurn1 = [prompt("prt_c1", at(30, 0)), assistant("msg_c1", GLM, { input: 41_000, output: 5_100, cache: { read: 620_000 } }, at(30, 2), at(30, 4), at(30, 14), 0.32)]
export const cacheTurn2 = [prompt("prt_c2", at(54, 0)), assistant("msg_c2", GLM, { input: 63_700, output: 4_800, cache: { read: 12_400 } }, at(54, 0), at(54, 2), at(54, 9), 0.44)]

/** One turn with three steps (a tool-call loop), from a live recording. */
export const loopTurn: RuntimeMessage[] = [
  prompt("prt_loop", at(60, 0)),
  assistant("msg_l1", DEEPSEEK, { input: 924, output: 242, cache: { read: 290_048 } }, at(60, 1), at(60, 3), at(60, 9), 0.03),
  assistant("msg_l2", DEEPSEEK, { input: 723, output: 148, reasoning: 351, cache: { read: 290_944 } }, at(60, 10), at(60, 12), at(60, 18), 0.02),
  assistant("msg_l3", DEEPSEEK, { input: 1_020, output: 463, reasoning: 1_030, cache: { read: 291_584 } }, at(60, 19), at(60, 21), at(60, 27), 0.04),
]

/** A response that has started streaming: no completion time, no final tokens. */
export const liveTurn: RuntimeMessage[] = [
  prompt("prt_live", at(84, 0)),
  { id: "msg_live", type: "assistant", model: DEEPSEEK, tokens: { input: 0, output: 0, cache: { read: 0 } }, time: { created: at(84, 1), streamed: at(84, 2) } },
]

/** Host session totals for the two recorder turns, as the TUI reads them. */
export const recorderTotals: Totals = { input: 106_400, cached: 2_890_000, output: 6_100, reasoning: 900, cacheWrite: 700, cost: 0.27, steps: 2 }
/**
 * The same session once the third turn (the opus one) has finished: the turn
 * cost more than the session had spent before it, so a line that shows both
 * numbers needs the totals that include it.
 */
export const recorderTotalsAfterOpus: Totals = {
  input: 106_400,
  cached: 3_240_000,
  output: 7_350,
  reasoning: 900,
  cacheWrite: 23_900,
  cost: 1.69,
  steps: 3,
}
/** Host session totals for the two cache turns. */
export const cacheTotals: Totals = { input: 104_700, cached: 632_400, output: 9_900, reasoning: 0, cacheWrite: 17_000, cost: 0.76, steps: 1 }
