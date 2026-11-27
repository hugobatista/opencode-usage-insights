import { describe, expect, test } from "bun:test"
import { lineFor, lineTextFor } from "../src/gui/line"
import type { RuntimeMessage } from "../src/line"

const MODEL = { providerID: "opencode", id: "deepseek-v4.1-flash" }

function turn(messageID: string): RuntimeMessage[] {
  return [
    { id: `prt_${messageID}`, type: "user", time: { created: 1_000 } },
    {
      id: messageID,
      type: "assistant",
      time: { created: 1_001, completed: 1_005 },
      model: MODEL,
      tokens: { input: 1_000, output: 50, reasoning: 0, cache: { read: 50_000, write: 0 } },
      cost: 0.02,
    },
  ]
}

const messages = [...turn("msg_gui_1"), ...turn("msg_gui_2")]

describe("the desktop line helpers", () => {
  test("computes the same turn as the TUI from the synced transcript", () => {
    const stats = lineFor({
      messages,
      info: { cost: 0.04, tokens: { input: 2_000, output: 100, cache: { read: 100_000 } }, time: { created: 0 } },
      listCost: 0,
      status: "idle",
    })
    expect(stats).toBeDefined()
    expect(stats!.providerID).toBe("opencode")
    expect(stats!.modelID).toBe("deepseek-v4.1-flash")
    expect(stats!.totals.output).toBe(50)
    expect(lineTextFor(stats, { estimates: true })).toContain("cost $0.0200")
  })

  test("hides the badge while the turn is running", () => {
    expect(lineFor({ messages, info: undefined, listCost: 0, status: "running" })).toBeUndefined()
  })

  test("shows the stored list estimate in the session segment", () => {
    const stats = lineFor({
      messages,
      info: { cost: 0, tokens: { input: 2_000, output: 100, cache: { read: 100_000 } }, time: { created: 0 } },
      listCost: 0.25,
      status: "idle",
    })!
    const text = lineTextFor(stats, { estimates: true })
    expect(text).toContain("cost ≈ $0.2500")
  })

  test("hides estimates when pricing is off", () => {
    const stats = lineFor({
      messages,
      info: { cost: 0, tokens: { input: 2_000, output: 100, cache: { read: 100_000 } }, time: { created: 0 } },
      listCost: 0.25,
      status: "idle",
    })!
    const text = lineTextFor(stats, { estimates: false })
    expect(text).not.toContain("≈")
  })
})
