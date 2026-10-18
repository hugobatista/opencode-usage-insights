import {
  formatLineSegments,
  type LineFields,
  type LineLabels,
  type LineTone,
  type Totals,
  type TranscriptMessage,
  type TurnStats,
  type TurnTotalsView,
} from "./core"
import { PROMPT_BOUNDARIES } from "./core"
import { sanitizeLabel } from "./text"

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

/**
 * Convert only the messages of the last `segments` turns.
 *
 * The line is computed from the tail of a transcript (`computeTurn` walks it
 * backwards), so converting the whole session was pure waste: on a long session
 * it cost milliseconds at every turn end, on the thread that also paints the
 * agent's output. Walking backwards costs what the last turns hold.
 */
export function toTranscriptTail(messages: readonly RuntimeMessage[], segments = 2): TranscriptMessage[] {
  // `computeTurn` reads the last turn *and the one before it*: with fewer
  // segments it answers something else (no `promptGapMs`, no cache reference for
  // the first step), so the floor is not a matter of taste.
  const wanted = Math.max(2, segments)
  const tail: RuntimeMessage[] = []
  let collected = 0
  let closed = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.type === "assistant") {
      tail.push(message)
      collected += 1
      continue
    }
    if (message.type === undefined || !PROMPT_BOUNDARIES.has(message.type)) continue
    // A boundary closes the run collected after it, exactly like the host-side
    // walk `transcriptTail` does.
    if (collected === 0) continue
    tail.push(message)
    collected = 0
    closed += 1
    if (closed >= wanted) break
  }
  tail.reverse()
  return toTranscript(tail)
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
  options?: { labels?: Partial<LineLabels>; fields?: Partial<LineFields>; turnTotals?: TurnTotalsView },
): LinePart[] {
  if (stats === undefined) return []
  const parts: LinePart[] = []
  const segments = formatLineSegments(stats, options)
  segments.forEach((segment, index) => {
    if (index > 0) parts.push({ text: " · ", tone: "muted" })
    // The line leads with identities that came from outside (the provider and
    // the model): one text renderable, one terminal, so no control character
    // may reach it.
    parts.push({ text: sanitizeLabel(segment.text), tone: segment.tone })
  })
  return parts
}

/** Plain text of the same line, useful for tests and logs. */
export function lineText(parts: readonly LinePart[]): string {
  return parts.map((part) => part.text).join("")
}
