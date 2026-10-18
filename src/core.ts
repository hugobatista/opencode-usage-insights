/**
 * Pure turn accounting shared by the TUI line, the server recorder and the
 * stats engine.
 *
 * Everything here operates on structural shapes that mirror the session
 * messages published by OpenCode, so the logic stays testable without a host
 * runtime and without the effect-based schema types.
 */

export type ModelRefLike = {
  providerID: string
  id: string
  variant?: string | undefined
}

export type AssistantMessage = {
  type: "assistant"
  id: string
  time?: { created?: number | undefined; streamed?: number | undefined; completed?: number | undefined } | undefined
  model?: ModelRefLike | undefined
  tokens?:
    | {
        input?: number | undefined
        output?: number | undefined
        reasoning?: number | undefined
        cache?: { read?: number | undefined; write?: number | undefined } | undefined
      }
    | undefined
  cost?: number | undefined
  finish?: string | null | undefined
  rawFinish?: string | null | undefined
}

export type PromptMessage = {
  type: "user" | "synthetic" | "system"
  id?: string | undefined
  time?: { created?: number | undefined } | undefined
}

export type TranscriptMessage =
  | AssistantMessage
  | PromptMessage
  | { type: string; id?: string | undefined; time?: { created?: number | undefined } | undefined }

/** Accumulated token usage for a group of assistant steps. */
export type Totals = {
  input: number
  cached: number
  output: number
  reasoning: number
  cacheWrite: number
  cost: number
  steps: number
}

export type CacheDrop = {
  messageID: string
  /** Tokens that were expected to hit the prompt cache but did not. */
  tokens: number
  /** `cache.read` of the step that was used as the reuse reference. */
  prevCached: number
  /** Time between the reference step's completion and this step's request. */
  gapMs: number | undefined
}

export type TurnStats = {
  /** Wall clock time of the last step's completion. */
  endAt: number | undefined
  /** Creation time of the first settled step of the turn. */
  startAt: number | undefined
  /** Creation time of the prompt that opened this turn. */
  promptAt: number | undefined
  /** Time between the previous prompt and this turn's prompt. */
  promptGapMs: number | undefined
  providerID: string | undefined
  modelID: string | undefined
  variant: string | undefined
  /** Gateway routing endpoint that served the turn, when a source identifies it. */
  router: string | undefined
  /**
   * The displayed identity differs from the previous turn's. The TUI fills it
   * in (the transcript carries no routing information); the line warns with the
   * same `changed` marker it uses for a provider switch.
   */
  identityChanged: boolean
  affinityKey: string | undefined
  /** Provider ID differs from the previous turn in the same transcript. */
  providerChanged: boolean
  /** Provider is the same but the model or variant differs. */
  modelChanged: boolean
  totals: Totals
  /** Passed through from the caller (session-wide accumulated usage). */
  session: Totals | undefined
  /**
   * Prompt-side usage of the last finished step: the context the turn ended
   * with. Summing `input`/`cached` over the steps of a turn counts the same
   * re-sent prompt once per step, which is not what a context view means.
   */
  latest: Totals
  drops: CacheDrop[]
  cacheDropTokens: number
  cacheExpired: boolean
  /** Assistant steps in the turn. */
  steps: number
}

export type TurnSegment = {
  assistants: AssistantMessage[]
  prompt: TranscriptMessage | undefined
}

const PROMPT_BOUNDARIES = new Set(["user", "synthetic", "system"])

/**
 * Split a transcript into turns. A turn is a run of assistant steps opened by
 * a prompt boundary (`user`, `synthetic`, `system`). Idle notices, info
 * messages, compactions and shell entries keep the current turn open so a
 * single execution is never split in two.
 */
export function transcriptSegments(messages: readonly TranscriptMessage[]): TurnSegment[] {
  const segments: TurnSegment[] = []
  let current: AssistantMessage[] = []
  let prompt: TranscriptMessage | undefined

  for (const message of messages) {
    if (message.type === "assistant") {
      current.push(message as AssistantMessage)
      continue
    }
    if (!PROMPT_BOUNDARIES.has(message.type)) continue
    if (current.length > 0) {
      segments.push({ assistants: current, prompt })
      current = []
    }
    prompt = message
  }
  if (current.length > 0) segments.push({ assistants: current, prompt })
  return segments
}

