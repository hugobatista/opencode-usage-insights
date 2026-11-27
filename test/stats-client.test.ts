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

type FakeWorkerInstance = {
  terminated: number
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

function withFakeWorker<T>(run: (instances: FakeWorkerInstance[]) => Promise<T> | T): Promise<T> {
  const previous = globalThis.Worker
  const instances: FakeWorkerInstance[] = []
  class FakeWorker implements FakeWorkerInstance {
    terminated = 0
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null

    constructor() {
      instances.push(this)
    }

    postMessage(message: unknown): void {
      if (typeof message === "object" && message !== null && (message as { type?: string }).type === "init") {
        queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent))
      }
    }

    terminate(): void {
      this.terminated += 1
    }
  }
  ;(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker
  return Promise.resolve()
    .then(() => run(instances))
    .finally(() => {
      ;(globalThis as unknown as { Worker: unknown }).Worker = previous
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

describe("the worker client lifecycle", () => {
  test("terminates a worker that is still starting when stopped", async () => {
    await withFakeWorker(async (instances) => {
      const client = new StatsClient({
        dbPath: path,
        options: { pricing: true, maintenance: false, exposePaths: false, format: { estimates: true } },
        fallback,
        workerUrl: () => new URL("file:///fake-worker.js"),
        timeouts: { start: 1_000 },
      })
      const pending = client.request("panel", { sessionID: "ses_client", settings: DEFAULT_SETTINGS, width: 80 })
      expect(instances).toHaveLength(1)
      client.stop()
      await expect(pending).rejects.toMatchObject({ code: "unavailable" })
      // At least the stop; a late `ready` must not revive it either.
      expect(instances[0]!.terminated).toBeGreaterThan(0)
    })
  })

  test("gives maintenance its own watchdog instead of the read timeout", async () => {
    await withFakeWorker(async (instances) => {
      const client = new StatsClient({
        dbPath: path,
        options: { pricing: true, maintenance: true, exposePaths: false, format: { estimates: true } },
        fallback,
        workerUrl: () => new URL("file:///fake-worker.js"),
        timeouts: { read: 5, maintenance: 1_000, start: 100 },
      })
      const pending = client.request("prune", { days: 30, confirm: true })
      // The read watchdog would have killed the worker by now.
      await Bun.sleep(20)
      expect(instances[0]!.terminated).toBe(0)
      client.stop()
      await expect(pending).rejects.toMatchObject({ code: "unavailable" })
      expect(instances[0]!.terminated).toBeGreaterThan(0)
    })
  })
})
