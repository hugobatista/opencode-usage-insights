import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "../src/panel-data"
import { createService } from "../src/service"
import { openStatsDb, openStatsDbReadOnly, recordStep, upsertSession } from "../src/stats/db"
import { StatsClient } from "../src/stats-client"

const directory = mkdtempSync(join(tmpdir(), "usage-insights-client-"))
const path = join(directory, "usage.db")
const db = openStatsDb(path)
upsertSession(db, { sessionID: "ses_client", startedAt: Date.now() - 60_000 })
recordStep(db, {
  messageID: "msg_client",
  sessionID: "ses_client",
  providerID: "opencode",
  modelID: "deepseek-v4.1-flash",
  input: 1_000,
  output: 10,
  cost: 0.01,
  createdAt: Date.now() - 50_000,
  completedAt: Date.now() - 40_000,
})
db.close()

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

function fallback() {
  return createService(() => openStatsDbReadOnly(path), {
    path,
    pricing: true,
    maintenance: false,
    exposePaths: false,
    format: { estimates: true },
  })
}

describe("the worker client fallback", () => {
  test("serves panel and history when no worker entrypoint exists", async () => {
    const client = new StatsClient({
      dbPath: path,
      options: { pricing: true, maintenance: false, exposePaths: false, format: { estimates: true } },
      fallback,
      workerUrl: () => undefined,
    })
    try {
      const panel = (await client.request("panel", { sessionID: "ses_client", settings: DEFAULT_SETTINGS, width: 80 })) as {
        lines: unknown[]
      }
      expect(panel.lines.length).toBeGreaterThan(0)
      const history = (await client.request("turns", { sessionID: "ses_client", limit: 4, width: 40 })) as {
        history: unknown[]
      }
      expect(history.history.length).toBeGreaterThan(0)
      const info = (await client.request("dbInfo", {})) as { path: string }
      expect(info.path).toBe("usage.db")
    } finally {
      client.stop()
    }
  })

  test("rejects a maintenance request the service disables", async () => {
    const client = new StatsClient({
      dbPath: path,
      options: { pricing: true, maintenance: false, exposePaths: false, format: { estimates: true } },
      fallback,
      workerUrl: () => undefined,
    })
    try {
      await expect(client.request("prune", { days: 30, confirm: true })).rejects.toMatchObject({ code: "disabled" })
    } finally {
      client.stop()
    }
  })
})
