import { computeTurn, type LineFields, type LineLabels, type TurnStats, type TurnTotalsView } from "../core"
import { lineParts, lineText, sessionTotals, toTranscriptTail, type LinePart, type RuntimeMessage, type RuntimeSessionInfo } from "../line"
import type { PriceFn } from "../pricing"

/**
 * Pure view helpers for the desktop badge. The line is computed from the
 * server-synced transcript exactly like the TUI line; the only database-backed
 * input is the session's stored list estimate, which arrives over the RPC.
 */

export type GuiLineOptions = {
  labels?: Partial<LineLabels> | undefined
  fields?: Partial<LineFields> | undefined
  turnTotals?: TurnTotalsView | undefined
  estimates: boolean
}

export type GuiLineInput = {
  messages: readonly RuntimeMessage[]
  info: RuntimeSessionInfo | undefined
  listCost: number
  status: "idle" | "running" | undefined
  price?: PriceFn | undefined
}

export function lineFor(input: GuiLineInput): TurnStats | undefined {
  // A running turn has no final numbers yet; the badge belongs to finished work.
  if (input.status !== undefined && input.status !== "idle") return undefined
  const session = input.info === undefined ? undefined : sessionTotals(input.info, input.listCost)
  return computeTurn(toTranscriptTail(input.messages, 2, input.price), session)
}

export function linePartsFor(stats: TurnStats | undefined, options: GuiLineOptions): LinePart[] {
  return lineParts(stats, {
    labels: options.labels,
    fields: options.fields,
    turnTotals: options.turnTotals,
    estimates: options.estimates,
  })
}

export function lineTextFor(stats: TurnStats | undefined, options: GuiLineOptions): string {
  return lineText(linePartsFor(stats, options))
}

/** Map a line or panel tone to the CSS class the panel and badges share. */
export function toneClass(tone: string | undefined): string {
  if (tone === "muted") return "oui-tone-muted"
  if (tone === "warning") return "oui-tone-warning"
  if (tone === "accent") return "oui-tone-accent"
  return "oui-tone-base"
}