/**
 * The last `count` segments, found by walking the transcript backwards. The
 * live line only needs the turn that just ended and the one before it, and a
 * long session holds tens of thousands of messages: the tail walk stops as
 * soon as it has them, instead of building a segment for every turn.
 */
export function transcriptTail(messages: readonly TranscriptMessage[], count: number): TurnSegment[] {
  const segments: TurnSegment[] = []
  let current: AssistantMessage[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.type === "assistant") {
      current.unshift(message as AssistantMessage)
      continue
    }
    if (!PROMPT_BOUNDARIES.has(message.type)) continue
    if (current.length === 0) continue
    // The boundary closes the run collected after it.
    segments.unshift({ assistants: current, prompt: message })
    if (segments.length >= count) return segments
    current = []
  }
  // A leading run with no prompt before it is a segment of its own.
  if (current.length > 0 && segments.length < count) segments.unshift({ assistants: current, prompt: undefined })
  return segments
}

export function tokenCounts(message: AssistantMessage): { input: number; output: number; reasoning: number; read: number; write: number } {
  const tokens = message.tokens
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    read: tokens?.cache?.read ?? 0,
    write: tokens?.cache?.write ?? 0,
  }
}

export function totalize(steps: readonly AssistantMessage[]): Totals {
  const totals: Totals = { input: 0, cached: 0, output: 0, reasoning: 0, cacheWrite: 0, cost: 0, steps: steps.length }
  for (const step of steps) {
    const counts = tokenCounts(step)
    totals.input += counts.input
    totals.cached += counts.read
    totals.output += counts.output
    totals.reasoning += counts.reasoning
    totals.cacheWrite += counts.write
    totals.cost += step.cost ?? 0
  }
  return totals
}

export function affinityKey(model: ModelRefLike | undefined): string | undefined {
  if (!model) return undefined
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

export function cacheRead(message: AssistantMessage | undefined): number {
  return message?.tokens?.cache?.read ?? 0
}

export function stepCreated(message: AssistantMessage | undefined): number | undefined {
  return message?.time?.created
}

export function stepEnd(message: AssistantMessage | undefined): number | undefined {
  const time = message?.time
  if (!time) return undefined
  return time.completed ?? time.streamed ?? time.created
}

/**
 * Cache reuse loss against a reference step, mirroring OpenCode's own
 * `turn-usage` heuristic: only comparable when the model is identical, and
 * OpenAI's endpoint reports small reads that are not worth flagging.
 */
export function cacheDrop(reference: AssistantMessage | undefined, current: AssistantMessage): number | undefined {
  if (!reference) return undefined
  const before = reference.model
  const after = current.model
  if (!before || !after) return undefined
  if (before.providerID !== after.providerID || before.id !== after.id || (before.variant ?? "") !== (after.variant ?? "")) {
    return undefined
  }
  const drop = cacheRead(reference) - cacheRead(current)
  if (isNoiseDrop(after.providerID, drop)) return undefined
  return drop > 0 ? drop : undefined
}

/** Milliseconds between a reference step's completion and the next request. */
export function stepGap(reference: AssistantMessage | undefined, current: AssistantMessage): number | undefined {
  const ended = stepEnd(reference)
  const started = stepCreated(current)
  if (ended === undefined || started === undefined) return undefined
  return Math.max(0, started - ended)
}

/**
 * Streaming duration of a step: request start to the last streamed chunk. The
 * host's `streamed` stamp marks the end of streaming, so this is the window a
 * generation rate belongs to — not a time to first token, which the session
 * messages do not record.
 */
export function stepStreamMs(message: AssistantMessage): number | undefined {
  const created = message.time?.created
  const streamed = message.time?.streamed
  if (created === undefined || streamed === undefined || streamed <= created) return undefined
  return streamed - created
}

/**
 * Tokens produced per second over a window. For a step the window is the
 * streaming one: request start to the last streamed chunk (`created` →
 * `streamed`) — `completed` marks the end of the step, which for a tool-call
 * step happens after the tool calls were handled. Returns undefined when the
 * window or the produced tokens are unknown. Single definition, shared by the
 * recorder (which stores it per step) and the latency view.
 */
export function tokensPerSecond(produced: number, from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined || to <= from) return undefined
  if (produced <= 0) return undefined
  return (produced / (to - from)) * 1000
}


