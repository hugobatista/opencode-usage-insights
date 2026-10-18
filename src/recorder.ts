import type { Database } from "bun:sqlite"
import { recordEvent, recordPrompt, recordStep, setStepRouterForSessionModel, upsertSession } from "./stats/db"
import { COMPACTION_KIND } from "./stats/queries"
import { inferFromHeaders, inferFromUrl, mergeEndpoint, type EndpointInfo } from "./endpoint"

/**
 * Event-driven recorder. Every handler is idempotent and defensive: the
 * plugin must never break a session because an event arrived in an
 * unexpected shape, so unknown events are ignored and malformed payloads are
 * dropped rather than thrown.
 *
 * Pure with respect to its inputs (database plus events) so the whole
 * recording policy can be unit-tested without the plugin runtime.
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

export type HttpResponseInput = {
  sessionID?: string | undefined
  kind?: string | undefined
  model?: SessionModelRef | undefined
  request?: { method?: string | undefined; url?: string | undefined } | undefined
  response?: { status?: number | undefined; headers?: Headers | Record<string, string | undefined> | undefined } | undefined
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
  /** Learn the routing endpoint from one model response. */
  handleHttpResponse(event: HttpResponseInput): void
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
  /** Endpoint evidence learned per session, applied to its steps. */
  const known = new Map<string, { modelID: string | undefined; info: EndpointInfo }>()
  const now = options?.now ?? (() => Date.now())

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
    known.delete(sessionID)
    for (const [messageID, step] of pending) {
      if (step.sessionID === sessionID) pending.delete(messageID)
    }
  }

  /**
   * How much an observation is worth: the gateway naming its own routing
   * endpoint beats inferring it from the host, which beats nothing. Without
   * this a response that carries no endpoint header would downgrade the one a
   * previous response named.
   */
  function strength(info: EndpointInfo | undefined): number {
    if (info?.router === undefined) return 0
    return info.source?.startsWith("header:") === true ? 2 : 1
  }

  function noteRouter(sessionID: string, modelID: string | undefined, info: EndpointInfo): void {
    const previous = known.get(sessionID)
    // A stronger observation wins; at equal strength the newest one does, so a
    // gateway that re-routes is still seen.
    const merged = strength(previous?.info) > strength(info) ? previous!.info : mergeEndpoint(info, previous?.info)
    const info2: EndpointInfo = merged ?? info
    // The same answer for the same model means the database already agrees: the
    // rows recorded since the last observation carry the endpoint at insert
    // time, and the older ones were filled when it was learned. Writing again
    // would cost the response path a statement to change nothing.
    const settled = previous !== undefined && previous.modelID === modelID && previous.info.router === info2.router
    remember(known, sessionID, { modelID, info: info2 }, MAX_TRACKED_SESSIONS)
    if (!settled) setStepRouterForSessionModel(db, sessionID, modelID, info2)
  }

  function recordPendingStep(messageID: string, data: RecorderEventData, finish: string | undefined, at: number): void {
    const sessionID = data.sessionID
    if (typeof sessionID !== "string") return
    const info = pending.get(messageID)
    pending.delete(messageID)
    const model = info?.model ?? lastModel.get(sessionID)
    const learned = known.get(sessionID)
    const matched = learned !== undefined && (learned.modelID === undefined || learned.modelID === model?.id) ? learned.info : undefined
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
      router: matched?.router,
      recordedAt: now(),
    })
  }

  function handleEvent(event: RecorderEvent): void {
    const data = event.data ?? {}
    const at = typeof event.created === "number" ? event.created : now()
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined

    switch (event.type) {
      case "session.created": {
        if (sessionID === undefined) return
        upsertSession(db, {
          sessionID,
          parentID: data.parentID,
          directory: data.location?.directory,
          title: data.title,
          startedAt: at,
          updatedAt: at,
        })
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
        upsertSession(db, { sessionID, title: data.title, updatedAt: at })
        return
      }
      case "session.moved": {
        if (sessionID === undefined) return
        upsertSession(db, { sessionID, directory: data.location?.directory, updatedAt: at })
        return
      }
      case "session.inbox.enqueued": {
        if (sessionID === undefined) return
        if (data.item?.type !== "user" && data.item?.type !== "synthetic") return
        if (typeof data.inboxID !== "string") return
        recordPrompt(db, { sessionID, messageID: data.inboxID, createdAt: at })
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
        recordEvent(db, {
          sessionID,
          kind: COMPACTION_KIND,
          at,
          data: { reason: data.reason, model: data.model, tokens: data.tokens, cost: data.cost },
        })
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

  function handleHttpResponse(event: HttpResponseInput): void {
    const sessionID = event.sessionID
    if (typeof sessionID !== "string") return

    // The endpoint that served the request: the gateway's own header first,
    // then the host the request went to. Nothing else about the exchange is
    // kept — the headers a gateway happens to send are not who ran the model.
    const inferred = mergeEndpoint(inferFromHeaders(event.response?.headers), inferFromUrl(event.request?.url))
    if (inferred === undefined) return

    noteRouter(sessionID, event.model?.id, inferred)
    // The step in flight is not a row yet: `recordPendingStep` writes it when it
    // ends, carrying the endpoint learned from this response. Writing here would
    // be a statement that changes nothing, on the request path.
  }

  return { handleEvent, handleHttpResponse, pendingFor }
}
