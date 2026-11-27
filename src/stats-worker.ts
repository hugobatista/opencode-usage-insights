import type { Database } from "bun:sqlite"
import { openStatsDbReadOnly } from "./stats/db"
import { createService, ServiceError, type ServiceOptions } from "./service"
import type {
  BackfillInput,
  PanelInput,
  PruneInput,
  TurnsInput,
  VacuumInput,
  WipeInput,
} from "./rpc"
import type { ModelPrice, PriceTable } from "./pricing"

/**
 * The database worker. It owns the read-only SQLite connection and runs the
 * panel queries, the turn history and the optional maintenance writes away
 * from the server's event loop. The server speaks to it through
 * `stats-client.ts`; the protocol is private to the plugin.
 */

type WorkerInit = {
  type: "init"
  dbPath: string
  options: Omit<ServiceOptions, "path" | "priceTable">
}

type WorkerRequest = {
  id: number
  method: "panel" | "turns" | "listCost" | "filters" | "dbInfo" | "prune" | "wipe" | "vacuum" | "backfill"
  input: unknown
  /** Serialized catalog for a backfill; undefined for every other method. */
  prices?: [string, ModelPrice][] | undefined
}

type WorkerMessage = WorkerInit | WorkerRequest

type WorkerResponse =
  | { type: "ready" }
  | { type: "error"; error: { code: string; message: string } }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null
  postMessage: (message: WorkerResponse) => void
}

const scope = globalThis as unknown as WorkerScope

let dbPath: string | undefined
let readDb: Database | undefined
let service: ReturnType<typeof createService> | undefined

function read(): Database {
  if (readDb === undefined) {
    if (dbPath === undefined) throw new ServiceError("unavailable", "the usage database is not configured")
    readDb = openStatsDbReadOnly(dbPath)
  }
  return readDb
}

function closeRead(): void {
  readDb?.close()
  readDb = undefined
}

function reopen(): void {
  try {
    read()
  } catch {
    // A missing database is reported by the next read; nothing to do here.
  }
}

function serializedPrices(entries: [string, ModelPrice][] | undefined): PriceTable | undefined {
  if (entries === undefined) return undefined
  return new Map(entries)
}

function run(request: WorkerRequest): unknown {
  if (service === undefined) throw new ServiceError("unavailable", "the usage worker is not initialized")
  const maintenance = request.method === "prune" || request.method === "wipe" || request.method === "vacuum" || request.method === "backfill"
  if (maintenance) closeRead()
  try {
    switch (request.method) {
      case "panel":
        return service.panel(request.input as PanelInput)
      case "turns":
        return service.turnHistory(request.input as TurnsInput)
      case "listCost":
        return service.listCost(request.input as { sessionID: string })
      case "filters":
        return service.filters()
      case "dbInfo":
        return service.dbInfo()
      case "prune":
        return service.prune(request.input as PruneInput)
      case "wipe":
        return service.wipe(request.input as WipeInput)
      case "vacuum":
        return service.compact(request.input as VacuumInput)
      case "backfill":
        return service.backfill(request.input as BackfillInput, serializedPrices(request.prices))
    }
  } finally {
    if (maintenance) reopen()
  }
}

function failure(error: unknown): { code: string; message: string } {
  if (error instanceof ServiceError) return { code: error.code, message: error.message }
  return { code: "unavailable", message: "the usage database is unavailable" }
}

scope.onmessage = (event) => {
  const message = event.data

  if ("type" in message && message.type === "init") {
    dbPath = message.dbPath
    service = createService(read, { ...message.options, path: message.dbPath })
    closeRead()
    try {
      read()
      scope.postMessage({ type: "ready" })
    } catch (error) {
      scope.postMessage({ type: "error", error: failure(error) })
    }
    return
  }

  const request = message as WorkerRequest
  try {
    const result = run(request)
    scope.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, error: failure(error) })
  }
}
