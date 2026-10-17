import type { Database } from "bun:sqlite"
import {
  recordEvent,
  recordHttpResponse,
  recordPrompt,
  recordStep,
  setUpstream,
  setUpstreamForSessionModel,
  upsertSession,
} from "./stats/db"
import { COMPACTION_KIND } from "./stats/queries"
import { tokensPerSecond } from "./core"
import { inferFromHeaders, inferFromPackage, inferFromUrl, mergeUpstream, normalizeUpstream, redactHeaders, type UpstreamInfo } from "./upstream"

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
  providerState?: unknown
  error?: unknown
  reason?: string | undefined
  providerContext?: { provenance?: { provider?: string | undefined; modelID?: string | undefined } | undefined } | undefined
  source?: string | undefined
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
  /** Store redacted response headers for later analysis. */
  captureHeaders?: boolean | undefined
  /**
   * Package of the provider a step ran through (e.g.
   * `@opencode/ai/providers/fireworks`), used as a last-resort operator
   * source. The server entry fills it from the model catalogue.
   */
  providerPackage?: ((providerID: string | undefined) => string | undefined) | undefined
  /** Clock override, for tests. */
  now?: (() => number) | undefined
}

export type Recorder = {
  /** Apply one session event. Unknown or malformed events are ignored. */
  handleEvent(event: RecorderEvent): void
  /** Learn the upstream operator from one model response. */
  handleHttpResponse(event: HttpResponseInput): void
  pendingFor(sessionID: string): PendingStep | undefined
}

function errorText(error: unknown): string | undefined {
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object") {
    const record = error as { message?: unknown; name?: unknown }
    if (typeof record.message === "string" && record.message !== "") return record.message
    if (typeof record.name === "string" && record.name !== "") return record.name
  }
  return undefined
}

export function createRecorder(db: Database, options?: RecorderOptions): Recorder {
  /** Steps in flight between `step.started` and `step.ended`. */
  const pending = new Map<string, PendingStep>()
  /** Last model selected per session, used when a step starts unobserved. */
  const lastModel = new Map<string, SessionModelRef>()
  /** Upstream evidence learned per session, applied to its steps. */
  const provenance = new Map<string, { modelID: string | undefined; info: UpstreamInfo }>()
  const captureHeaders = options?.captureHeaders === true
  const providerPackage = options?.providerPackage
  const now = options?.now ?? (() => Date.now())

  function noteUpstream(sessionID: string, modelID: string | undefined, info: UpstreamInfo): void {
    const merged = mergeUpstream(info, provenance.get(sessionID)?.info)
    provenance.set(sessionID, { modelID, info: merged ?? info })
    if (merged !== undefined) setUpstreamForSessionModel(db, sessionID, modelID, merged)
  }

  function recordPendingStep(messageID: string, data: RecorderEventData, finish: string | undefined, at: number): void {
    const sessionID = data.sessionID
    if (typeof sessionID !== "string") return
    const info = pending.get(messageID)
    pending.delete(messageID)
    const model = info?.model ?? lastModel.get(sessionID)
    const learned = provenance.get(sessionID)
    const matched = learned !== undefined && (learned.modelID === undefined || learned.modelID === model?.id) ? learned.info : undefined
    const upstream = mergeUpstream(matched, inferFromPackage(providerPackage?.(model?.providerID)))
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
      providerState: data.providerState,
      tps: tokensPerSecond((data.tokens?.output ?? 0) + (data.tokens?.reasoning ?? 0), info?.started, info?.streamed),
      upstream: upstream?.operator,
      upstreamSource: upstream?.source,
      upstreamModel: upstream?.model,
      router: upstream?.router,
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
        if (data.model !== undefined) lastModel.set(sessionID, data.model)
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
        if (sessionID === undefined) return
        if (data.model !== undefined) lastModel.set(sessionID, data.model)
        recordEvent(db, { sessionID, kind: "model-selected", at, data: { model: data.model, previous: data.previous } })
        return
      }
      case "session.step.started": {
        if (sessionID === undefined || typeof data.assistantMessageID !== "string") return
        pending.set(data.assistantMessageID, {
          messageID: data.assistantMessageID,
          sessionID,
          started: typeof data.started === "number" ? data.started : undefined,
          streamed: undefined,
          model: data.model,
        })
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
        recordPendingStep(data.assistantMessageID, data, data.finish ?? "error", at)
        if (sessionID !== undefined) {
          recordEvent(db, {
            sessionID,
            kind: "step-failed",
            messageID: data.assistantMessageID,
            at,
            data: { error: errorText(data.error), finish: data.finish, rawFinish: data.rawFinish },
          })
        }
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
        const provenanceInfo = data.providerContext?.provenance
        const operator = normalizeUpstream(provenanceInfo?.provider)
        if (operator !== undefined) {
          noteUpstream(sessionID, provenanceInfo?.modelID ?? data.model?.id, { operator, source: "provenance" })
        }
        return
      }
      case "session.usage.recorded": {
        if (sessionID === undefined) return
        recordEvent(db, { sessionID, kind: "usage-recorded", at, data: { source: data.source, tokens: data.tokens, cost: data.cost } })
        return
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        if (sessionID === undefined) return
        recordEvent(db, {
          sessionID,
          kind: "execution",
          at,
          data: { outcome: event.type.slice("session.execution.".length) },
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

    // Operator evidence: the gateway's own headers first, then the endpoint the
    // request went to. Network headers (server, via, cf-ray) are CDN evidence
    // and are never classified.
    const inferred = mergeUpstream(inferFromHeaders(event.response?.headers), inferFromUrl(event.request?.url))
    if (captureHeaders) {
      let path: string | undefined
      try {
        path = event.request?.url !== undefined ? new URL(event.request.url).pathname : undefined
      } catch {
        path = undefined
      }
      recordHttpResponse(db, {
        at: now(),
        method: event.request?.method,
        path,
        status: event.response?.status,
        headers: redactHeaders(event.response?.headers),
      })
    }
    if (inferred === undefined) return

    noteUpstream(sessionID, event.model?.id, inferred)
    const target = pendingFor(sessionID)
    if (target !== undefined) setUpstream(db, target.messageID, inferred)
  }

  return { handleEvent, handleHttpResponse, pendingFor }
}
