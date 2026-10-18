/**
 * Performance harness: builds a synthetic usage database of a given size and
 * times the reads the plugin actually performs, plus the writes that sit on
 * the request path.
 *
 * Run it after any change to the queries, the schema or the wiring:
 *
 *   bun run bench                 # 20k steps, checks the budgets
 *   bun run bench --full          # 120k steps, the volume of the audit
 *   bun run bench --steps 500000  # a specific volume
 *   bun run bench --explain       # print the query plans behind the reads
 *
 * Every read has a budget. `--budget` (implied by `--full`) makes the script
 * exit non-zero when one is blown, which is what CI uses. The numbers in
 * `BUDGETS` are the audit's findings with room to spare — a regression (a
 * dropped index, a forgotten LIMIT) trips them long before a user notices.
 */

import { Database } from "bun:sqlite"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { computeTurn, type TranscriptMessage } from "../src/core"
import { toTranscriptTail } from "../src/line"
import { recordEvent, recordPrompt, recordStep, upsertSession } from "../src/stats/db"
import { SCHEMA_VERSION, openStatsDb } from "../src/stats/db"
import { dbInfo } from "../src/stats/maintenance"
import { buildPanel, type PanelRequest } from "../src/panel-build"
import { PANEL_VIEWS } from "../src/panel-data"
import { cacheDropsOf, cachePairs, cacheStatsByModel, coverageOf, gapReportOf, latencyGroupsOf, latencyOf, stepRows, switchesOf, timingRows, ttlEvidenceOf } from "../src/stats/aggregates"
import { filterOptions } from "../src/stats/queries"
import { models, overview, sessions, turns } from "../src/stats/queries"

type Args = {
  steps: number
  sessions: number
  budget: boolean
  explain: boolean
  keep: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const read = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag)
    if (index === -1) return fallback
    const parsed = Number.parseInt(argv[index + 1] ?? "", 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const full = argv.includes("--full")
  return {
    steps: read("--steps", full ? 120_000 : 20_000),
    sessions: read("--sessions", full ? 3_000 : 500),
    budget: full || argv.includes("--budget"),
    explain: argv.includes("--explain"),
    keep: argv.includes("--keep"),
  }
}

/** Providers, models and variants a real database mixes. */
const MODELS = [
  ["anthropic", "claude-sonnet-4-5", "default"],
  ["anthropic", "claude-haiku-4-5", undefined],
  ["deepseek", "deepseek-v4.1-flash", undefined],
  ["opencode-go", "deepseek-v4.1-flash", undefined],
  ["opencode", "big-pickle", undefined],
  ["google", "gemini-3-pro", "high"],
] as const

/** Window the synthetic history spans, ending today: the 7d range must be full. */
const WINDOW = 10 * 24 * 60 * 60 * 1000
const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

/** Deterministic pseudo-random source, so two runs time the same workload. */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

/** A transcript of `size` messages, shaped like a session's: prompts and steps. */
function transcript(size: number): TranscriptMessage[] {
  const random = makeRandom(7)
  const messages: TranscriptMessage[] = []
  let at = Date.now() - size * 1_000
  for (let index = 0; index < size; index += 1) {
    at += 1_000
    if (index % 6 === 0) {
      messages.push({ type: "user", id: `msg_user_${index}`, time: { created: at } })
      continue
    }
    const input = 500 + Math.floor(random() * 4_000)
    messages.push({
      type: "assistant",
      id: `msg_assistant_${index}`,
      time: { created: at, streamed: at + 900, completed: at + 1_100 },
      model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "default" },
      tokens: {
        input,
        output: 120,
        reasoning: 0,
        cache: { read: Math.floor(input * 0.7), write: 60 },
      },
      cost: 0.004,
      finish: "stop",
    })
  }
  return messages
}

