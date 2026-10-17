import { Plugin } from "@opencode/plugin"
import type { Database } from "bun:sqlite"
import { createRecorder, type HttpResponseInput, type RecorderEvent } from "./recorder"
import { openStatsDb } from "./stats/db"
import { resolveDbPath } from "./stats/paths"

/**
 * Server-side recorder. Subscribes to the session event stream and persists
 * every assistant step, prompt and lifecycle event into the stats database;
 * the TUI entry reads the same database for its live line and stats panel.
 *
 * The plugin is observational: it never rewrites prompts, requests or
 * responses, and a failure inside the recorder is swallowed so a session can
 * never be interrupted by its own telemetry.
 */

export type Options = {
  /** Turn recording off: no event subscription, no database. */
  enabled?: boolean | undefined
  /** SQLite database path override (defaults to the per-OS state directory). */
  db?: string | undefined
  /** Store redacted model response headers as upstream-discovery evidence. */
  captureHeaders?: boolean | undefined
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

    // Provider packages name the operator when the user configured a
    // per-operator provider (`@opencode/ai/providers/fireworks`). The catalogue
    // is fetched once and refreshed when providers change; it is only a
    // last-resort source, so a failure just leaves the package unknown.
    const packages = new Map<string, string | undefined>()
    async function refreshPackages(): Promise<void> {
      try {
        const result = await ctx.provider.list()
        packages.clear()
        for (const provider of result.data ?? []) packages.set(provider.id, provider.package)
      } catch {
        // Keep whatever was known before.
      }
    }
    void refreshPackages()

    const recorder = createRecorder(db, {
      captureHeaders: options.captureHeaders === true,
      providerPackage: (providerID) => (providerID === undefined ? undefined : packages.get(providerID)),
    })
    const abort = new AbortController()
    const stream = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            if (event.type === "provider.updated" || event.type === "model.updated") void refreshPackages()
            recorder.handleEvent(event as RecorderEvent)
          } catch {
            // A malformed event must never break the stream.
          }
        }
      } catch {
        // Subscription closed (shutdown or transport error): nothing to do.
      }
    })()

    let hook: { dispose: () => Promise<void> } | undefined
    try {
      hook = await ctx.session.hook("http.response", (event) => {
        try {
          recorder.handleHttpResponse(event as HttpResponseInput)
        } catch {
          // Discovery is best-effort.
        }
      })
    } catch {
      hook = undefined
    }

    return async () => {
      await hook?.dispose()
      abort.abort()
      await stream
      db.close()
    }
  },
})
