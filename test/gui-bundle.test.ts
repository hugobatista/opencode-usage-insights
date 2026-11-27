import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

/**
 * Evaluate the published Desktop bundle the way the app does: one CommonJS
 * function whose `require` is the app's shared-module map. This catches a
 * bundle that builds but fails at startup (a module-scope DOM call, a missing
 * shared module, a broken `Plugin.define`) before a Desktop window sees it.
 */

const bundlePath = join(import.meta.dir, "..", "dist", "gui-experimental.cjs")

// A fresh checkout has no `dist`; `bun run build` creates it. The test runs in
// CI after the build and in prepublish after the build, and stays out of the
// way for a plain `bun test` in a source tree.
if (existsSync(bundlePath)) {
  beforeAll(async () => {
    GlobalRegistrator.register()
    // Bun resolves bare `solid-js` to the server build; the Desktop window uses
    // the client build. Point both the runtime and `solid-js/web` at the client
    // files before the bundle's modules are imported.
    const root = join(import.meta.dir, "..", "node_modules", "solid-js")
    const solid = await import(pathToFileURL(join(root, "dist", "solid.js")).href)
    mock.module("solid-js", () => solid)
    const web = await import(pathToFileURL(join(root, "web", "dist", "web.js")).href)
    mock.module("solid-js/web", () => web)
  })

  afterAll(() => {
    GlobalRegistrator.unregister()
  })

  describe("the built Desktop bundle", () => {
    test("evaluates to a Plugin.define with the published declarations", async () => {
      const code = readFileSync(bundlePath, "utf8")
      const modules: Record<string, unknown> = {
        "solid-js": await import("solid-js"),
        "solid-js/web": await import("solid-js/web"),
        effect: await import("effect"),
        "@opencode/plugin/gui": await import("@opencode/plugin/gui"),
        "@opencode/plugin/rpc": await import("@opencode/plugin/rpc"),
      }
      const module = { exports: {} as Record<string, unknown> }
      new Function("require", "module", "exports", code)(
        (name: string) => {
          if (!(name in modules)) throw new Error(`the GUI bundle requires an unexpected module: ${name}`)
          return modules[name]
        },
        module,
        module.exports,
      )
      const plugin = module.exports.default as
        | { setup?: unknown; stores?: unknown; icons?: unknown; i18n?: unknown }
        | undefined
      expect(plugin).toBeDefined()
      expect(typeof plugin?.setup).toBe("function")
      expect(plugin?.stores).toBeDefined()
      expect(plugin?.icons).toBeDefined()
      expect(plugin?.i18n).toBeDefined()
    })
  })
}
