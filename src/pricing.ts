/**
 * List-price arithmetic for models the host reported as costing nothing.
 *
 * Prices come from the running OpenCode catalog (`ModelInfo.cost`) and are
 * expressed in USD per 1,000,000 tokens. This module mirrors the host's own
 * fallback exactly, so an estimate for a step reproduces what OpenCode would
 * have recorded before a provider started reporting `cost: 0`.
 *
 * Everything here takes plain objects: no host imports, so the rule can be
 * tested and reused by the recorder, the TUI line and the maintenance action.
 */

export type CostLike = {
  tier?: { type?: string | undefined; size?: number | undefined } | undefined
  input?: number | undefined
  output?: number | undefined
  cache?: { read?: number | undefined; write?: number | undefined } | undefined
}

/** The part of `ModelInfo` pricing needs, structurally. */
export type ModelInfoLike = {
  providerID?: string | undefined
  modelID?: string | undefined
  id?: string | undefined
  cost?: readonly CostLike[] | undefined
}

export type PriceTier = {
  /** Present only on a context-tiered price; an untiered price has no tier. */
  tier?: { type?: string | undefined; size: number } | undefined
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type ModelPrice = {
  tiers: PriceTier[]
}

/** `providerID/modelID` to its prices. */
export type PriceTable = Map<string, ModelPrice>

export type PriceRef = {
  providerID?: string | undefined
  modelID?: string | undefined
}

export type PriceTokens = {
  input?: number | undefined
  output?: number | undefined
  reasoning?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
}

/** The estimate callback the recorder and the live line share. */
export type PriceFn = (ref: PriceRef, tokens: PriceTokens) => number | undefined

function money(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Build the price table from the catalog the host exposes. */
export function priceTable(models: readonly ModelInfoLike[] | undefined): PriceTable {
  const table: PriceTable = new Map()
  if (!Array.isArray(models)) return table

  for (const model of models) {
    if (model === null || model === undefined) continue
    const providerID = model.providerID
    const modelID = model.modelID ?? model.id
    if (typeof providerID !== "string" || providerID === "") continue
    if (typeof modelID !== "string" || modelID === "") continue
    if (!Array.isArray(model.cost) || model.cost.length === 0) continue

    const tiers: PriceTier[] = []
    for (const cost of model.cost) {
      if (cost === null || cost === undefined) continue
      const size = cost.tier?.size
      const tier =
        cost.tier !== undefined && typeof size === "number" && Number.isFinite(size) && size >= 0
          ? { ...(cost.tier.type !== undefined ? { type: cost.tier.type } : {}), size }
          : undefined
      tiers.push({
        ...(tier !== undefined ? { tier } : {}),
        input: money(cost.input),
        output: money(cost.output),
        cacheRead: money(cost.cache?.read),
        cacheWrite: money(cost.cache?.write),
      })
    }
    if (tiers.length > 0) table.set(`${providerID}/${modelID}`, { tiers })
  }
  return table
}

export function priceOf(table: PriceTable, ref: PriceRef): ModelPrice | undefined {
  if (ref.providerID === undefined || ref.providerID === "") return undefined
  if (ref.modelID === undefined || ref.modelID === "") return undefined
  return table.get(`${ref.providerID}/${ref.modelID}`)
}

/**
 * The list price of one step, or undefined when there is nothing to show.
 *
 * The rule is the host's `cost` fallback: the prompt is fresh input plus cache
 * reads and writes; the tier that applies is the largest context tier the
 * prompt is strictly above; otherwise the untiered price. A known model whose
 * applicable prices are all zero returns `0` (free, not an estimate); an
 * unknown model or no applicable tier returns `undefined`.
 */
export function costOf(table: PriceTable, ref: PriceRef, usage: PriceTokens): number | undefined {
  const price = priceOf(table, ref)
  if (price === undefined) return undefined

  const input = tokens(usage.input)
  const output = tokens(usage.output)
  const reasoning = tokens(usage.reasoning)
  const cacheRead = tokens(usage.cacheRead)
  const cacheWrite = tokens(usage.cacheWrite)
  const prompt = input + cacheRead + cacheWrite

  const selected =
    price.tiers
      .filter((tier) => tier.tier?.type === "context" && prompt > tier.tier.size)
      .sort((left, right) => (right.tier?.size ?? 0) - (left.tier?.size ?? 0))[0] ??
    price.tiers.find((tier) => tier.tier === undefined)
  if (selected === undefined) return undefined

  // A model known to be free is not an unknown price: storing 0 keeps it out
  // of the backfill's "needs an estimate" set without inventing money.
  if (selected.input === 0 && selected.output === 0 && selected.cacheRead === 0 && selected.cacheWrite === 0) return 0

  const billed =
    input * selected.input +
    (output + reasoning) * selected.output +
    cacheRead * selected.cacheRead +
    cacheWrite * selected.cacheWrite
  if (!Number.isFinite(billed) || billed <= 0) return undefined
  return billed / 1_000_000
}
