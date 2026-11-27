// Build the npm entrypoints: the server, the TUI, the RPC contract and the
// database worker with Bun, and the desktop GUI as one CommonJS bundle with
// Vite. Host-provided modules stay external so the plugin uses the host
// runtime.
import solidPlugin from "@opentui/solid/bun-plugin"
import { existsSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const dist = join(root, "dist")
const staging = join(root, ".dist-build")
const previous = join(root, ".dist-old")

// Build into a staging directory and swap it into place only after every step
// succeeded. A running plugin service watches `dist`; deleting it in place
// makes it observe missing entrypoints for the whole build.
rmSync(staging, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/tui.tsx", "src/rpc.ts", "src/stats-worker.ts"],
  outdir: staging,
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
    "@opencode/plugin/rpc",
    "@opencode/plugin/gui",
    "@opencode/theme",
    "@opentui/core",
    "@opentui/solid",
    "effect",
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
const tsc = join(root, "node_modules", "typescript", "lib", "tsc.js")
const declarations = Bun.spawnSync([process.execPath, tsc, "-p", "tsconfig.build.json", "--outDir", staging], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
})
if (declarations.exitCode !== 0) {
  console.error("tsc declarations failed")
  process.exit(1)
}

// Vite reads vite.config.ts, compiles Solid JSX and writes the single
// gui-experimental.cjs bundle into the staging directory. The preset keeps the
// host modules external and does not empty the directory, so the server, TUI
// and worker outputs survive.
const vite = join(root, "node_modules", "vite", "bin", "vite.js")
const gui = Bun.spawnSync([process.execPath, vite, "build"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, OPENCODE_USAGE_INSIGHTS_DIST: staging },
})
if (gui.exitCode !== 0) {
  console.error("vite build failed")
  process.exit(1)
}

// Swap the complete staging directory in one rename. The old tree is moved
// aside first, then restored if the final rename fails, so a failed build
// leaves the last working `dist` intact.
rmSync(previous, { recursive: true, force: true })
try {
  if (existsSync(dist)) renameSync(dist, previous)
  renameSync(staging, dist)
} catch (error) {
  if (!existsSync(dist) && existsSync(previous)) renameSync(previous, dist)
  console.error(`could not replace dist: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
rmSync(previous, { recursive: true, force: true })

console.log("built dist/index.js + dist/tui.js + dist/rpc.js + dist/stats-worker.js + dist/gui-experimental.cjs + declarations")
