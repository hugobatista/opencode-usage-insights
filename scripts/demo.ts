/**
 * Print the telemetry line and every panel view as plain text, from a seeded
 * throwaway database. Handy for reviewing the output and for the README.
 *
 *   bun run demo [width]
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeTurn, formatLine, type LineIdentity, type Totals, type TurnTotalsView } from "../src/core"
import { sessionTotals, toTranscript, type RuntimeMessage, type RuntimeModelRef, type RuntimeTokenUsage } from "../src/line"
import { buildPanel, type PanelRequest } from "../src/panel-build"
import { PANEL_VIEWS, sidebarLines, type PanelLine } from "../src/panel-data"
import { openStatsDb, recordPrompt, recordStep, upsertSession } from "../src/stats/db"
import { dbInfo } from "../src/stats/maintenance"
import { turns } from "../src/stats/queries"

const width = Number(process.argv[2] ?? 100)
const base = Date.UTC(2026, 9, 12, 8, 0, 0)
const at = (hours: number, minutes = 0) => base + (hours * 60 + minutes) * 60 * 1000

const root = mkdtempSync(join(tmpdir(), "usage-insights-demo-"))
const db = openStatsDb(join(root, "stats.db"))

upsertSession(db, { sessionID: "ses_recorder", directory: "/code/opencode-usage-insights", title: "Refactor the recorder", startedAt: at(0) })
upsertSession(db, { sessionID: "ses_cache", directory: "/code/opencode-usage-insights", title: "Fix the cache regression", startedAt: at(30) })
upsertSession(db, { sessionID: "ses_docs", directory: "/code/opencode-usage-insights", title: "Docs pass", startedAt: at(70) })

const steps = [
  { sessionID: "ses_recorder", messageID: "msg_r1", promptID: "prt_r1", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", input: 84_200, cacheRead: 1_530_000, cacheWrite: 12_000, output: 3_700, cost: 0.21, started: at(0, 1), streamed: at(0, 1) + 1_400, completed: at(0, 1) + 52_000, finish: "tool-calls", router: "orcarouter-dsv4.1-flash-free" },
  { sessionID: "ses_recorder", messageID: "msg_r2", promptID: "prt_r2", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", input: 9_400, cacheRead: 1_614_000, cacheWrite: 900, output: 1_250, cost: 0.06, started: at(0, 24), streamed: at(0, 24) + 900, completed: at(0, 24) + 20_000, samePrompt: true, router: "orcarouter-dsv4.1-flash-free" },
  { sessionID: "ses_recorder", messageID: "msg_r3", promptID: "prt_r3", providerID: "anthropic", modelID: "claude-opus-4.6", input: 12_800, cacheRead: 96_000, cacheWrite: 11_000, output: 2_400, reasoning: 900, cost: 1.42, started: at(0, 41), streamed: at(0, 41) + 2_800, completed: at(0, 41) + 74_000, router: "orcarouter-claude" },
  { sessionID: "ses_cache", messageID: "msg_c1", promptID: "prt_c1", providerID: "opencode", modelID: "glm-5.3-flash", input: 41_000, cacheRead: 620_000, cacheWrite: 8_000, output: 5_100, cost: 0.32, started: at(30, 2), streamed: at(30, 2) + 1_100, completed: at(30, 2) + 61_000 },
  { sessionID: "ses_cache", messageID: "msg_c2", promptID: "prt_c2", providerID: "opencode", modelID: "glm-5.3-flash", input: 63_700, cacheRead: 12_400, cacheWrite: 9_000, output: 4_800, cost: 0.44, started: at(54, 0), streamed: at(54, 0) + 1_600, completed: at(54, 0) + 58_000 },
  { sessionID: "ses_docs", messageID: "msg_d1", promptID: "prt_d1", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", input: 22_500, cacheRead: 310_000, cacheWrite: 4_000, output: 6_300, cost: 0.18, started: at(70, 0), streamed: at(70, 0) + 1_200, completed: at(70, 0) + 88_000, router: "orcarouter-dsv4.1-flash-free" },
  { sessionID: "ses_docs", messageID: "msg_d2", promptID: "prt_d2", providerID: "opencode", modelID: "deepseek-v4.1-flash-free", input: 7_900, cacheRead: 402_000, cacheWrite: 700, output: 2_100, cost: 0.07, started: at(70, 20), streamed: at(70, 20) + 800, completed: at(70, 20) + 31_000, router: "orcarouter-dsv4.1-flash-free" },
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
    router: step.router,
    recordedAt: step.completed,
  })
}

const prompt = (id: string, created: number): RuntimeMessage => ({ id, type: "user", time: { created } })

const assistant = (id: string, model: RuntimeModelRef, tokens: RuntimeTokenUsage, created: number, streamed: number, completed: number): RuntimeMessage => ({
  id,
  type: "assistant",
  model,
  tokens,
  time: { created, streamed, completed },
})

const DEEPSEEK: RuntimeModelRef = { providerID: "opencode", id: "deepseek-v4.1-flash-free" }
const OPUS: RuntimeModelRef = { providerID: "anthropic", id: "claude-opus-4.6" }
const GLM: RuntimeModelRef = { providerID: "opencode", id: "glm-5.3-flash" }

const recorderTurn1 = [prompt("prt_r1", at(0, 0)), assistant("msg_r1", DEEPSEEK, { input: 84_200, output: 3_700, cache: { read: 1_530_000 } }, at(0, 1), at(0, 3), at(0, 9))]
const recorderTurn2 = [prompt("prt_r2", at(0, 24)), assistant("msg_r2", DEEPSEEK, { input: 9_400, output: 1_250, cache: { read: 1_614_000 } }, at(0, 24), at(0, 25), at(0, 29))]
const recorderTurn3 = [prompt("prt_r3", at(0, 41)), assistant("msg_r3", OPUS, { input: 12_800, output: 2_400, reasoning: 900, cache: { read: 96_000 } }, at(0, 41), at(0, 44), at(0, 52))]
const cacheTurn1 = [prompt("prt_c1", at(30, 0)), assistant("msg_c1", GLM, { input: 41_000, output: 5_100, cache: { read: 620_000 } }, at(30, 2), at(30, 4), at(30, 14))]
const cacheTurn2 = [prompt("prt_c2", at(54, 0)), assistant("msg_c2", GLM, { input: 63_700, output: 4_800, cache: { read: 12_400 } }, at(54, 0), at(54, 2), at(54, 9))]

/** One turn with three steps (a tool-call loop), from a live recording. */
const loopTurn: RuntimeMessage[] = [
  prompt("prt_loop", at(60, 0)),
  assistant("msg_l1", DEEPSEEK, { input: 924, output: 242, cache: { read: 290_048 } }, at(60, 1), at(60, 3), at(60, 9)),
  assistant("msg_l2", DEEPSEEK, { input: 723, output: 148, reasoning: 351, cache: { read: 290_944 } }, at(60, 10), at(60, 12), at(60, 18)),
  assistant("msg_l3", DEEPSEEK, { input: 1_020, output: 463, reasoning: 1_030, cache: { read: 291_584 } }, at(60, 19), at(60, 21), at(60, 27)),
]

