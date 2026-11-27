// Build the npm entrypoints: the server, the TUI, the RPC contract and the
// database worker with Bun, and the desktop GUI as one CommonJS bundle with
// Vite. Host-provided modules stay external so the plugin uses the host
// runtime.
import solidPlugin from "@opentui/solid/bun-plugin"
import { rmSync } from "node:fs"
import { join } from "node:path"

// The package ships whatever `dist` holds, and neither Bun.build nor tsc
// removes what a deleted module left behind: a stale `endpoint.d.ts` outlived
// the module it described once. Start from an empty directory.
rmSync("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/tui.tsx", "src/rpc.ts", "src/stats-worker.ts"],
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
const root = join(import.meta.dir, "..")
const tsc = join(root, "node_modules", "typescript", "lib", "tsc.js")
const declarations = Bun.spawnSync([process.execPath, tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
})
if (declarations.exitCode !== 0) {
  console.error("tsc declarations failed")
  process.exit(1)
}

// Vite reads vite.config.ts, compiles Solid JSX and writes the single
// dist/gui-experimental.cjs bundle. The preset keeps the host modules external
// and does not empty the directory, so the server, TUI and worker outputs
// survive.
const vite = join(root, "node_modules", "vite", "bin", "vite.js")
const gui = Bun.spawnSync([process.execPath, vite, "build"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
})
if (gui.exitCode !== 0) {
  console.error("vite build failed")
  process.exit(1)
}

console.log("built dist/index.js + dist/tui.js + dist/rpc.js + dist/stats-worker.js + dist/gui-experimental.cjs + declarations")
