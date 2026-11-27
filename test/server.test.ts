import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "../src/panel-data"
import type { PanelInput, PruneInput, TurnsInput, WipeInput } from "../src/rpc"
import { openStatsDb, recordPrompt, recordStep, upsertSession } from "../src/stats/db"

const directory = mkdtempSync(join(tmpdir(), "usage-insights-server-"))
const path = join(directory, "usage.db")

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

type Handler = (input: unknown, context?: { error: (type: string, message: string) => unknown }) => Promise<unknown>
type Handlers = Record<string, Handler>

function seed(): void {
  const db = openStatsDb(path)
  upsertSession(db, { sessionID: "ses_server", title: "Server session", directory, startedAt: Date.now() - 60_000 })
  recordPrompt(db, { sessionID: "ses_server", messageID: "prt_server", createdAt: Date.now() - 60_000 })
  recordStep(db, {
    messageID: "msg_server",
    sessionID: "ses_server",
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    input: 1_234_567,
    cacheRead: 7_654_321,
    output: 4_200,
    cost: 1.5,
    createdAt: Date.now() - 50_000,
    completedAt: Date.now() - 40_000,
  })
  recordStep(db, {
    messageID: "msg_server_old",
    sessionID: "ses_server",
    input: 10,
    cost: 0,
    createdAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
    recordedAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
    completedAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
  })
  db.close()
}

async function start(options: Record<string, unknown> = {}): Promise<{
  handlers: Handlers
  cleanup: () => Promise<void>
  emitted: unknown[]
}> {
  const mod = await import("../src/index")
  let handlers: Handlers = {}
  const emitted: unknown[] = []
  const ctx = {
    options: { db: path, ...options },
    location: { directory },
    model: {
      list: () =>
        Promise.resolve({
          data: [
            {
              providerID: "opencode-go",
              modelID: "deepseek-v4.1-flash",
              cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
            },
          ],
        }),
    },
    rpc: {
      register: async (_definition: unknown, next: Handlers) => {
        handlers = next
        return { dispose: async () => {}, events: { emit: async (...args: unknown[]) => { emitted.push(args) } } }
      },
    },
    event: {
      subscribe: async function* (input: { signal?: AbortSignal } = {}) {
        while (input.signal?.aborted !== true) await Bun.sleep(1)
      },
    },
    app: { name: "opencode", version: "2.4.2", channel: "prod" },
  }
  const cleanup = (await mod.default.setup(ctx as never)) as (() => Promise<void>) | undefined
  if (cleanup === undefined) throw new Error("the server plugin did not start")
  return { handlers, cleanup, emitted }
}

const settings = { ...DEFAULT_SETTINGS, view: "overview" as const }

describe("the usage RPC server", () => {
  test("serves the panel and the turn history through the worker", async () => {
    seed()
    const server = await start()
    try {
      const panel = (await server.handlers.panel!({
        sessionID: "ses_server",
        settings,
        width: 100,
      } satisfies PanelInput)) as { lines: { text: string }[] }
      expect(panel.lines.some((line) => line.text.includes("usage insights") || line.text.includes("cached"))).toBe(true)

      const turns = (await server.handlers.turns!({
        sessionID: "ses_server",
        limit: 8,
        width: 60,
      } satisfies TurnsInput)) as { summary: { text: string }[]; history: { text: string }[] }
      expect(turns.summary.length).toBeGreaterThan(0)
      expect(turns.history.length).toBeGreaterThan(0)

      const cost = (await server.handlers.listCost!({ sessionID: "ses_server" })) as { cost: number }
      expect(cost.cost).toBe(0)
    } finally {
      await server.cleanup()
    }
  })

  test("redacts the database path by default", async () => {
    seed()
    const server = await start({ exposePaths: false })
    try {
      const panel = (await server.handlers.panel!({
        sessionID: "ses_server",
        settings: { ...settings, view: "db" },
        width: 100,
      } satisfies PanelInput)) as { database?: { path: string } }
      expect(panel.database?.path).toBe("usage.db")
    } finally {
      await server.cleanup()
    }
  })

  test("refuses maintenance when it is disabled", async () => {
    seed()
    const server = await start({ maintenance: false })
    try {
      const result = (await server.handlers.prune!(
        { days: 30, confirm: true } satisfies PruneInput,
        { error: (type, message) => ({ type, message }) },
      )) as { type: string }
      expect(result.type).toBe("disabled")
      const wipe = (await server.handlers.wipe!(
        { confirm: true } satisfies WipeInput,
        { error: (type, message) => ({ type, message }) },
      )) as { type: string }
      expect(wipe.type).toBe("disabled")
    } finally {
      await server.cleanup()
    }
  })

  test("requires an explicit confirmation", async () => {
    seed()
    const server = await start()
    try {
      const result = (await server.handlers.prune!(
        { days: 30, confirm: false } as never,
        { error: (type, message) => ({ type, message }) },
      )) as { type: string }
      expect(result.type).toBe("invalid")
    } finally {
      await server.cleanup()
    }
  })

  test("treats a session id as data, not SQL", async () => {
    seed()
    const server = await start()
    try {
      const cost = (await server.handlers.listCost!({ sessionID: "x' OR 1=1 --" })) as { cost: number }
      expect(cost.cost).toBe(0)
    } finally {
      await server.cleanup()
    }
  })

  test("prunes only when maintenance is enabled", async () => {
    seed()
    const server = await start()
    try {
      const result = (await server.handlers.prune!({ days: 30, confirm: true } satisfies PruneInput)) as {
        steps: number
      }
      expect(result.steps).toBe(1)
    } finally {
      await server.cleanup()
    }
  })

  test("wipes every recorded row, including the sessions", async () => {
    seed()
    const server = await start()
    try {
      const result = (await server.handlers.wipe!({ confirm: true } satisfies WipeInput)) as {
        steps: number
        prompts: number
        sessions: number
      }
      expect(result).toMatchObject({ steps: 2, prompts: 1, sessions: 1 })

      const db = openStatsDb(path)
      try {
        for (const table of ["sessions", "prompts", "events", "steps", "usage"]) {
          expect((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0)
        }
      } finally {
        db.close()
      }
    } finally {
      await server.cleanup()
    }
  })

  test("requires an explicit confirmation to wipe", async () => {
    seed()
    const server = await start()
    try {
      const result = (await server.handlers.wipe!(
        { confirm: false } as never,
        { error: (type, message) => ({ type, message }) },
      )) as { type: string }
      expect(result.type).toBe("invalid")
    } finally {
      await server.cleanup()
    }
  })
})
