import type { Database } from "bun:sqlite"
import { recordEvent, recordPrompt, recordStep, upsertSession } from "./stats/db"
import { COMPACTION_KIND } from "./stats/queries"

/**
 * Event-driven recorder. Every handler is idempotent and defensive: the
 * plugin must never break a session because an event arrived in an
 * unexpected shape, so unknown events are ignored and malformed payloads are
 * dropped rather than thrown.
 *
 * Everything written comes from the event stream: the step's provider, model
 * and variant, its tokens, its timing and its outcome. Pure with respect to
 * its inputs (database plus events) so the whole recording policy can be
 * unit-tested without the plugin runtime.
 */

export type SessionModelRef = {
  id: string
  providerID: string
  variant?: string | undefined
}

export type TokenUsageLike = {
  input?: number | undefined
  output?: number | undefined
  reasoning?: number | undefined
  cache?: { read?: number | undefined; write?: number | undefined } | undefined
}

export type RecorderEventData = {
  sessionID?: string | undefined
  assistantMessageID?: string | undefined
  inboxID?: string | undefined
  item?: { type?: string | undefined } | undefined
  started?: number | undefined
  model?: SessionModelRef | undefined
  previous?: SessionModelRef | undefined
  tokens?: TokenUsageLike | undefined
  cost?: number | undefined
  finish?: string | undefined
  rawFinish?: string | undefined
  reason?: string | undefined
  location?: { directory?: string | undefined } | undefined
  parentID?: string | undefined
  title?: string | undefined
}

export type RecorderEvent = {
  type: string
  created?: number | undefined
  data?: RecorderEventData | undefined
}

export type PendingStep = {
  messageID: string
  sessionID: string
  started: number | undefined
  streamed: number | undefined
  model: SessionModelRef | undefined
}

export type RecorderOptions = {
  /** Clock override, for tests. */
  now?: (() => number) | undefined
}

export type Recorder = {
  /** Apply one session event. Unknown or malformed events are ignored. */
  handleEvent(event: RecorderEvent): void
  pendingFor(sessionID: string): PendingStep | undefined
}

