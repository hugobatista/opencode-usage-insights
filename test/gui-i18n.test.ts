import { expect, test } from "bun:test"
import en from "../src/gui/i18n/en"

test("the desktop panels use their product names", () => {
  expect(en["panel.title"]).toBe("Usage insights")
  expect(en["panel.turns"]).toBe("Turns insights")
  expect(en["panel.view"]).toBe("View")
  expect(en["panel.scope"]).toBe("Scope")
  expect(en["panel.granularity"]).toBe("Granularity")
  expect(en["panel.wipe"]).toBe("Wipe all history")
})
