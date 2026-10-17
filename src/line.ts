import {
  formatLineSegments,
  type LineFields,
  type LineIdentity,
  type LineLabels,
  type LineTone,
  type Totals,
  type TranscriptMessage,
  type TurnStats,
  type TurnTotalsView,
} from "./core"

/**
 * Adapter between the host's session messages and the pure turn accounting in
 * `core`, plus the plain-text parts the TUI line is made of.
 *
 * The host types are shadowed structurally: the plugin only reads fields it
 * relies on, so a host refactor degrades the line instead of breaking setup.
 */

export type RuntimeModelRef = {
  providerID?: string | undefined
  id?: string | undefined
  variant?: string | undefined
}

export type RuntimeTokenUsage = {
  input?: number | undefined
  output?: number | undefined
  reasoning?: number | undefined
  cache?: { read?: number | undefined; write?: number | undefined } | undefined
}

export type RuntimeMessage = {
  id?: string | undefined
  type?: string | undefined
  time?: { created?: number | undefined; streamed?: number | undefined; completed?: number | undefined } | undefined
  model?: RuntimeModelRef | undefined
  tokens?: RuntimeTokenUsage | undefined
  cost?: number | undefined
  finish?: string | null | undefined
  rawFinish?: string | null | undefined
}

export type RuntimeSessionInfo = {
  cost?: number | undefined
  tokens?: RuntimeTokenUsage | undefined
  time?: { created?: number | undefined } | undefined
}

export type LinePart = {
  text: string
  tone: LineTone
}

/** Convert host messages into the structural transcript `core` understands. */
export function toTranscript(messages: readonly RuntimeMessage[]): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  for (const message of messages) {
    if (typeof message.id !== "string" || typeof message.type !== "string") continue
    if (message.type !== "assistant") {
      transcript.push({ type: message.type, id: message.id, time: message.time })
      continue
    }
    transcript.push({
      type: "assistant",
      id: message.id,
      time: message.time,
      model: toModelRef(message.model),
      tokens: message.tokens,
      cost: message.cost,
      finish: message.finish ?? undefined,
      rawFinish: message.rawFinish ?? undefined,
    })
  }
  return transcript
}

function toModelRef(model: RuntimeModelRef | undefined): { providerID: string; id: string; variant?: string } | undefined {
  if (model === undefined || model.providerID === undefined || model.id === undefined) return undefined
  if (model.variant === undefined) return { providerID: model.providerID, id: model.id }
  return { providerID: model.providerID, id: model.id, variant: model.variant }
}

/** Session-wide accumulated usage, as reported by the host on the session. */
export function sessionTotals(info: RuntimeSessionInfo | undefined): Totals | undefined {
  if (info === undefined) return undefined
  const tokens = info.tokens
  return {
    input: tokens?.input ?? 0,
    cached: tokens?.cache?.read ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0,
    cost: info.cost ?? 0,
    steps: 0,
  }
}

/**
 * The telemetry line as renderable parts: each segment plus the muted
 * separators between them, so the TUI can color every part independently.
 */
export function lineParts(
  stats: TurnStats | undefined,
  options?: { labels?: Partial<LineLabels>; fields?: Partial<LineFields>; turnTotals?: TurnTotalsView; identity?: LineIdentity },
): LinePart[] {
  if (stats === undefined) return []
  const parts: LinePart[] = []
  const segments = formatLineSegments(stats, options)
  segments.forEach((segment, index) => {
    if (index > 0) parts.push({ text: " · ", tone: "muted" })
    parts.push({ text: segment.text, tone: segment.tone })
  })
  return parts
}

/** Plain text of the same line, useful for tests and logs. */
export function lineText(parts: readonly LinePart[]): string {
  return parts.map((part) => part.text).join("")
}
