/**
 * Shared request bounds.
 *
 * The RPC schemas, the clients and the service use the same numbers: a client
 * must clamp before it calls the RPC, because schema validation runs before the
 * service can clamp. These constants keep the three layers from drifting.
 */

/** Widest panel the server formats. */
export const MAX_PANEL_WIDTH = 200

/** Most turns the server returns for a history request. */
export const MAX_TURNS = 50

/** A finite width within the panel bounds. */
export function clampPanelWidth(value: number): number {
  if (!Number.isFinite(value)) return 20
  return Math.min(MAX_PANEL_WIDTH, Math.max(20, Math.round(value)))
}

/** A finite turn limit within the history bounds. */
export function clampTurnsLimit(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_TURNS, Math.max(1, Math.round(value)))
}
