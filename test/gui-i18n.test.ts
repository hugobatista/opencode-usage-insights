import { expect, test } from "bun:test"
import en from "../src/gui/i18n/en"

test("the desktop panels use their product names", () => {
  expect(en["panel.title"]).toBe("Usage insights")
  expect(en["panel.turns"]).toBe("Turns insights")
})
