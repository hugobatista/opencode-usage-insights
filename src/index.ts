import { Plugin } from "@opencode/plugin"
import type { Database } from "bun:sqlite"
import type { LineFields, LineLabels, TurnTotalsView } from "./core"
import { UsageInsights, type BackfillInput, type PanelInput, type PruneInput, type TurnsInput, type VacuumInput, type WipeInput } from "./rpc"
import { costOf, priceTable, type PriceFn, type PriceTable } from "./pricing"
import { createRecorder, type RecorderEvent } from "./recorder"
import { createService, ServiceError } from "./service"
import { openStatsDb } from "./stats/db"
import { resolveDbPath } from "./stats/paths"
import { StatsClient, StatsError } from "./stats-client"

/**
 * Server-side recorder. Subscribes to the session event stream and persists
 * every assistant step, prompt and lifecycle event into the stats database.
 *
 * The same setup also serves the usage RPC: the TUI and the desktop GUI read
 * the database through the worker-backed service instead of opening SQLite
 * themselves. That is what makes the plugin work when a client is connected
 * to a server on another machine.
 *
 * Everything the recorder stores comes from the event stream — the provider
 * and model a step ran as, the tokens and the timing. The plugin is
 * observational: it never rewrites prompts, requests or responses, registers
 * no hook on the request path, and a failure inside the recorder is swallowed
 * so a session can never be interrupted by its own telemetry.
 */

export type Options = {
  /** Turn recording off: no event subscription, no database. */
  enabled?: boolean | undefined
  /** SQLite database path override (server-side; defaults to the per-OS state directory). */
  db?: string | undefined
  /**
   * List-price estimates for steps the host reports as costing nothing.
   * `off` records charged money only; every client hides stored estimates.
   */
  pricing?: "auto" | "off" | undefined
  /** Allow the RPC to prune, wipe, vacuum and backfill. Defaults to true. */
  maintenance?: boolean | undefined
  /**
   * Return the absolute database path in the `db` view.
   * Defaults to false, which returns only the file name.
   */
  exposePaths?: boolean | undefined
  /** Telemetry line field toggles, shared with the clients. */
  fields?: Partial<LineFields> | undefined
  /** Telemetry line label overrides, shared with the clients. */
  labels?: Partial<LineLabels> | undefined
  /** How the turn segment counts prompt usage. */
  turnTotals?: TurnTotalsView | undefined
}

/** How long a loaded catalog is trusted before a background refresh. */
const PRICE_TTL_MS = 5 * 60 * 1000
/** Retry delay after a failed catalog load. */
const PRICE_RETRY_MS = 30 * 1000

/** Events whose write can change a panel or a turn history. */
const RECORDED_EVENTS = new Set([
  "session.created",
  // `session.renamed` and `session.moved` write the session row;
  // `session.updated` is not a recorder write.
  "session.renamed",
  "session.moved",
  "session.inbox.enqueued",
  "session.step.ended",
  "session.step.failed",
  "session.usage.recorded",
  "session.compaction.ended",
])

/**
 * Catalog prices for the recorder, loaded from the host and refreshed in the
 * background. The recorder never waits for the catalog: until it lands, steps
 * are recorded exactly as before and the maintenance action can fill them in.
 */
function createPriceSource(ctx: { model: { list: () => Promise<unknown> } }): {
  price: PriceFn
  table: () => PriceTable | undefined
  refresh: (force?: boolean) => void
} {
  let table: PriceTable | undefined
  let refreshing = false
  let lastAttempt = 0

  function refresh(force = false): void {
    if (refreshing) return
    const now = Date.now()
    const wait = table === undefined ? PRICE_RETRY_MS : PRICE_TTL_MS
    if (!force && now - lastAttempt < wait) return
    lastAttempt = now
    refreshing = true
    void (async () => {
      try {
        const payload = (await ctx.model.list()) as { data?: unknown } | unknown
        const models = Array.isArray(payload) ? payload : (payload as { data?: unknown } | null | undefined)?.data
        // An empty list is not a catalog: keep the previous table and retry.
        if (Array.isArray(models) && models.length > 0) table = priceTable(models as never)
      } catch {
        // A catalog that cannot be read keeps the previous table: recording is
        // more important than the estimate.
      } finally {
        refreshing = false
      }
    })()
  }

  return {
    price: (ref, tokens) => {
      refresh()
      return table === undefined ? undefined : costOf(table, ref, tokens)
    },
    table: () => table,
    refresh,
  }
}

