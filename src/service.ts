import type { Database } from "bun:sqlite"
import { basename } from "node:path"
import { clampPanelWidth, clampTurnsLimit } from "./limits"
import { buildPanel, type PanelRequest } from "./panel-build"
import {
  defaultSort,
  sessionSummaryLines,
  sidebarLines,
  sanitizeSettings,
  type LineFormatOptions,
  type PanelSettings,
} from "./panel-data"
import { costOf, type PriceTable } from "./pricing"
import { openStatsDbWrite } from "./stats/db"
import { backfillListCost, dbInfo, pruneOlderThan, vacuum, wipeAll, type BackfillResult, type DbInfo, type PruneResult, type WipeResult } from "./stats/maintenance"
import { filterOptions, overview, sessionListCost, turns, type FilterOption, type Filters } from "./stats/queries"
import type {
  BackfillInput,
  FiltersOutput,
  ListCostInput,
  ListCostOutput,
  PanelInput,
  PanelOutput,
  PruneInput,
  TurnsInput,
  TurnsOutput,
  VacuumInput,
  VacuumOutput,
  WipeInput,
} from "./rpc"

/**
 * The database-facing half of the plugin. It runs on the server (in-process as
 * a fallback, or inside `stats-worker`) and is the only code that reads or
 * writes the SQLite file for the panel, sidebar and maintenance actions. The
 * TUI and the desktop GUI only see the validated RPC surface.
 */

const DAY = 24 * 60 * 60 * 1000
const MAX_DAYS = 3650

export type ServiceErrorCode = "busy" | "unavailable" | "disabled" | "invalid"

export class ServiceError extends Error {
  readonly code: ServiceErrorCode

  constructor(code: ServiceErrorCode, message: string) {
    super(message)
    this.name = "ServiceError"
    this.code = code
  }
}

export type ServiceOptions = {
  /** Database file path, for maintenance and for the `db` view. */
  path: string
  /** `false` hides list-price estimates and disables the backfill. */
  pricing: boolean
  /** `false` exposes read methods only. */
  maintenance: boolean
  /** `false` returns a redacted path instead of the absolute one. */
  exposePaths: boolean
  /** Formatting options shared by the panel and the turn history. */
  format: LineFormatOptions
  /** Server-side catalog for the historical backfill. */
  priceTable?: (() => PriceTable | undefined) | undefined
}

export type Service = ReturnType<typeof createService>

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

/** The `session` range starts when the session was created, not when a step ran. */
function sessionStart(db: Database, sessionID: string): number | undefined {
  const session = db.query("SELECT started_at AS at FROM sessions WHERE session_id = ?").get(sessionID) as
    | { at: number | null }
    | null
  if (session?.at !== null && session?.at !== undefined) return session.at
  const step = db
    .query("SELECT MIN(COALESCE(created_at, recorded_at)) AS at FROM steps WHERE session_id = ?")
    .get(sessionID) as { at: number | null } | null
  return step?.at ?? undefined
}

function redact(info: DbInfo, exposePaths: boolean): DbInfo {
  if (exposePaths) return info
  return { ...info, path: basename(info.path) }
}

function filtersOf(settings: PanelSettings): Filters {
  return {
    ...(settings.modelID !== "" ? { modelID: settings.modelID } : {}),
    ...(settings.providerID !== "" ? { provider: settings.providerID } : {}),
  }
}

function writeDb<T>(path: string, run: (db: Database) => T): T {
  let db: Database | undefined
  try {
    db = openStatsDbWrite(path)
    return run(db)
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError("busy", "the database is busy; try again in a moment")
  } finally {
    db?.close()
  }
}

export function createService(db: () => Database, options: ServiceOptions) {
  const settingsOf = (input: PanelInput): PanelSettings => sanitizeSettings(input.settings)

  function infoOf(): DbInfo {
    return redact(dbInfo(db(), options.path), options.exposePaths)
  }

  function panel(input: PanelInput): PanelOutput {
    const settings = settingsOf(input)
    const database = settings.view === "db" ? infoOf() : undefined
    const width = clampPanelWidth(input.width)
    const filters = filtersOf(settings)
    const request: PanelRequest = {
      db: db(),
      view: settings.view,
      range: settings.range,
      filters,
      granularity: settings.granularity,
      turnsScope: settings.turnsScope,
      sort: settings.sort === "" ? defaultSort(settings.view) : settings.sort,
      sortDesc: settings.sortDesc,
      sessionID: input.sessionID,
      sessionStart: sessionStart(db(), input.sessionID),
      now: Date.now(),
      format: { ...options.format, estimates: options.pricing },
      estimates: options.pricing,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(database !== undefined ? { database } : {}),
      busy: input.busy === true,
      width,
    }
    return { lines: buildPanel(request), ...(database !== undefined ? { database } : {}) }
  }

  function turnHistory(input: TurnsInput): TurnsOutput {
    const handle = db()
    const width = clamp(input.width, 20, 120)
    const limit = clampTurnsLimit(input.limit)
    const summary = sessionSummaryLines(overview(handle, undefined, { sessionID: input.sessionID }), width, options.pricing)
    const history = sidebarLines(turns(handle, { sessionID: input.sessionID, limit }), {
      ...options.format,
      estimates: options.pricing,
      budget: width,
    })
    return { summary, history }
  }

  function listCost(input: ListCostInput): ListCostOutput {
    if (!options.pricing) return { cost: 0 }
    return { cost: sessionListCost(db(), input.sessionID) }
  }

  function filters(): FiltersOutput {
    return filterOptions(db())
  }

  function requireMaintenance(): void {
    if (!options.maintenance) throw new ServiceError("disabled", "database maintenance is disabled")
  }

  function requireConfirm(confirm: boolean | undefined): void {
    if (confirm !== true) throw new ServiceError("invalid", "confirmation is required")
  }

  function prune(input: PruneInput): PruneResult {
    requireMaintenance()
    requireConfirm(input.confirm)
    const days = clamp(input.days, 1, MAX_DAYS)
    return writeDb(options.path, (handle) => pruneOlderThan(handle, Date.now() - days * DAY))
  }

  function wipe(input: WipeInput): WipeResult {
    requireMaintenance()
    requireConfirm(input.confirm)
    return writeDb(options.path, (handle) => wipeAll(handle))
  }

  function compact(input: VacuumInput): VacuumOutput {
    requireMaintenance()
    requireConfirm(input.confirm)
    return writeDb(options.path, (handle) => vacuum(handle, options.path))
  }

  function backfill(input: BackfillInput, table?: PriceTable | undefined): BackfillResult {
    if (!options.pricing) throw new ServiceError("disabled", "list-price estimates are turned off")
    requireMaintenance()
    requireConfirm(input.confirm)
    const prices = table ?? options.priceTable?.()
    if (prices === undefined) throw new ServiceError("unavailable", "the model catalog is unavailable")
    return writeDb(options.path, (handle) => backfillListCost(handle, (ref, tokens) => costOf(prices, ref, tokens)))
  }

  return {
    panel,
    turnHistory,
    listCost,
    filters,
    dbInfo: infoOf,
    prune,
    wipe,
    compact,
    backfill,
  }
}
