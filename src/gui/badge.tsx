/** @jsxImportSource solid-js */
import { Show, createMemo } from "solid-js"
import { usePlugin, type IconName } from "@opencode/plugin/gui"
import type { TurnStats } from "../core"
import { badgeLabel, lineTextFor, type GuiLineOptions } from "./line"

/**
 * The usage insights chip in the session header, next to the peak/off-peak
 * badge. It shows the finished turn's spend; the full telemetry line is the
 * hover title, and a click opens the Turns insights tab.
 */
export function UsageBadge(props: {
  readonly line: () => TurnStats | undefined
  readonly options: GuiLineOptions
  readonly icon: IconName
  readonly compact: boolean
  readonly panelEnabled: boolean
  readonly open: () => void
}) {
  const ctx = usePlugin()
  const stats = createMemo(() => props.line())
  const label = createMemo(() => badgeLabel(stats(), props.options))
  const title = createMemo(() => lineTextFor(stats(), props.options))

  const content = () => (
    <>
      <ctx.ui.Icon name={props.icon} size="small" />
      <Show when={!props.compact}>
        <span data-slot="oui-header-badge-label">{label()}</span>
      </Show>
    </>
  )

  return (
    <Show when={label()}>
      <Show
        when={props.panelEnabled}
        fallback={
          <span data-component="oui-header-badge" title={title()} aria-label={title()}>
            {content()}
          </span>
        }
      >
        <button
          type="button"
          data-component="oui-header-badge"
          title={title()}
          aria-label={props.compact ? title() : undefined}
          onClick={() => props.open()}
        >
          {content()}
        </button>
      </Show>
    </Show>
  )
}
