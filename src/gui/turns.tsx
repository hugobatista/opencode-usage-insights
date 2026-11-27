/** @jsxImportSource solid-js */
import { For, Show, createMemo } from "solid-js"
import { createLatest, usePanel, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import type { PanelLine } from "../panel-data"
import { usageApi } from "../rpc-client"
import { toneClass } from "./line"

/**
 * The dedicated Turns insights tab. It is the full session history — the TUI
 * sidebar's content — in the side region, without the usage panel's view
 * selector. It is the one to keep open.
 */
export function TurnsPanel(props: {
  readonly session: MountedSession
  readonly refresh: () => number
  readonly limit: number
}) {
  const ctx = usePlugin()
  const panel = usePanel()

  const source = createMemo(() => {
    if (!panel.visible()) return undefined
    return {
      client: props.session.server.client,
      id: props.session.id,
      directory: props.session.directory,
      refresh: props.refresh(),
    }
  })

  const result = createLatest(source, (value, signal) =>
    usageApi(value.client, { directory: value.directory }).turns(
      { sessionID: value.id, limit: props.limit, width: 64 },
      signal,
    ),
  )

  const lines = (source: readonly PanelLine[]): PanelLine[] => source.filter((line) => line.hint !== true)

  return (
    <div data-component="oui-panel">
      <div data-slot="oui-header">
        <div data-slot="oui-title-row">
          <span data-slot="oui-title">{ctx.t("panel.turns")}</span>
          <span data-slot="oui-subtitle">{result.loading ? "…" : ""}</span>
        </div>
      </div>

      <div data-slot="oui-body" data-scrollable>
        <Show
          when={result.latest}
          fallback={
            <Show
              when={result.error !== undefined}
              fallback={<div data-slot="oui-loading">{ctx.t("panel.loading")}</div>}
            >
              <div data-slot="oui-error">{ctx.t("panel.unavailable")}</div>
            </Show>
          }
        >
          {(latest) => (
            <div data-slot="oui-lines" style={{ "font-family": ctx.appearance.font("mono") }}>
              <For each={lines(latest().summary)}>
                {(line) => <div data-slot="oui-line" class={toneClass(line.tone)}>{line.text}</div>}
              </For>
              <Show
                when={latest().history.length > 0}
                fallback={<div data-slot="oui-empty">{ctx.t("panel.noTurns")}</div>}
              >
                <div data-slot="oui-divider" aria-hidden="true" />
                <For each={lines(latest().history)}>
                  {(line) => <div data-slot="oui-line" class={toneClass(line.tone)}>{line.text}</div>}
                </For>
              </Show>
            </div>
          )}
        </Show>
      </div>

      <div data-slot="oui-actions">
        <ctx.ui.Button
          size="small"
          variant="neutral"
          onClick={() => ctx.layout.open(`${ctx.id}:usage`, props.session, { tab: "select" })}
        >
          {ctx.t("panel.openUsage")}
        </ctx.ui.Button>
      </div>
    </div>
  )
}