function tryOpen(path: string): Database | undefined {
  try {
    return openStatsDb(path)
  } catch {
    return undefined
  }
}

function rpcFailure(
  context: { error: (type: "busy" | "unavailable" | "disabled" | "invalid", message: string) => unknown },
  error: unknown,
): unknown {
  if (error instanceof StatsError || error instanceof ServiceError) return context.error(error.code, error.message)
  return context.error("unavailable", "the usage database is unavailable")
}

export default Plugin.define({
  id: "usage-insights",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    if (options.enabled === false) return

    const path = resolveDbPath(options.db)
    const db = tryOpen(path)
    if (db === undefined) return

    // The recorder's connection runs on the agent's own event path, so it waits
    // at most a second for another writer and then defers the write: a stalled
    // event handler is worse than a record that lands on the next event.
    try {
      db.exec("PRAGMA busy_timeout = 1000")
    } catch {
      // A database that cannot take the pragma is still usable.
    }

    const pricing = options.pricing !== "off"
    const maintenance = options.maintenance !== false
    const exposePaths = options.exposePaths === true
    const source = pricing ? createPriceSource(ctx) : undefined
    // Load the catalog without delaying the recorder; the first steps may be
    // unpriced and the maintenance action can fill them in later.
    source?.refresh(true)

    const format = {
      ...(options.labels !== undefined ? { labels: options.labels } : {}),
      ...(options.fields !== undefined ? { fields: options.fields } : {}),
      ...(options.turnTotals !== undefined ? { turnTotals: options.turnTotals } : {}),
    }
    const serviceOptions = { pricing, maintenance, exposePaths, format }
    const stats = new StatsClient({
      dbPath: path,
      options: serviceOptions,
      priceTable: () => source?.table(),
      fallback: () =>
        createService(() => db, {
          ...serviceOptions,
          path,
          priceTable: () => source?.table(),
        }),
      log: (message) => console.warn(`[usage-insights] ${message}`),
    })

    const registration = await ctx.rpc
      .register(UsageInsights, {
        panel: async (input, context) => {
          try {
            return await stats.request("panel", input as PanelInput)
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        turns: async (input, context) => {
          try {
            return await stats.request("turns", input as TurnsInput)
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        listCost: async (input, context) => {
          try {
            return await stats.request("listCost", input as { sessionID: string })
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        filters: async (_input, context) => {
          try {
            return await stats.request("filters", {})
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        dbInfo: async (_input, context) => {
          try {
            return await stats.request("dbInfo", {})
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        prune: async (input, context) => {
          try {
            return await stats.request("prune", input as PruneInput)
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        wipe: async (input, context) => {
          try {
            return await stats.request("wipe", input as WipeInput)
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        vacuum: async (input, context) => {
          try {
            return await stats.request("vacuum", input as VacuumInput)
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
        backfill: async (input, context) => {
          try {
            return await stats.request("backfill", input as BackfillInput)
          } catch (error) {
            return rpcFailure(context, error)
          }
        },
      })
      .catch((error: unknown) => {
        stats.stop()
        db.close()
        throw error
      })

    const recorder = createRecorder(db, source === undefined ? undefined : { price: source.price })
    const abort = new AbortController()
    const stream = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            // The event carries no model details: a catalog refresh is the only
            // way to pick up a price change.
            if (event.type === "model.updated") source?.refresh(true)
            recorder.handleEvent(event as RecorderEvent)
            if (RECORDED_EVENTS.has(event.type)) {
              const data = (event as { data?: { sessionID?: unknown } }).data
              const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
              void registration.events
                .emit("recorded", { at: Date.now(), ...(sessionID !== undefined ? { sessionID } : {}) })
                .catch(() => {})
            }
          } catch {
            // A malformed event must never break the stream.
          }
        }
      } catch {
        // Subscription closed (shutdown or transport error): nothing to do.
      }
    })()

    return async () => {
      abort.abort()
      await registration.dispose()
      await stream
      stats.stop()
      db.close()
    }
  },
})