/** Output-plus-reasoning tokens per second of a step. */
export function stepTps(message: AssistantMessage): number | undefined {
  const counts = tokenCounts(message)
  return tokensPerSecond(counts.output + counts.reasoning, message.time?.created, message.time?.streamed)
}

const DROP_EXEMPT_PROVIDERS = new Set(["openai"])

/**
 * True when a step has final numbers. A step that is still streaming reports
 * partial tokens (usually zero) and no cache read yet, so reading it would
 * render an empty line and invent a cache-expiry warning against it.
 */
export function isSettledStep(message: AssistantMessage): boolean {
  if (message.time?.completed !== undefined) return true
  return message.finish !== undefined && message.finish !== null
}

/**
 * Compute the stats of the most recent turn in a transcript, including the
 * comparison against the previous turn (affinity and cache reuse).
 *
 * Returns undefined while the newest turn is still being generated: the line
 * appears when a turn ends, never with the zeroes of an in-flight response.
 */
export function computeTurn(messages: readonly TranscriptMessage[], session?: Totals): TurnStats | undefined {
  const segments = transcriptTail(messages, 2)
  const last = segments[segments.length - 1]
  if (!last) return undefined
  const previous = segments[segments.length - 2]
  const lastStep = last.assistants[last.assistants.length - 1]
  if (!lastStep) return undefined
  if (!isSettledStep(lastStep)) return undefined
  const previousStep = previous?.assistants[previous.assistants.length - 1]
  // Defensive: a step that never settled mid-turn carries no usable numbers,
  // so it is neither a cache reference nor a reuse candidate.
  const settled = last.assistants.filter(isSettledStep)

  const drops: CacheDrop[] = []
  let reference: AssistantMessage | undefined = previousStep !== undefined && isSettledStep(previousStep) ? previousStep : undefined
  for (const step of settled) {
    const drop = cacheDrop(reference, step)
    if (drop !== undefined) {
      drops.push({
        messageID: step.id,
        tokens: drop,
        prevCached: cacheRead(reference),
        gapMs: stepGap(reference, step),
      })
    }
    reference = step
  }

  const provider = lastStep.model?.providerID
  const previousProvider = previousStep?.model?.providerID
  const key = affinityKey(lastStep.model)
  const previousKey = affinityKey(previousStep?.model)

  return {
    endAt: stepEnd(lastStep),
    startAt: stepCreated(settled[0] ?? lastStep),
    promptAt: last.prompt?.time?.created,
    promptGapMs: promptGap(last.prompt, previous?.prompt),
    providerID: provider,
    modelID: lastStep.model?.id,
    variant: lastStep.model?.variant,
    router: undefined,
    identityChanged: false,
    affinityKey: key,
    providerChanged: previousProvider !== undefined && provider !== undefined && previousProvider !== provider,
    modelChanged: previousKey !== undefined && key !== undefined && previousKey !== key && previousProvider === provider,
    totals: totalize(settled),
    latest: totalize([lastStep]),
    session,
    drops,
    cacheDropTokens: drops.reduce((sum, drop) => sum + drop.tokens, 0),
    cacheExpired: drops.length > 0,
    steps: settled.length,
  }
}

function promptGap(current: TranscriptMessage | undefined, previous: TranscriptMessage | undefined): number | undefined {
  const now = current?.time?.created
  const before = previous?.time?.created
  if (now === undefined || before === undefined) return undefined
  return Math.max(0, now - before)
}

