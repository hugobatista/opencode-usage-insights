/**
 * Package smoke check, run after `bun run build`.
 *
 * It verifies that every published export points at a file, that the desktop
 * bundle is one CommonJS file requiring only modules the app provides, and
 * that the worker was emitted. This is the check CI runs after the build; the
 * Vite preset already refuses an unsupported module, and this catches a stale
 * package manifest or a forgotten build step.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports?: Record<string, unknown>
  files?: string[]
}

function fail(message: string): never {
  console.error(`check:package FAIL ${message}`)
  process.exit(1)
}

function fileOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (entry !== null && typeof entry === "object") {
    const record = entry as Record<string, unknown>
    for (const key of ["import", "default", "types"]) {
      const value = record[key]
      if (typeof value === "string") return value
    }
  }
  return undefined
}

for (const [name, entry] of Object.entries(pkg.exports ?? {})) {
  const file = fileOf(entry)
  if (file === undefined) fail(`export ${name} has no file`)
  if (!existsSync(join(root, file))) fail(`export ${name} points at missing ${file}`)
}

for (const file of ["dist/gui-experimental.cjs", "dist/stats-worker.js", "dist/rpc.js", "dist/index.js", "dist/tui.js"]) {
  if (!existsSync(join(root, file))) fail(`missing ${file}`)
}

const gui = readFileSync(join(root, "dist/gui-experimental.cjs"), "utf8")
if (/\bimport\s*\(/.test(gui)) fail("the GUI bundle contains a dynamic import")
const required = new Set<string>()
for (const match of gui.matchAll(/require\("([^"]+)"\)/g)) {
  const name = match[1]
  if (name !== undefined) required.add(name)
}
const allowed = new Set([
  "effect",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "@opencode/plugin/rpc",
  "@opencode/schema/rpc",
  "@opencode/client",
  "@opencode/client/effect",
  "@opencode/client/solid",
])
for (const name of required) {
  if (!allowed.has(name)) fail(`the GUI bundle requires a module the app does not provide: ${name}`)
  if (name.startsWith("bun:") || name.startsWith("node:")) fail(`the GUI bundle requires a Node/Bun module: ${name}`)
}

console.log(
  `check:package ok · ${Object.keys(pkg.exports ?? {}).length} exports · gui requires ${[...required].sort().join(", ")}`,
)
