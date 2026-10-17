// Build the npm entrypoints: dist/index.js + dist/tui.js and their
// declarations. Host-provided modules stay external so the plugin uses the
// host runtime.
import solidPlugin from "@opentui/solid/bun-plugin"
import { join } from "node:path"

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  sourcemap: "external",
  // Compiles JSX away via babel-preset-solid. Without this, bun emits a
  // jsx-dev-runtime import that has no runtime behind it inside node_modules.
  plugins: [solidPlugin],
  external: [
    "@opencode/plugin",
    "@opencode/plugin/tui",
    "@opencode/plugin/tui/context",
    "@opencode/theme",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
  ],
})

for (const log of result.logs) {
  if (log.level === "error") console.error(log.message)
}
if (!result.success) {
  console.error("bun build failed")
  process.exit(1)
}

// Run the TypeScript entry directly: `tsc` on PATH depends on node_modules/.bin
// and resolves to a .cmd shim on Windows, which spawn cannot execute.
const tsc = join(import.meta.dir, "..", "node_modules", "typescript", "lib", "tsc.js")
const proc = Bun.spawnSync([process.execPath, tsc, "-p", "tsconfig.build.json"], {
  cwd: join(import.meta.dir, ".."),
  stdio: ["ignore", "inherit", "inherit"],
})
if (proc.exitCode !== 0) {
  console.error("tsc declarations failed")
  process.exit(1)
}

console.log("built dist/index.js + dist/tui.js + declarations")