/** True when a cache drop is small enough to be endpoint noise. */
export function isNoiseDrop(providerID: string | undefined, drop: number): boolean {
  if (providerID === undefined) return false
  return DROP_EXEMPT_PROVIDERS.has(providerID) && drop >= 1024 && drop <= 2048
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export type LineTone = "base" | "muted" | "warning"

export type LineSegment = { text: string; tone: LineTone }

export type LineLabels = {
  delta: string
  turn: string
  session: string
  step: string
  steps: string
  input: string
  cached: string
  output: string
  reasoning: string
  cost: string
  cacheExpired: string
  providerChanged: string
  modelChanged: string
}

/**
 * How the turn segment counts prompt usage. `latest` shows the prompt size the
 * turn ended with — the context view, and what OpenCode's own turn-token debug
 * line reports. `sum` adds every step of the turn: the billing view, where a
 * tool-call loop re-sends (and re-reads) the same context once per step.
 */
export type TurnTotalsView = "latest" | "sum"

/**
 * Which identity the line leads with. `endpoint` shows the gateway endpoint
 * that served the turn (`orcarouter-dsv4.1flash`) when a recorder learned one,
 * falling back to `provider/model`; `model` always shows `provider/model`.
 * The same provider and model can be routed to different endpoints per request,
 * so the endpoint is the identity a change is measured against.
 */
export type LineIdentity = "endpoint" | "model"

export type LineFields = {
  clock: boolean
  delta: boolean
  model: boolean
  variant: boolean
  turn: boolean
  session: boolean
  reasoning: boolean
  cost: boolean
  cacheExpiry: boolean
}

export const DEFAULT_LABELS: LineLabels = {
  delta: "Δ",
  // The turn segment is unlabelled by default to keep the line short; set it
  // back to "turn" (or anything else) through `labels.turn`.
  turn: "",
  session: "sess",
  step: "step",
  steps: "steps",
  input: "in",
  cached: "cached",
  output: "out",
  reasoning: "reason",
  cost: "cost",
  cacheExpired: "cache expired",
  providerChanged: "changed",
  modelChanged: "model changed",
}

export const DEFAULT_FIELDS: LineFields = {
  clock: true,
  delta: true,
  model: true,
  variant: true,
  turn: true,
  session: true,
  reasoning: false,
  cost: false,
  cacheExpiry: true,
}

export function formatClock(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600) % 24
  const days = Math.floor(totalSeconds / 86400)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value))
  if (n < 1_000) return String(n)
  if (n < 999_500) {
    const k = n / 1_000
    return `${trimZeros(k.toFixed(k < 10 ? 2 : 1))}k`
  }
  if (n < 999_500_000) {
    const m = n / 1_000_000
    return `${trimZeros(m.toFixed(m < 10 ? 2 : 1))}M`
  }
  return `${Math.round(n / 1_000_000)}M`
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value
}