function build(db: Database, steps: number, sessionCount: number): void {
  const random = makeRandom(42)
  const stepsPerSession = Math.max(1, Math.floor(steps / sessionCount))
  let sequence = 0

  db.exec("BEGIN")
  for (let session = 0; session < sessionCount; session += 1) {
    const sessionID = `ses_bench_${String(session).padStart(6, "0")}`
    // The history ends today and spans the last ten days, so the panel's
    // default 7d range holds most of it — the workload a user actually runs.
    const startedAt = Math.floor(NOW - WINDOW + (session / sessionCount) * WINDOW)
    upsertSession(db, {
      sessionID,
      ...(session % 7 === 0 ? { parentID: `ses_bench_${String(session - 1).padStart(6, "0")}` } : {}),
      directory: `/home/dev/project-${session % 40}`,
      title: `Bench session ${session}`,
      startedAt,
      updatedAt: startedAt,
    })
    const turns = Math.max(1, Math.round(stepsPerSession / 6))
    const perTurn = Math.ceil(stepsPerSession / turns)
    let at = startedAt
    for (let turn = 0; turn < turns; turn += 1) {
      const promptID = `msg_prompt_${sessionID}_${turn}`
      recordPrompt(db, { sessionID, messageID: promptID, createdAt: at })
      for (let index = 0; index < perTurn; index += 1) {
        sequence += 1
        const [providerID, modelID, variant] = MODELS[Math.floor(random() * MODELS.length)]!
        const input = 400 + Math.floor(random() * 6_000)
        const cached = random() < 0.7 ? Math.floor(input * (0.4 + random() * 0.6)) : 0
        const started = at + 20 + Math.floor(random() * 200)
        const streamed = started + 400 + Math.floor(random() * 4_000)
        recordStep(db, {
          messageID: `msg_bench_${String(sequence).padStart(7, "0")}`,
          sessionID,
          providerID,
          modelID,
          variant,
          input,
          output: 60 + Math.floor(random() * 900),
          reasoning: random() < 0.3 ? Math.floor(random() * 400) : 0,
          cacheRead: cached,
          cacheWrite: random() < 0.4 ? Math.floor(random() * 800) : 0,
          cost: random() * 0.05,
          createdAt: started,
          streamedAt: streamed,
          completedAt: streamed + 30 + Math.floor(random() * 300),
          finish: index === perTurn - 1 ? "stop" : "tool-calls",
          recordedAt: started + 10,
        })
        at = streamed + 40
      }
    }
    // A compaction on some sessions: the cache view correlates them.
    if (session % 5 === 0) {
      recordEvent(db, { sessionID, kind: "compaction", at: startedAt + Math.floor(DAY / 3) })
    }
  }
  db.exec("COMMIT")
}

