import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Service, ServiceErrorCode, ServiceOptions } from "./service"
import type { PriceTable } from "./pricing"

/**
 * Server-side client for the database worker. It starts the worker lazily,
 * keeps a bounded queue in front of it, and falls back to an in-process
 * service when a worker cannot start (development, unsupported runtime).
 *
 * The worker runs every panel query off the server's event loop. A request
 * that hangs is terminated with the worker and reported as `unavailable`; the
 * next request starts a fresh one.
 */

export type StatsErrorCode = ServiceErrorCode

export class StatsError extends Error {
  readonly code: StatsErrorCode

  constructor(code: StatsErrorCode, message: string) {
    super(message)
    this.name = "StatsError"
    this.code = code
  }
}

export type StatsMethod = "panel" | "turns" | "listCost" | "filters" | "dbInfo" | "prune" | "vacuum" | "backfill"

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: (() => void) | undefined
}

type WorkerLike = {
  postMessage(message: unknown): void
  terminate(): unknown
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

type WorkerConstructor = new (url: URL) => WorkerLike

const QUEUE_LIMIT = 8
const REQUEST_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 5_000

export type StatsClientOptions = {
  /** Absolute database path, resolved by the server plugin. */
  dbPath: string
  /** Options passed to the worker's service. */
  options: Omit<ServiceOptions, "path" | "priceTable">
  /** Current server catalog for a backfill. */
  priceTable?: (() => PriceTable | undefined) | undefined
  /** In-process service used when the worker cannot start. */
  fallback: () => Service
  /** Worker entrypoint override, for tests. */
  workerUrl?: (() => URL | undefined) | undefined
  /** Diagnostics sink. */
  log?: ((message: string) => void) | undefined
}

function defaultWorkerUrl(): URL | undefined {
  try {
    const js = new URL("./stats-worker.js", import.meta.url)
    if (existsSync(fileURLToPath(js))) return js
    const ts = new URL("./stats-worker.ts", import.meta.url)
    if (existsSync(fileURLToPath(ts))) return ts
  } catch {
    // Fall through to the in-process service.
  }
  return undefined
}

export class StatsClient {
  private worker: WorkerLike | undefined
  private startPromise: Promise<void> | undefined
  private starting: WorkerLike | undefined
  private fallbackService: Service | undefined
  private fallbackMode = false
  private stopped = false
  private nextID = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly config: StatsClientOptions) {}

  /** A request with no caller-side cancellation. */
  request<T>(method: StatsMethod, input: unknown, options: { signal?: AbortSignal | undefined } = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new StatsError("unavailable", "the usage service is stopped"))

    if (this.fallbackMode) return Promise.resolve().then(() => this.callService(method, input) as T)

    return this.ensureWorker().then(() => {
      if (this.fallbackMode) return this.callService(method, input) as T
      if (this.pending.size >= QUEUE_LIMIT) throw new StatsError("busy", "too many usage requests are already running")
      return this.send<T>(method, input, options.signal)
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.rejectAll(new StatsError("unavailable", "the usage service stopped"))
    this.worker?.terminate()
    this.worker = undefined
    this.starting = undefined
  }

  private callService(method: StatsMethod, input: unknown): unknown {
    const service = (this.fallbackService ??= this.config.fallback())
    switch (method) {
      case "panel":
        return service.panel(input as never)
      case "turns":
        return service.turnHistory(input as never)
      case "listCost":
        return service.listCost(input as never)
      case "filters":
        return service.filters()
      case "dbInfo":
        return service.dbInfo()
      case "prune":
        return service.prune(input as never)
      case "vacuum":
        return service.compact(input as never)
      case "backfill":
        return service.backfill(input as never, this.config.priceTable?.())
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.worker !== undefined) return Promise.resolve()
    if (this.startPromise !== undefined) return this.startPromise

    const url = this.config.workerUrl?.() ?? defaultWorkerUrl()
    if (url === undefined) {
      this.useFallback("the worker entrypoint was not found")
      return Promise.resolve()
    }

    const ctor = (globalThis as unknown as { Worker?: WorkerConstructor }).Worker
    if (ctor === undefined) {
      this.useFallback("this runtime has no worker support")
      return Promise.resolve()
    }

    this.startPromise = new Promise<void>((resolve) => {
      let settled = false
      let worker: WorkerLike
      try {
        worker = new ctor(url)
      } catch (error) {
        this.useFallback(error instanceof Error ? error.message : "the usage worker could not be created")
        resolve()
        return
      }
      this.starting = worker
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (ok: boolean, reason?: string): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        this.startPromise = undefined
        this.starting = undefined
        if (!ok) {
          worker.terminate()
          this.useFallback(reason ?? "the usage worker did not start")
        }
        resolve()
      }
      timer = setTimeout(() => finish(false, "the usage worker did not start in time"), START_TIMEOUT_MS)

      worker.onmessage = (event) => {
        const message = event.data as { type?: string; error?: { code?: string; message?: string } } | undefined
        if (message?.type === "ready") {
          this.worker = worker
          this.attach(worker)
          finish(true)
          return
        }
        if (message?.type === "error") {
          finish(false, message.error?.message ?? "the usage worker failed to start")
        }
      }
      worker.onerror = (event) => {
        finish(false, event.message || "the usage worker failed to start")
      }
      try {
        worker.postMessage({ type: "init", dbPath: this.config.dbPath, options: this.config.options })
      } catch (error) {
        finish(false, error instanceof Error ? error.message : "the usage worker could not be initialized")
      }
    })

    return this.startPromise
  }

  private attach(worker: WorkerLike): void {
    worker.onmessage = (event) => this.receive(event.data)
    worker.onerror = (event) => {
      this.config.log?.(`usage worker failed: ${event.message}`)
      this.worker = undefined
      this.rejectAll(new StatsError("unavailable", "the usage worker stopped"))
    }
  }

  private receive(message: unknown): void {
    if (message === null || typeof message !== "object") return
    const payload = message as {
      id?: number
      ok?: boolean
      result?: unknown
      error?: { code?: StatsErrorCode; message?: string }
    }
    if (typeof payload.id !== "number") return
    const pending = this.pending.get(payload.id)
    if (pending === undefined) return
    this.settle(payload.id, pending)
    if (payload.ok === true) {
      pending.resolve(payload.result)
      return
    }
    const code = payload.error?.code ?? "unavailable"
    pending.reject(new StatsError(code, payload.error?.message ?? "the usage request failed"))
  }

  private send<T>(method: StatsMethod, input: unknown, signal?: AbortSignal): Promise<T> {
    const worker = this.worker
    if (worker === undefined) throw new StatsError("unavailable", "the usage worker is not running")
    const id = this.nextID++
    const prices = method === "backfill" ? this.config.priceTable?.() : undefined
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.settle(id, pending)
          pending.reject(new StatsError("unavailable", "the usage request timed out"))
          this.hardReset("the usage request timed out")
        }, REQUEST_TIMEOUT_MS),
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(pending.timer)
          reject(new StatsError("unavailable", "the usage request was cancelled"))
          return
        }
        const abort = (): void => {
          this.settle(id, pending)
          reject(new StatsError("unavailable", "the usage request was cancelled"))
        }
        signal.addEventListener("abort", abort, { once: true })
        pending.removeAbort = () => signal.removeEventListener("abort", abort)
      }
      this.pending.set(id, pending)
      try {
        worker.postMessage({
          id,
          method,
          input,
          ...(prices !== undefined ? { prices: [...prices.entries()] } : {}),
        })
      } catch {
        this.settle(id, pending)
        pending.reject(new StatsError("unavailable", "the usage worker stopped"))
      }
    })
  }

  private settle(id: number, pending: Pending): void {
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    this.pending.delete(id)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.settle(id, pending)
      pending.reject(error)
    }
  }

  private hardReset(message: string): void {
    this.config.log?.(message)
    this.rejectAll(new StatsError("unavailable", message))
    this.worker?.terminate()
    this.worker = undefined
    this.starting?.terminate()
    this.starting = undefined
    this.startPromise = undefined
  }

  private useFallback(reason: string): void {
    this.fallbackMode = true
    this.config.log?.(`usage worker unavailable, using the in-process service: ${reason}`)
  }
}