/** A response that has started streaming: no completion time, no final tokens. */
const liveTurn: RuntimeMessage[] = [
  prompt("prt_live", at(84, 0)),
  { id: "msg_live", type: "assistant", model: DEEPSEEK, tokens: { input: 0, output: 0, cache: { read: 0 } }, time: { created: at(84, 1), streamed: at(84, 2) } },
]

const recorderTotals: Totals = { input: 106_400, cached: 2_890_000, output: 6_100, reasoning: 900, cacheWrite: 700, cost: 0.27, steps: 2 }
const cacheTotals: Totals = { input: 104_700, cached: 632_400, output: 9_900, reasoning: 0, cacheWrite: 17_000, cost: 0.76, steps: 1 }

function turnLine(
  messages: RuntimeMessage[],
  totals: Totals,
  options: { router?: string; turnTotals?: TurnTotalsView; identity?: LineIdentity } = {},
): string {
  const stats = computeTurn(toTranscript(messages), totals)
  if (stats === undefined) return ""
  // The TUI fills this from the recorder's database; the demo sets it directly.
  if (options.router !== undefined) stats.router = options.router
  return formatLine(stats, { turnTotals: options.turnTotals, identity: options.identity })
}

const section = (title: string, text: string) => {
  console.log(`\n${title}\n${"─".repeat(width)}\n${text}`)
}

const body = (lines: readonly PanelLine[]) => lines.map((entry) => entry.text.replace(/\s+$/, "")).join("\n")

section(
  "turn · prompt cache survived (the endpoint that served the turn)",
  turnLine([...recorderTurn1, ...recorderTurn2], recorderTotals, { router: "orcarouter-dsv4.1-flash-free" }),
)
section(
  "turn · prompt cache expired after an idle gap",
  turnLine([...cacheTurn1, ...cacheTurn2], cacheTotals, { router: "orcarouter-glm-5.3-flash" }),
)
section(
  "turn · provider changed (no endpoint learned: falls back to provider/model)",
  turnLine([...recorderTurn2, ...recorderTurn3], recorderTotals, {  }),
)
section(
  "turn · tool-call loop, latest view (the prompt size the turn ended with)",
  turnLine(loopTurn, recorderTotals, { router: "orcarouter-dsv4.1flash" }),
)
section(
  'turn · tool-call loop, sum view (turnTotals: "sum" — every step of the turn)',
  turnLine(loopTurn, recorderTotals, { router: "orcarouter-dsv4.1flash", turnTotals: "sum" }),
)
section(
  "turn · response still streaming (no line until the response ends)",
  turnLine([...recorderTurn2, ...recorderTurn3, ...liveTurn], recorderTotals, { router: "orcarouter-dsv4.1flash" }) || "(no line yet)",
)
section("sidebar history (compact, last 3 turns)", body(sidebarLines(turns(db, { sessionID: "ses_recorder", limit: 3 }), { budget: 34 })))

// Every view of the panel, rendered from the same request the TUI builds.
const demoPath = join(root, "stats.db")
for (const view of PANEL_VIEWS) {
  const request: PanelRequest = {
    db,
    view,
    range: "all",
    filters: {},
    granularity: "day",
    turnsScope: "all",
    sort: "",
    sortDesc: true,
    sessionID: "ses_recorder",
    sessionStart: at(0),
    now: at(90),
    width,
    // The panel component reads this for the db view alone, the same way.
    ...(view === "db" ? { database: dbInfo(db, demoPath, at(90)) } : {}),
  }
  section(`/usage ${view}`, body(buildPanel(request)))
}

db.close()
rmSync(root, { recursive: true, force: true })
console.log()
