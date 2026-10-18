/**
 * Print the telemetry line and every panel view as plain text, from the shared
 * seeded throwaway database. Handy for reviewing the output and for the README;
 * `scripts/screenshot.ts` renders the same content into images.
 *
 *   bun run demo [width]
 */
import { rmSync } from "node:fs"
import { computeTurn, formatLine, type Totals, type TurnTotalsView } from "../src/core"
import { toTranscript, type RuntimeMessage } from "../src/line"
import { buildPanel, type PanelRequest } from "../src/panel-build"
import { PANEL_VIEWS, sessionSummaryLines, sidebarLines, type PanelLine } from "../src/panel-data"
import { dbInfo } from "../src/stats/maintenance"
import { overview, turns } from "../src/stats/queries"
import {
  DEMO_SESSION_ID,
  DEMO_SIDEBAR_TURNS,
  cacheTotals,
  cacheTurn1,
  cacheTurn2,
  demoAt,
  liveTurn,
  loopTurn,
  openDemoDatabase,
  recorderTotals,
  recorderTotalsAfterOpus,
  recorderTurn1,
  recorderTurn2,
  recorderTurn3,
} from "./demo-seed"

const width = Number(process.argv[2] ?? 100)
const { db, root, path: demoPath, now } = openDemoDatabase()

function turnLine(
  messages: RuntimeMessage[],
  totals: Totals,
  options: { turnTotals?: TurnTotalsView } = {},
): string {
  const stats = computeTurn(toTranscript(messages), totals)
  if (stats === undefined) return ""
  return formatLine(stats, { turnTotals: options.turnTotals })
}

const section = (title: string, text: string) => {
  console.log(`\n${title}\n${"─".repeat(width)}\n${text}`)
}

const body = (lines: readonly PanelLine[]) => lines.map((entry) => entry.text.replace(/\s+$/, "")).join("\n")

section(
  "turn · prompt cache survived (the provider and model that ran the turn)",
  turnLine([...recorderTurn1, ...recorderTurn2], recorderTotals),
)
section(
  "turn · prompt cache expired after an idle gap",
  turnLine([...cacheTurn1, ...cacheTurn2], cacheTotals),
)
section(
  "turn · provider changed (opencode → anthropic)",
  turnLine([...recorderTurn2, ...recorderTurn3], recorderTotalsAfterOpus),
)
section(
  "turn · tool-call loop, latest view (the prompt size the turn ended with)",
  turnLine(loopTurn, recorderTotals),
)
section(
  'turn · tool-call loop, sum view (turnTotals: "sum" — every step of the turn)',
  turnLine(loopTurn, recorderTotals, { turnTotals: "sum" }),
)
section(
  "turn · response still streaming (no line until the response ends)",
  turnLine([...recorderTurn2, ...recorderTurn3, ...liveTurn], recorderTotalsAfterOpus) || "(no line yet)",
)
section(
  "sidebar (the session's totals, then the turns — three lines each, plus the model at both ends of the block and on every change)",
  body([
    ...sessionSummaryLines(overview(db, undefined, { sessionID: DEMO_SESSION_ID }), 34),
    { text: "turns", tone: "accent" },
    ...sidebarLines(turns(db, { sessionID: DEMO_SESSION_ID, limit: DEMO_SIDEBAR_TURNS }), { budget: 34 }),
  ]),
)

// Every view of the panel, rendered from the same request the TUI builds.
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
    sessionID: DEMO_SESSION_ID,
    sessionStart: demoAt(0),
    now,
    width,
    // The panel component reads this for the db view alone, the same way.
    ...(view === "db" ? { database: dbInfo(db, demoPath, now) } : {}),
  }
  section(`/usage ${view}`, body(buildPanel(request)))
}

db.close()
rmSync(root, { recursive: true, force: true })
console.log()
