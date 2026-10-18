/**
 * Read the stats database from a terminal and print the same views as the TUI
 * panel, or dump the raw rows for scripting.
 *
 *   bun run report [view] [range] [--db <path>] [--width <n>] [--json] [--ndjson]
 *
 * Views: the panel's own catalogue   (default: overview)
 * Ranges: session today 7d 30d all   (default: all)
 *
 * The views come from the same `buildPanel` the panel renders, so the terminal
 * and the TUI never drift apart.
 */
import { existsSync, readFileSync } from "node:fs"
import { buildPanel, type PanelRequest } from "../src/panel-build"
import { DEFAULT_SETTINGS, GRANULARITIES, PANEL_VIEWS, RANGE_KEYS, count, type Granularity, type PanelLine, type PanelView, type RangeKey } from "../src/panel-data"
import {
  affinityOf,
  cacheDropsOf,
  cacheStatsByModel,
  cachePairs,
  stepRows,
  cacheStatsOf,
  coverageOf,
  endpointBreakdownOf,
  endpointSummaryOf,
  gapReportOf,
  latencyGroupsOf,
  latencyOf,
  periodsOf,
  ttlEvidenceOf,
} from "../src/stats/aggregates"
import { exportNdjson, importNdjson, openStatsDb } from "../src/stats/db"
import { dbInfo, pruneOlderThan, vacuum } from "../src/stats/maintenance"
import { defaultDbPath, resolveDbPath } from "../src/stats/paths"
import { models, overview, sessions } from "../src/stats/queries"

type Args = {
  view: PanelView | "all"
  range: RangeKey
  db?: string | undefined
  width: number
  granularity: Granularity
  model?: string | undefined
  endpoint?: string | undefined
  sort?: string | undefined
  sortDesc: boolean
  json: boolean
  ndjson: boolean
  import?: string | undefined
  prune?: number | undefined
  vacuum: boolean
}

const USAGE = `usage: bun run report [view] [range] [options]

views  ${PANEL_VIEWS.join(", ")}, all (default: overview)
ranges ${RANGE_KEYS.join(", ")} (default: all)
flags  --db <path>          database override (default: ${defaultDbPath()})
       --width <n>          column budget (default: 100)
       --granularity <g>    periods bucket: ${GRANULARITIES.join(", ")} (default: day)
       --model <id>         only steps of this model
       --endpoint <name>    only steps served by this routing endpoint
       --sort <key>         sort key of the view (models: steps cached out cost, …)
       --asc                sort ascending (default: descending)
       --json               print the raw query rows as JSON
       --ndjson             export the whole database as NDJSON
       --import <file>      merge an NDJSON export into the database and exit
       --prune <days>       delete the recorded usage older than <days>
       --vacuum             rewrite the file to reclaim the space a prune freed`

