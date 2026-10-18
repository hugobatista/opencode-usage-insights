/**
 * Print the telemetry line and every panel view as plain text, from the shared
 * seeded throwaway database. Handy for reviewing the output and for the README;
 * `scripts/screenshot.ts` renders the same content into images.
 *
 *   bun run demo [width]
 */
import { rmSync } from "node:fs"
import { computeTurn, formatLine, type LineIdentity, type Totals, type TurnTotalsView } from "../src/core"
import { toTranscript, type RuntimeMessage } from "../src/line"
import { buildPanel, type PanelRequest } from "../src/panel-build"
import { PANEL_VIEWS, sidebarLines, type PanelLine } from "../src/panel-data"
import { dbInfo } from "../src/stats/maintenance"
import { turns } from "../src/stats/queries"
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
  recorderTurn1,
  recorderTurn2,
  recorderTurn3,
} from "./demo-seed"

const width = Number(process.argv[2] ?? 100)
const { db, root, path: demoPath, now } = openDemoDatabase()

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
  turnLine([...recorderTurn2, ...recorderTurn3], recorderTotals, {}),
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
section(
  "sidebar history (compact, last 3 turns)",
  body(sidebarLines(turns(db, { sessionID: DEMO_SESSION_ID, limit: DEMO_SIDEBAR_TURNS }), { budget: 34 })),
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
