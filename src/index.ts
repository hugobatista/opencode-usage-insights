import { Plugin } from "@opencode/plugin"
import type { Database } from "bun:sqlite"
import { costOf, priceTable, type PriceFn, type PriceTable } from "./pricing"
import { createRecorder, type RecorderEvent } from "./recorder"
import { openStatsDb } from "./stats/db"
import { resolveDbPath } from "./stats/paths"

/**
 * Server-side recorder. Subscribes to the session event stream and persists
 * every assistant step, prompt and lifecycle event into the stats database;
 * the TUI entry reads the same database for its live line and stats panel.
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
  /** SQLite database path override (defaults to the per-OS state directory). */
  db?: string | undefined
  /**
   * List-price estimates for steps the host reports as costing nothing.
   * `off` records charged money only; the TUI hides any stored estimates.
   */
  pricing?: "auto" | "off" | undefined
}

/** How long a loaded catalog is trusted before a background refresh. */
const PRICE_TTL_MS = 5 * 60 * 1000
/** Retry delay after a failed catalog load. */
const PRICE_RETRY_MS = 30 * 1000

/**
 * Catalog prices for the recorder, loaded from the host and refreshed in the
 * background. The recorder never waits for the catalog: until it lands, steps
 * are recorded exactly as before and the maintenance action can fill them in.
 */
function createPriceSource(ctx: { model: { list: () => Promise<unknown> } }): {
  price: PriceFn
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

export default Plugin.define({
  id: "usage-insights",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    if (options.enabled === false) return

    const db = tryOpen(resolveDbPath(options.db))
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
    const source = pricing ? createPriceSource(ctx) : undefined
    // Load the catalog without delaying the recorder; the first steps may be
    // unpriced and the maintenance action can fill them in later.
    source?.refresh(true)

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
      await stream
      db.close()
    }
  },
})
