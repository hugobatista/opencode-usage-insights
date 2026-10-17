/**
 * Read the stats database from a terminal and print the same views as the TUI
 * panel, or dump the raw rows for scripting.
 *
 *   bun run report [view] [range] [--db <path>] [--width <n>] [--json] [--ndjson]
 *
 * Views: overview models cache latency sessions all   (default: overview)
 * Ranges: session today 7d 30d all                    (default: all)
 */
import { existsSync, readFileSync } from "node:fs"
import { PANEL_VIEWS, RANGE_KEYS, cacheLines, count, latencyLines, modelsLines, overviewLines, rangeFor, sessionsLines, type PanelLine, type PanelView, type RangeKey } from "../src/panel-data"
import { exportNdjson, importNdjson, openStatsDb } from "../src/stats/db"
import { defaultDbPath, resolveDbPath } from "../src/stats/paths"
import { cacheDrops, cacheTtlEvidence, latency, models, overview, sessions } from "../src/stats/queries"

type Args = {
  view: PanelView | "all"
  range: RangeKey
  db?: string | undefined
  width: number
  json: boolean
  ndjson: boolean
  import?: string | undefined
}

const USAGE = `usage: bun run report [view] [range] [--db <path>] [--width <n>] [--json] [--ndjson] [--import <file>]

views  ${PANEL_VIEWS.join(", ")}, all (default: overview)
ranges ${RANGE_KEYS.join(", ")} (default: all)
flags  --db <path>     database override (default: ${defaultDbPath()})
       --width <n>     column budget (default: 100)
       --json          print the raw query rows as JSON
       --ndjson        export the whole database as NDJSON
       --import <file> merge an NDJSON export into the database and exit`

function parse(argv: readonly string[]): Args {
  const parsed: Args = { view: "overview", range: "all", width: 100, json: false, ndjson: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ""
    if (token === "--json") parsed.json = true
    else if (token === "--ndjson") parsed.ndjson = true
    else if (token === "--db") parsed.db = argv[++index]
    else if (token === "--import") parsed.import = argv[++index]
    else if (token === "--width") parsed.width = Number(argv[++index] ?? 100)
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
const range = rangeFor(args.range, now)
if (args.range === "session") console.error("note: no session context here, so \"session\" covers the whole database")

if (args.json) {
  const data = {
    overview: overview(db, range),
    models: models(db, range),
    cacheDrops: cacheDrops(db, { range }),
    cacheTtlEvidence: cacheTtlEvidence(db, range),
    latency: latency(db, range),
    sessions: sessions(db, { range, limit: 50 }),
  }
  console.log(JSON.stringify(data, null, 2))
  db.close()
  process.exit(0)
}

const views: PanelView[] = args.view === "all" ? [...PANEL_VIEWS] : [args.view]

for (const view of views) {
  if (views.length > 1) console.log(`
${view}
${"─".repeat(args.width)}`)
  const lines: PanelLine[] = (() => {
    switch (view) {
      case "overview":
        return overviewLines({ usage: overview(db, range), session: undefined, range: args.range }, args.width)
      case "models":
        return modelsLines(models(db, range), args.width)
      case "cache":
        return cacheLines({ drops: cacheDrops(db, { range }), evidence: cacheTtlEvidence(db, range) }, args.width)
      case "latency":
        return latencyLines(latency(db, range), args.width)
      case "sessions":
        return sessionsLines(sessions(db, { range, limit: 20 }), args.width)
      default:
        return []
    }
  })()
  for (const line of lines) console.log(line.text.replace(/\s+$/, ""))
}

db.close()
