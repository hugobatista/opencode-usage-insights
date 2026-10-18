import { describe, expect, test } from "bun:test"
import { isToken, sanitizeLabel, sanitizeText, TEXT_LIMIT } from "../src/text"

/**
 * Text hygiene: the values that come from outside the plugin (a gateway header,
 * a model-written title, an imported dump) are shown in a terminal, so control
 * characters must not survive the trip.
 */

describe("sanitizeText", () => {
  test("drops the sequences a terminal would act on", () => {
    // The audit's payload: an OSC title change, a screen clear and a colour.
    const hostile = "gw\u001b]0;pwned\u0007\u001b[2J\u001b[31mred"
    const clean = sanitizeText(hostile)
    expect(clean).toBe("gw]0;pwned[2J[31mred")
    expect(clean).not.toContain("\u001b")
    expect(clean).not.toContain("\u0007")
  })

  test("drops newlines, tabs, DEL and the C1 block", () => {
    expect(sanitizeText("a\nb\tc\u007fd\u0085e")).toBe("abcde")
  })

  test("keeps the layout of the value: no trimming, no collapsing", () => {
    expect(sanitizeText("    indented title  ")).toBe("    indented title  ")
    expect(sanitizeText("a  b")).toBe("a  b")
  })

  test("keeps unicode, including astral characters", () => {
    expect(sanitizeText("café 🚀 über")).toBe("café 🚀 über")
  })

  test("caps the length", () => {
    expect(sanitizeText("x".repeat(1_000)).length).toBe(TEXT_LIMIT)
    expect(sanitizeText("x".repeat(1_000), 10)).toBe("x".repeat(10))
    expect(sanitizeText("anything", 0)).toBe("")
  })
})

describe("sanitizeLabel", () => {
  test("trims the stored label as well", () => {
    expect(sanitizeLabel("  spaced  ")).toBe("spaced")
    expect(sanitizeLabel("\u0007  gone  ")).toBe("gone")
  })
})

describe("identity tokens", () => {
  test("accepts the identifiers a provider or a model is named with", () => {
    for (const token of ["opencode-go", "deepseek", "deepseek-v4.1-flash", "opencode/anthropic", "a:b/c_d"]) {
      expect(isToken(token)).toBe(true)
    }
  })

  test("rejects anything that is not one token", () => {
    for (const token of ["", " leading", "with space", "esc\u001b[31m", "semi;colon", "x".repeat(65), "quote\"d"]) {
      expect(isToken(token)).toBe(false)
    }
  })
})
