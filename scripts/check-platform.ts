/**
 * Cross-platform smoke check.
 *
 * Everything the plugin does with the machine it runs on — resolving its
 * directory, creating the database, recording, reading every panel view,
 * pruning and compacting, importing and exporting — exercised against a
 * throwaway database, on the OS this runs on:
 *
 *   bun run check:platform
 *
 * It exists because the plugin ships to Linux, macOS and Windows while CI runs
 * the test suite on Linux. This script has no rendering dependency, so it runs
 * everywhere and answers the question CI cannot: does the data layer work on
 * this machine?
 *
 * Nothing touches the user's own database: the checks run in a temporary
 * directory that is removed at the end.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, sep } from "node:path"
import { exportNdjson, importNdjson, openStatsDb, openStatsDbReadOnly, openStatsDbWrite, recordEvent, recordPrompt, recordStep, upsertSession } from "../src/stats/db"
import { dbInfo, pruneOlderThan, vacuum } from "../src/stats/maintenance"
import { sessions, turns } from "../src/stats/queries"
import { cacheDropsOf, cachePairs, cacheStatsOf, coverageOf, periodsOf, stepRows } from "../src/stats/aggregates"
import { createRecorder, type RecorderEvent } from "../src/recorder"
import { buildPanel, type PanelRequest } from "../src/panel-build"
import { PANEL_VIEWS, type PanelView } from "../src/panel-data"
import { defaultDbPath, resolveDbPath } from "../src/stats/paths"

const BASE = 1_800_000_000_000
const MIN = 60_000
const POSIX = process.platform !== "win32"

let failures = 0

/** One check: a name and what it must be able to do. */
function check(name: string, run: () => void): void {
  try {
    run()
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function main(): void {
  const directory = mkdtempSync(join(tmpdir(), "usage-insights-check-"))
  const path = join(directory, "usage.db")
  process.stdout.write(`opencode-usage-insights · platform check\n  ${process.platform} ${process.arch} · bun ${Bun.version} · home ${homedir()}\n\n`)

  try {
    check("resolves its database path for this OS", () => {
      const fallback = defaultDbPath()
      assert(fallback.length > 0, "the default database path is empty")
      assert(fallback.includes("opencode"), `unexpected default path: ${fallback}`)
      const expanded = resolveDbPath("~/usage-insights-check.db")
      assert(expanded.startsWith(homedir()), `~ was not expanded: ${expanded}`)
      assert(!expanded.includes("~"), `~ survived expansion: ${expanded}`)
      if (POSIX) assert(sep === "/", "a POSIX platform must use the forward slash")
    })

    check("creates the database, writes to it and reads it back", () => {
      const db = openStatsDb(path)
      upsertSession(db, { sessionID: "ses_check", title: "Platform check", directory: directory, startedAt: BASE })
      recordPrompt(db, { sessionID: "ses_check", messageID: "msg_prompt", createdAt: BASE })
      recordStep(db, {
        messageID: "msg_step",
        sessionID: "ses_check",
        providerID: "opencode",
        modelID: "claude-sonnet-4-5",
        input: 1_200,
        cacheRead: 90_000,
        output: 300,
        cost: 0.02,
        createdAt: BASE + MIN,
        streamedAt: BASE + MIN + 900,
        completedAt: BASE + MIN + 1_400,
        finish: "stop",
        router: "orcarouter-dsv4.1flash",
        recordedAt: BASE + MIN,
      })
      recordEvent(db, { sessionID: "ses_check", kind: "compaction", at: BASE + 2 * MIN })

      const coverage = coverageOf(db, { range: { from: BASE } })
      assert(coverage.steps === 1, `expected one step, got ${coverage.steps}`)
      assert(coverage.models === 1, "coverage does not see the model")
      const cache = cacheStatsOf(db, { range: { from: BASE } })
      assert(cache.cached === 90_000, "the cache read was not stored")
      assert(cache.steps === 1, "the cache stats do not see the step")
      assert(cacheDropsOf(db, cachePairs(db, { range: { from: BASE } })).length === 0, "a single step cannot be a reuse loss")
      assert(periodsOf(stepRows(db, { range: { from: BASE } }), "day").length === 1, "the periods view does not see the step")

      const rows = sessions(db, { range: { from: BASE } })
      assert(rows.length === 1 && rows[0]!.steps === 1, "the sessions view does not see the session")
      const turnRows = turns(db, { sessionID: "ses_check" })
      assert(turnRows.length === 1, `expected one turn, got ${turnRows.length}`)

      const info = dbInfo(db, path, BASE + 3 * MIN)
      assert(info.tables.find((table) => table.name === "steps")?.rows === 1, "the db view counts the step wrong")
      assert(info.firstAt === BASE + MIN || info.lastAt === BASE + MIN, "the db view does not see the window")
      db.close()
    })

    check("the reader opens it without a write connection", () => {
      const reader = openStatsDbReadOnly(path)
      const count = (reader.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }).n
      assert(count === 1, `expected one step, got ${count}`)
      let wrote = false
      try {
        reader.query("INSERT INTO events (session_id, kind) VALUES ('ses_check', 'x')").run()
        wrote = true
      } catch {
        wrote = false
      }
      assert(!wrote, "the read-only connection accepted a write")
      reader.close()
    })

    check("records a session from the event stream, endpoint included", () => {
      const db = openStatsDb(path)
      const recorder = createRecorder(db, { now: () => BASE + 5 * MIN })
      const events: RecorderEvent[] = [
        { type: "session.created", created: BASE, data: { sessionID: "ses_events", title: "Events", model: { providerID: "opencode", id: "m1" } } },
        { type: "session.step.started", created: BASE, data: { sessionID: "ses_events", assistantMessageID: "msg_event_step", model: { providerID: "opencode", id: "m1" } } },
      ]
      for (const event of events) recorder.handleEvent(event)
      recorder.handleHttpResponse({
        sessionID: "ses_events",
        model: { providerID: "opencode", id: "m1" },
        response: { headers: { "x-opencode-endpoint-id": "Gateway-1" } },
      })
      recorder.handleEvent({
        type: "session.step.ended",
        created: BASE + MIN,
        data: { sessionID: "ses_events", assistantMessageID: "msg_event_step", tokens: { input: 10, output: 2, cache: { read: 5 } } },
      })
      const row = db.query("SELECT session_id, router, input_tokens FROM steps WHERE message_id = 'msg_event_step'").get() as {
        session_id: string
        router: string | null
        input_tokens: number
      }
      assert(row.session_id === "ses_events", "the step was not recorded")
      assert(row.router === "gateway-1", `the endpoint was not normalized: ${row.router}`)
      assert(row.input_tokens === 10, "the tokens were not recorded")
      recorder.handleEvent({ type: "session.deleted", created: BASE + 2 * MIN, data: { sessionID: "ses_events" } })
      db.close()
    })

    check("renders every panel view", () => {
      const db = openStatsDb(path)
      const request: PanelRequest = {
        db,
        view: "overview",
        range: "all",
        filters: {},
        granularity: "day",
        turnsScope: "session",
        sort: "",
        sortDesc: true,
        sessionID: "ses_check",
        sessionStart: BASE,
        now: BASE + 10 * MIN,
        width: 120,
      }
      for (const view of PANEL_VIEWS) {
        const lines = buildPanel({
          ...request,
          view: view as PanelView,
          ...(view === "db" ? { database: dbInfo(db, path, BASE + 10 * MIN) } : {}),
        })
        assert(lines.length > 0, `the ${view} view rendered nothing`)
        assert(lines.some((line) => line.text.trim() !== ""), `the ${view} view rendered only blank lines`)
      }
      db.close()
    })

    check("prunes and compacts through a short-lived writer", () => {
      const handle = openStatsDbWrite(path)
      const pruned = pruneOlderThan(handle, BASE + 4 * MIN)
      assert(pruned.steps === 1, `expected one pruned step, got ${pruned.steps}`)
      const freed = vacuum(handle, path)
      assert(freed.freed >= 0, "vacuum reported a negative size")
      handle.close()
    })

    check("exports and imports a dump", () => {
      const db = openStatsDb(path)
      recordStep(db, {
        messageID: "msg_dump",
        sessionID: "ses_check",
        providerID: "opencode",
        modelID: "claude-haiku-4-5",
        input: 100,
        output: 20,
        cost: 0.001,
        createdAt: BASE + 6 * MIN,
        recordedAt: BASE + 6 * MIN,
      })
      const dump = exportNdjson(db)
      db.close()

      const copyPath = join(directory, "copy.db")
      const copy = openStatsDb(copyPath)
      const imported = importNdjson(copy, dump)
      assert(imported > 0, "the dump imported nothing")
      const rows = copy.query("SELECT COUNT(*) AS n FROM steps").get() as { n: number }
      assert(rows.n === 2, `expected two steps in the copy, got ${rows.n}`)
      copy.close()
    })

    if (POSIX) {
      check("keeps the database private to the user", () => {
        assert((statSync(path).mode & 0o777) === 0o600, `the database is ${(statSync(path).mode & 0o777).toString(8)}`)
        assert((statSync(directory).mode & 0o777) === 0o700, `the directory is ${(statSync(directory).mode & 0o777).toString(8)}`)
      })
    }
  } finally {
    // Windows refuses to unlink a file that still has an open handle, where
    // POSIX would remove the directory regardless. Collecting first releases
    // any statement the SQLite wrapper has not finalized, and the retries cover
    // the rest; a directory that survives even so is not a data-layer failure,
    // and the runner reaps its own temporary directories.
    Bun.gc(true)
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (error) {
      process.stdout.write(`  warn the temporary database outlived the checks: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  process.stdout.write(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`} on ${process.platform}\n`)
  if (failures > 0) process.exit(1)
}

main()