/** One timed operation, as it runs from the panel or the line. */
type Operation = {
  name: string
  run: () => unknown
  /** Milliseconds the operation must stay under. */
  budget: number
  /** Repeat the operation this many times and take the median. */
  repeat?: number
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

type Measurement = { name: string; ms: number; budget: number; ok: boolean }

function measure(operations: readonly Operation[]): Measurement[] {
  // One untimed pass first: a new connection reads the file from disk, and the
  // first build of a view is dominated by that. The budgets describe the
  // steady state, which is what a panel rebuild pays.
  for (const operation of operations) operation.run()

  const out: Measurement[] = []
  for (const operation of operations) {
    const runs: number[] = []
    const repeat = operation.repeat ?? 3
    for (let index = 0; index < repeat; index += 1) {
      const started = Bun.nanoseconds()
      operation.run()
      runs.push((Bun.nanoseconds() - started) / 1_000_000)
    }
    const ms = median(runs)
    out.push({ name: operation.name, ms, budget: operation.budget, ok: ms <= operation.budget })
  }
  return out
}

/** Query plans that must use the expression index, not scan the table. */
function plans(db: Database): Array<{ label: string; plan: string }> {
  const now = Date.now()
  const ranged = [
    ["overview range", `SELECT COUNT(*) FROM steps WHERE COALESCE(created_at, recorded_at) >= ${now - 7 * DAY}`],
    ["latency range", `SELECT created_at FROM steps WHERE COALESCE(created_at, recorded_at) >= ${now - 7 * DAY}`],
    ["sessions range", `SELECT session_id FROM steps WHERE COALESCE(created_at, recorded_at) >= ${now - 7 * DAY} GROUP BY session_id`],
    [
      "predecessor seek",
      `SELECT message_id FROM steps WHERE session_id = 'ses_bench_000001' AND COALESCE(created_at, recorded_at) < ${now} ORDER BY COALESCE(created_at, recorded_at) DESC LIMIT 1`,
    ],
    ["turns session", `SELECT message_id FROM steps WHERE session_id = 'ses_bench_000001' ORDER BY COALESCE(created_at, recorded_at)`],
  ] as const
  return ranged.map(([label, sql]) => ({
    label,
    plan: (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((row) => row.detail).join(" | "),
  }))
}

/**
 * Ceiling per view, in milliseconds, at the audit volume (120k steps, 7d
 * range). Sessions, turns and the db view answer from SQL alone and are
 * milliseconds; everything that aggregates the range step by step (cache,
 * latency, models) costs what its range holds.
 */
const PANEL_BUDGETS: Partial<Record<(typeof PANEL_VIEWS)[number], number>> = {
  "overview": 700,
  "models": 1800,
  "providers": 1200,
  "cache": 1600,
  "periods": 800,
  "latency": 2100,
  "sessions": 400,
  "turns": 60,
  "db": 60,
}

function main(): void {
  const args = parseArgs(Bun.argv.slice(2))
  const directory = join("/tmp/opencode", `usage-insights-bench-${process.pid}`)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "bench.db")

  process.stdout.write(`building ${args.steps.toLocaleString("en-US")} steps over ${args.sessions.toLocaleString("en-US")} sessions... `)
  const started = Bun.nanoseconds()
  const db = openStatsDb(path)
  build(db, args.steps, args.sessions)
  const builtMs = (Bun.nanoseconds() - started) / 1_000_000
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  process.stdout.write(`${builtMs.toFixed(0)}ms (schema v${SCHEMA_VERSION})${args.keep ? ` at ${path}` : ""}\n\n`)

  const now = Date.now()
  const range7d = { from: now - 7 * DAY }
  const sessionID = "ses_bench_000042"
  const provider = "anthropic"
  const filters = { modelID: "claude-sonnet-4-5" }
  const shortTranscript = transcript(2_000)
  const longTranscript = transcript(16_000)

  const operations: Operation[] = [
    // The line: computed per finished turn, over the session's transcript.
    { name: "computeTurn (2k messages)", budget: 1.5, repeat: 50, run: () => computeTurn(shortTranscript) },
    { name: "computeTurn (16k messages)", budget: 1.5, repeat: 50, run: () => computeTurn(longTranscript) },
    // The line at turn end: converting the whole transcript cost ~1.2 ms here
    // before the tail walk; only the last turns are needed.
    { name: "line at turn end (16k msgs)", budget: 0.4, repeat: 200, run: () => computeTurn(toTranscriptTail(longTranscript, 2)) },
    // Writes on the request path: the recorder may not add latency of its own.
    {
      name: "recordStep (write)",
      budget: 0.5,
      repeat: 200,
      run: () => {
        recordStep(db, {
          messageID: `msg_bench_write_${Bun.nanoseconds()}`,
          sessionID,
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          input: 1_000,
          output: 200,
          createdAt: now,
          recordedAt: now,
        })
      },
    },
    { name: "recordEvent (write)", budget: 0.5, repeat: 200, run: () => recordEvent(db, { sessionID, kind: "compaction", at: now }) },
    { name: "openStatsDb", budget: 15, repeat: 10, run: () => openStatsDb(path).close() },
    { name: "dbInfo (db view)", budget: 60, run: () => dbInfo(db, path, now) },
    // Reads the panel and the line run.
    { name: "overview 7d", budget: 130, run: () => overview(db, range7d) },
    { name: "overview all + filter", budget: 90, run: () => overview(db, undefined, filters) },
    { name: "models 7d", budget: 350, run: () => models(db, range7d) },
    { name: "sessions 7d (500)", budget: 350, run: () => sessions(db, { range: range7d, limit: 500 }) },
    { name: "coverage 7d", budget: 300, run: () => coverageOf(db, { range: range7d }) },
    { name: "latency report 7d", budget: 1400, run: () => latencyOf(timingRows(db, { range: range7d })) },
    { name: "latency groups 7d", budget: 1300, run: () => latencyGroupsOf(timingRows(db, { range: range7d }), "model") },
    { name: "turns session (300)", budget: 40, run: () => turns(db, { sessionID, limit: 300 }) },
    { name: "cache pair pass 7d", budget: 800, run: () => cachePairs(db, { range: range7d }) },
    { name: "switches 7d", budget: 1200, run: () => switchesOf(cachePairs(db, { range: range7d })) },
    { name: "cacheDrops 7d", budget: 1100, run: () => cacheDropsOf(db, cachePairs(db, { range: range7d })) },
    { name: "cacheTtlEvidence 7d", budget: 1000, run: () => ttlEvidenceOf(cachePairs(db, { range: range7d })) },
    { name: "cache survival 7d", budget: 1000, run: () => gapReportOf(cachePairs(db, { range: range7d })) },
    { name: "cache by model 7d", budget: 700, run: () => cacheStatsByModel(stepRows(db, { range: range7d })) },
    { name: "filterOptions", budget: 200, run: () => filterOptions(db) },
  ]

  for (const view of PANEL_VIEWS) {
    const request: PanelRequest = {
      db,
      view,
      range: "7d",
      filters: {},
      granularity: "day",
      turnsScope: "session",
      sort: "",
      sortDesc: false,
      sessionID,
      sessionStart: NOW - WINDOW,
      now,
      width: 120,
      ...(view === "db" ? { database: dbInfo(db, path, now) } : {}),
    }
    operations.push({
      name: `buildPanel ${view}`,
      // Views that read the facts of the whole range cost O(steps in range) in
      // JS, so they scale with the volume: the budget is the audit volume with
      // room to spare, not the cost of a short session.
      budget: PANEL_BUDGETS[view] ?? 400,
      run: () => buildPanel(request).length,
    })
  }

  const results = measure(operations)
  const width = Math.max(...results.map((result) => result.name.length))
  for (const result of results) {
    const verdict = result.ok ? "ok" : "OVER BUDGET"
    process.stdout.write(`${result.name.padEnd(width)}  ${result.ms.toFixed(2).padStart(8)} ms  (<= ${result.budget}) ${verdict}\n`)
  }

  if (args.explain) {
    process.stdout.write("\nquery plans\n")
    for (const entry of plans(db)) process.stdout.write(`  ${entry.label}\n    ${entry.plan}\n`)
  }

  // The range reads have to use the expression index; a bare table scan is the
  // regression this bench exists to catch, whatever the timing says at a small
  // volume.
  const indexPlans = plans(db).filter((entry) => entry.label !== "sessions range")
  const scans = indexPlans.filter((entry) => !entry.plan.includes("steps_at") && !entry.plan.includes("steps_session_at"))
  for (const entry of scans) process.stdout.write(`\nno index for "${entry.label}": ${entry.plan}\n`)

  db.close()
  if (!args.keep) rmSync(directory, { recursive: true, force: true })

  const over = results.filter((result) => !result.ok)
  const failed = args.budget && (over.length > 0 || scans.length > 0)
  if (failed) {
    process.stdout.write(`\n${over.length} over budget, ${scans.length} unindexed read(s)\n`)
    process.exit(1)
  }
  process.stdout.write(`\nall ${results.length} operations within budget${args.budget ? "" : " (timings only: pass --budget to fail on them)"}\n`)
}

main()