export function formatCost(value: number): string {
  if (value <= 0) return "$0"
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/**
 * The buckets the line displays, derived from a totals group. `input` is the
 * *uncached* part of the prompt (fresh input plus cache writes, i.e. what the
 * debug line's `new` counts on the prompt side), `prompt` is the whole prompt
 * of the request and `output` is everything the model generated (visible output
 * + reasoning). OpenCode's own debug line reconciles with these:
 * `new = in + out` and `total = prompt + out`, with `prompt = in + cached`.
 * The stored buckets stay raw; only the display folds.
 */
export type DisplayTotals = Totals & {
  /** Whole prompt of the request: fresh input + cached reads + cache writes. */
  prompt: number
}

export function displayTotals(totals: Totals): DisplayTotals {
  const prompt = totals.input + totals.cached + totals.cacheWrite
  return {
    input: prompt - totals.cached,
    cached: totals.cached,
    cacheWrite: totals.cacheWrite,
    output: totals.output + totals.reasoning,
    reasoning: totals.reasoning,
    cost: totals.cost,
    steps: totals.steps,
    prompt,
  }
}

function totalsText(prefix: string, totals: Totals, labels: LineLabels, fields: LineFields, stepCount = 0): string {
  const display = displayTotals(totals)
  // The parenthesised value is the whole prompt, shown only when it differs
  // from the uncached part the label leads with.
  const input =
    display.prompt === display.input
      ? `${labels.input} ${formatTokens(display.input)}`
      : `${labels.input} ${formatTokens(display.input)} (${formatTokens(display.prompt)})`
  const parts = [
    input,
    `${labels.cached} ${formatTokens(display.cached)}`,
    `${labels.output} ${formatTokens(display.output)}`,
  ]
  if (fields.reasoning) parts.push(`${labels.reasoning} ${formatTokens(display.reasoning)}`)
  if (fields.cost) parts.push(`${labels.cost} ${formatCost(display.cost)}`)
  // An empty label (the default for the turn) leaves the numbers unlabelled; a
  // multi-step turn still says how many requests it took.
  const steps = stepCount > 1 ? `${stepCount} ${stepCount === 1 ? labels.step : labels.steps}` : ""
  const head = [prefix, steps].filter((piece) => piece !== "").join(" ")
  const numbers = parts.join(", ")
  if (head === "") return numbers
  return stepCount > 1 ? `${head} · ${numbers}` : `${head} ${numbers}`
}

/**
 * Render the telemetry line as toned segments. The caller maps tones onto
 * theme colors; `formatLine` joins the segments as plain text.
 */
export function formatLineSegments(
  stats: TurnStats,
  options?: { labels?: Partial<LineLabels>; fields?: Partial<LineFields>; turnTotals?: TurnTotalsView; identity?: LineIdentity },
): LineSegment[] {
  const labels = { ...DEFAULT_LABELS, ...options?.labels }
  const fields = { ...DEFAULT_FIELDS, ...options?.fields }
  const turnTotals = options?.turnTotals ?? "latest"
  const identity = options?.identity ?? "endpoint"
  const segments: LineSegment[] = []

  if (fields.clock && stats.endAt !== undefined) {
    segments.push({ text: formatClock(stats.endAt), tone: "muted" })
  }
  if (fields.delta && stats.promptGapMs !== undefined) {
    segments.push({ text: `${labels.delta} ${formatDuration(stats.promptGapMs)}`, tone: "muted" })
  }
  if (identity === "endpoint" && stats.router !== undefined) {
    // The gateway endpoint is the identity: the same provider and model can be
    // routed to a different endpoint per request, so that is what `changed`
    // reports.
    segments.push({ text: stats.router, tone: stats.identityChanged ? "warning" : "base" })
    if (stats.identityChanged) segments.push({ text: labels.providerChanged, tone: "warning" })
  } else if (stats.providerID !== undefined) {
    let text = stats.providerID
    if (fields.model && stats.modelID !== undefined) text += `/${stats.modelID}`
    if (fields.variant && stats.variant) text += ` ${stats.variant}`
    segments.push({ text, tone: stats.providerChanged ? "warning" : "base" })
    if (stats.providerChanged) segments.push({ text: labels.providerChanged, tone: "warning" })
    else if (stats.modelChanged) segments.push({ text: labels.modelChanged, tone: "muted" })
  }
  if (fields.turn && stats.totals.steps > 0) {
    const totals = turnTotals === "sum" ? stats.totals : stats.latest
    segments.push({ text: totalsText(labels.turn, totals, labels, fields, turnTotals === "sum" ? stats.totals.steps : stats.steps), tone: "base" })
  }
  if (fields.session && stats.session) {
    segments.push({ text: totalsText(labels.session, stats.session, labels, fields), tone: "muted" })
  }
  if (fields.cacheExpiry && stats.cacheExpired) {
    const count = stats.drops.length > 1 ? `×${stats.drops.length}` : ""
    segments.push({ text: `⚠ ${labels.cacheExpired} (−${formatTokens(stats.cacheDropTokens)}${count})`, tone: "warning" })
  }
  return segments
}

export function formatLine(
  stats: TurnStats,
  options?: { labels?: Partial<LineLabels>; fields?: Partial<LineFields>; turnTotals?: TurnTotalsView; identity?: LineIdentity },
): string {
  return formatLineSegments(stats, options)
    .map((segment) => segment.text)
    .join(" · ")
}