export function createRecorder(db: Database, options?: RecorderOptions): Recorder {
  /**
   * Ceiling on the per-session maps. A session that ends takes its entries
   * with it; a host running for weeks has thousands of sessions, and a map that
   * only ever grows is a leak with a nice name.
   */
  const MAX_TRACKED_SESSIONS = 512
  /** Ceiling on in-flight steps; a step that never ends is a leak too. */
  const MAX_PENDING = 256

  /** Steps in flight between `step.started` and `step.ended`. */
  const pending = new Map<string, PendingStep>()
  /** Last model selected per session, used when a step starts unobserved. */
  const lastModel = new Map<string, SessionModelRef>()
  const now = options?.now ?? (() => Date.now())

  /**
   * Ceiling on the writes kept while the database is busy. A maintenance
   * operation (a prune, a vacuum) holds the write lock; waiting for it would
   * stall the agent, and dropping the record would lose usage. The recorder
   * defers instead, retrying on the next event, and only a lock held for longer
   * than this many records takes a record with it.
   */
  const MAX_DEFERRED = 256
  const deferred: Array<() => void> = []

  /** True when the database was locked rather than the statement being wrong. */
  function isBusy(error: unknown): boolean {
    const code = (error as { code?: unknown } | null | undefined)?.code
    return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
  }

  function enqueue(run: () => void): void {
    if (deferred.length >= MAX_DEFERRED) deferred.shift()
    deferred.push(run)
  }

  /** Retry what a busy database postponed, oldest first, stopping at the first failure. */
  function flushDeferred(): void {
    while (deferred.length > 0) {
      const next = deferred[0]!
      try {
        next()
      } catch {
        return
      }
      deferred.shift()
    }
  }

  /**
   * Run one write. On a busy database the work is kept for the next event
   * instead of waiting for the lock: the recorder is on the agent's path, and
   * the record is worth more late than the agent is worth stalled.
   */
  function write(run: () => void): void {
    if (deferred.length > 0) {
      flushDeferred()
      // Still locked: this write has to wait behind the queued ones.
      if (deferred.length > 0) {
        enqueue(run)
        return
      }
    }
    try {
      run()
    } catch (error) {
      if (isBusy(error)) enqueue(run)
      // Anything else is swallowed, as before: telemetry never breaks a session.
    }
  }

  /** Insertion-ordered map with a size ceiling: the oldest entry goes first. */
  function remember<Value>(map: Map<string, Value>, key: string, value: Value, limit: number): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > limit) {
      const oldest = map.keys().next()
      if (oldest.done === true) break
      map.delete(oldest.value)
    }
  }

  /** Drop everything remembered about a session that is gone. */
  function forget(sessionID: string): void {
    lastModel.delete(sessionID)
    for (const [messageID, step] of pending) {
      if (step.sessionID === sessionID) pending.delete(messageID)
    }
  }

  function recordPendingStep(messageID: string, data: RecorderEventData, finish: string | undefined, at: number): void {
    const sessionID = data.sessionID
    if (typeof sessionID !== "string") return
    const info = pending.get(messageID)
    pending.delete(messageID)
    const model = info?.model ?? lastModel.get(sessionID)
    write(() =>
      recordStep(db, {
        messageID,
        sessionID,
        providerID: model?.providerID,
        modelID: model?.id,
        variant: model?.variant,
        input: data.tokens?.input,
        output: data.tokens?.output,
        reasoning: data.tokens?.reasoning,
        cacheRead: data.tokens?.cache?.read,
        cacheWrite: data.tokens?.cache?.write,
        cost: data.cost,
        createdAt: info?.started,
        streamedAt: info?.streamed,
        completedAt: at,
        finish,
        recordedAt: now(),
      }),
    )
  }

  function handleEvent(event: RecorderEvent): void {
    // A previous write may have been postponed: this is the cheapest moment to
    // land it, and the check costs nothing while the queue is empty.
    if (deferred.length > 0) flushDeferred()
    const data = event.data ?? {}
    const at = typeof event.created === "number" ? event.created : now()
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined

    switch (event.type) {
      case "session.created": {
        if (sessionID === undefined) return
        write(() =>
          upsertSession(db, {
            sessionID,
            parentID: data.parentID,
            directory: data.location?.directory,
            title: data.title,
            startedAt: at,
            updatedAt: at,
          }),
        )
        if (data.model !== undefined) remember(lastModel, sessionID, data.model, MAX_TRACKED_SESSIONS)
        return
      }
      case "session.deleted": {
        // The session is gone: its in-flight steps will never end and nothing
        // else about it will be needed again.
        if (sessionID !== undefined) forget(sessionID)
        return
      }
      case "session.renamed": {
        if (sessionID === undefined) return
        write(() => upsertSession(db, { sessionID, title: data.title, updatedAt: at }))
        return
      }
      case "session.moved": {
        if (sessionID === undefined) return
        write(() => upsertSession(db, { sessionID, directory: data.location?.directory, updatedAt: at }))
        return
      }
      case "session.inbox.enqueued": {
        if (sessionID === undefined) return
        if (data.item?.type !== "user" && data.item?.type !== "synthetic") return
        // Narrowed into a local: a closure does not keep a property's narrowing.
        const inboxID = data.inboxID
        if (typeof inboxID !== "string") return
        write(() => recordPrompt(db, { sessionID, messageID: inboxID, createdAt: at }))
        return
      }
      case "session.model.selected": {
        // The session's current model, remembered so a step that started before
        // the plugin loaded is still attributed. Nothing is written for it: no
        // view reads a model-selection event.
        if (sessionID !== undefined && data.model !== undefined) remember(lastModel, sessionID, data.model, MAX_TRACKED_SESSIONS)
        return
      }
      case "session.step.started": {
        if (sessionID === undefined || typeof data.assistantMessageID !== "string") return
        remember(
          pending,
          data.assistantMessageID,
          {
            messageID: data.assistantMessageID,
            sessionID,
            started: typeof data.started === "number" ? data.started : undefined,
            streamed: undefined,
            model: data.model,
          },
          MAX_PENDING,
        )
        return
      }
      case "session.step.streamed": {
        if (typeof data.assistantMessageID !== "string") return
        const info = pending.get(data.assistantMessageID)
        if (info !== undefined) info.streamed = at
        return
      }
      case "session.step.ended": {
        if (typeof data.assistantMessageID !== "string") return
        recordPendingStep(data.assistantMessageID, data, data.finish ?? "unknown", at)
        return
      }
      case "session.step.failed": {
        if (typeof data.assistantMessageID !== "string") return
        // The step row keeps the outcome through `finish`; the error event is
        // not written because no view reads it.
        recordPendingStep(data.assistantMessageID, data, data.finish ?? "error", at)
        return
      }
      case "session.compaction.ended": {
        if (sessionID === undefined) return
        write(() =>
          recordEvent(db, {
            sessionID,
            kind: COMPACTION_KIND,
            at,
            data: { reason: data.reason, model: data.model, tokens: data.tokens, cost: data.cost },
          }),
        )
        return
      }
      default:
        return
    }
  }

  function pendingFor(sessionID: string): PendingStep | undefined {
    let found: PendingStep | undefined
    for (const item of pending.values()) {
      if (item.sessionID !== sessionID) continue
      if (found === undefined || (item.started ?? 0) >= (found.started ?? 0)) found = item
    }
    return found
  }

  return { handleEvent, pendingFor }
}
