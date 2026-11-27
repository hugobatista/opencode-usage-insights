import { describe, expect, test } from "bun:test"
import { MAX_PANEL_WIDTH, MAX_TURNS, clampPanelWidth, clampTurnsLimit } from "../src/limits"
import { UsageInsights } from "../src/rpc"

describe("the shared request limits", () => {
  test("match the RPC schemas", () => {
    expect(UsageInsights.methods.panel.input.properties.width.maximum).toBe(MAX_PANEL_WIDTH)
    expect(UsageInsights.methods.turns.input.properties.limit.maximum).toBe(MAX_TURNS)
  })

  test("clamp a panel width before the RPC sees it", () => {
    expect(clampPanelWidth(20)).toBe(20)
    expect(clampPanelWidth(200)).toBe(200)
    expect(clampPanelWidth(201)).toBe(MAX_PANEL_WIDTH)
    expect(clampPanelWidth(999)).toBe(MAX_PANEL_WIDTH)
    expect(clampPanelWidth(19)).toBe(20)
    expect(clampPanelWidth(60.6)).toBe(61)
    expect(clampPanelWidth(Number.NaN)).toBe(20)
  })

  test("clamp a turn limit before the RPC sees it", () => {
    expect(clampTurnsLimit(1)).toBe(1)
    expect(clampTurnsLimit(8)).toBe(8)
    expect(clampTurnsLimit(50)).toBe(50)
    expect(clampTurnsLimit(51)).toBe(MAX_TURNS)
    expect(clampTurnsLimit(500)).toBe(MAX_TURNS)
    expect(clampTurnsLimit(0)).toBe(1)
    expect(clampTurnsLimit(8.4)).toBe(8)
    expect(clampTurnsLimit(Number.NaN)).toBe(1)
  })
})
