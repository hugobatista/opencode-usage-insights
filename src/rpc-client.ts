import type { OpenCodeClient } from "@opencode/client"
import {
  UsageInsights,
  type BackfillInput,
  type FiltersOutput,
  type ListCostInput,
  type ListCostOutput,
  type PanelInput,
  type PanelOutput,
  type PruneInput,
  type RecordedEvent,
  type TurnsInput,
  type TurnsOutput,
  type VacuumInput,
  type VacuumOutput,
  type WipeInput,
} from "./rpc"
import type { BackfillResult, PruneResult, WipeResult } from "./stats/maintenance"

/**
 * Typed client for the usage RPC, shared by the TUI and the desktop GUI. The
 * contract uses JSON Schema, so the generated client returns `unknown`; this
 * wrapper is the one place the plugin casts it back to the declared types.
 */

export type UsageLocation = {
  directory?: string | undefined
}

export type UsageApi = ReturnType<typeof usageApi>

export function usageApi(client: OpenCodeClient, location?: UsageLocation | undefined) {
  const rpc = client.rpc(UsageInsights)
  const options = (signal?: AbortSignal | undefined) => ({
    ...(location !== undefined && location.directory !== undefined ? { location: { directory: location.directory } } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })

  return {
    panel: (input: PanelInput, signal?: AbortSignal) =>
      rpc.panel(input, options(signal)) as Promise<PanelOutput>,
    turns: (input: TurnsInput, signal?: AbortSignal) =>
      rpc.turns(input, options(signal)) as Promise<TurnsOutput>,
    listCost: (input: ListCostInput, signal?: AbortSignal) =>
      rpc.listCost(input, options(signal)) as Promise<ListCostOutput>,
    filters: (signal?: AbortSignal) => rpc.filters({}, options(signal)) as Promise<FiltersOutput>,
    dbInfo: (signal?: AbortSignal) => rpc.dbInfo({}, options(signal)) as Promise<import("./stats/maintenance").DbInfo>,
    prune: (input: PruneInput, signal?: AbortSignal) =>
      rpc.prune(input, options(signal)) as Promise<PruneResult>,
    wipe: (input: WipeInput, signal?: AbortSignal) =>
      rpc.wipe(input, options(signal)) as Promise<WipeResult>,
    vacuum: (input: VacuumInput, signal?: AbortSignal) =>
      rpc.vacuum(input, options(signal)) as Promise<VacuumOutput>,
    backfill: (input: BackfillInput, signal?: AbortSignal) =>
      rpc.backfill(input, options(signal)) as Promise<BackfillResult>,
    onRecorded: (handler: (event: RecordedEvent) => void, signal?: AbortSignal) =>
      rpc.events.on("recorded", (event) => handler(event.data as RecordedEvent), signal === undefined ? undefined : { signal }),
  }
}