function parse(argv: readonly string[]): Args {
  const parsed: Args = { view: "overview", range: "all", width: 100, granularity: "day", sortDesc: true, json: false, ndjson: false, vacuum: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ""
    if (token === "--json") parsed.json = true
    else if (token === "--ndjson") parsed.ndjson = true
    else if (token === "--asc") parsed.sortDesc = false
    else if (token === "--vacuum") parsed.vacuum = true
    else if (token === "--prune") parsed.prune = Number(argv[++index])
    else if (token === "--db") parsed.db = argv[++index]
    else if (token === "--import") parsed.import = argv[++index]
    else if (token === "--width") parsed.width = Number(argv[++index] ?? 100)
    else if (token === "--granularity") parsed.granularity = (argv[++index] ?? "day") as Granularity
    else if (token === "--model") parsed.model = argv[++index]
    else if (token === "--endpoint") parsed.endpoint = argv[++index]
    else if (token === "--sort") parsed.sort = argv[++index]
    else if (token === "-h" || token === "--help") {
      console.log(USAGE)
      process.exit(0)
    } else if (token === "all") parsed.view = "all"
    else if ((PANEL_VIEWS as readonly string[]).includes(token)) parsed.view = token as PanelView
    else if ((RANGE_KEYS as readonly string[]).includes(token)) parsed.range = token as RangeKey
    else {
      console.error(`unknown argument: ${token}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(parsed.width) || parsed.width < 40) parsed.width = 100
  if (!(GRANULARITIES as readonly string[]).includes(parsed.granularity)) parsed.granularity = "day"
  return parsed
}

const args = parse(process.argv.slice(2))
const path = resolveDbPath(args.db)

// Importing is the one mode that is expected to create the database: it is how
// a backup lands on a fresh machine.
if (args.import !== undefined) {
  let text: string
  try {
    text = readFileSync(args.import, "utf8")
  } catch (error) {
    console.error(`cannot read ${args.import}`)
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const db = openStatsDb(path)
  const imported = importNdjson(db, text)
  db.close()
  console.log(`imported ${count(imported, "row")} into ${path}`)
  process.exit(0)
}

// Opening creates the file, so a typo would silently produce an empty
// database. A report over a database that does not exist yet is an error.
if (!existsSync(path)) {
  console.error(`no stats database at ${path}`)
  console.error(`the plugin creates it on its first recorded step; pass --db <path> to read another one`)
  process.exit(1)
}

let db
try {
  db = openStatsDb(path)
} catch (error) {
  console.error(`cannot open ${path}`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

if (args.ndjson) {
  console.log(exportNdjson(db).trimEnd())
  db.close()
  process.exit(0)
}

const now = Date.now()

if (args.prune !== undefined) {
  if (!Number.isFinite(args.prune) || args.prune < 0) {
    console.error("--prune takes a number of days")
    db.close()
    process.exit(2)
  }
  const result = pruneOlderThan(db, now - args.prune * 24 * 60 * 60 * 1000)
  console.log(`pruned ${count(result.steps, "step")} · ${count(result.prompts, "prompt")} · ${count(result.events, "compaction event")}`)
}
if (args.vacuum) {
  const result = vacuum(db, path)
  console.log(`vacuum: ${(result.freed / 1_048_576).toFixed(1)} MB back (${(result.after / 1_048_576).toFixed(1)} MB now)`)
}
if (args.prune !== undefined || args.vacuum) {
  db.close()
  process.exit(0)
}

const range = args.range === "session" ? undefined : rangeForCli(args.range, now)
if (args.range === "session") console.error("note: no session context here, so \"session\" covers the whole database")

const filters = {
  ...(args.model !== undefined ? { modelID: args.model } : {}),
  ...(args.endpoint !== undefined ? { router: args.endpoint } : {}),
}

if (args.json) {
  // Two reads serve the whole dump: the steps, and the pairs (the steps plus
  // the one before the range, for the reports that compare consecutive steps).
  const steps = stepRows(db, { range, filters })
  const pairs = cachePairs(db, { range, filters })
  const data = {
    overview: overview(db, range, filters),
    models: models(db, range, filters),
    endpoints: endpointSummaryOf(steps),
    endpointModels: endpointBreakdownOf(steps),
    affinity: affinityOf(pairs),
    cache: {
      stats: cacheStatsOf(db, { range, filters }),
      byModel: cacheStatsByModel(steps),
      drops: cacheDropsOf(db, pairs),
      ttl: ttlEvidenceOf(pairs),
      gap: gapReportOf(pairs),
    },
    periods: periodsOf(steps, args.granularity),
    latency: { overall: latencyOf(steps), byModel: latencyGroupsOf(steps, "model"), byEndpoint: latencyGroupsOf(steps, "endpoint") },
    sessions: sessions(db, { range, filters, limit: 50 }),
    coverage: coverageOf(db, { range, filters }),
    db: dbInfo(db, path, now),
  }
  console.log(JSON.stringify(data, null, 2))
  db.close()
  process.exit(0)
}

const views: PanelView[] = args.view === "all" ? [...PANEL_VIEWS] : [args.view]

for (const view of views) {
  if (views.length > 1) console.log(`\n${view}\n${"─".repeat(args.width)}`)
  const request: PanelRequest = {
    db,
    view,
    range: args.range,
    filters,
    granularity: args.granularity,
    turnsScope: "all",
    sort: args.sort ?? "",
    sortDesc: args.sortDesc,
    sessionID: "",
    sessionStart: undefined,
    now,
    database: dbInfo(db, path, now),
    width: args.width,
  }
  const lines: PanelLine[] = buildPanel(request)
  for (const line of lines) console.log(line.text.replace(/\s+$/, ""))
}

db.close()

function rangeForCli(key: RangeKey, at: number): { from?: number | undefined; to?: number | undefined } | undefined {
  switch (key) {
    case "today": {
      const start = new Date(at)
      start.setHours(0, 0, 0, 0)
      return { from: start.getTime() }
    }
    case "7d":
      return { from: at - 7 * 24 * 60 * 60 * 1000 }
    case "30d":
      return { from: at - 30 * 24 * 60 * 60 * 1000 }
    default:
      return undefined
  }
}
