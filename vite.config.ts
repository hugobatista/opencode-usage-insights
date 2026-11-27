import { join } from "node:path"
import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// The GUI part is one CommonJS bundle: the app evaluates it in every window
// and in its main process. `gui()` keeps the modules the app provides
// external and fails the build on a dependency it cannot share.
//
// The build script points this at a staging directory and swaps it into place
// only after every step succeeds, so a running server never watches `dist`
// disappear while it rebuilds. `gui()` writes its bundle through `outFile`, so
// that option, not only `build.outDir`, has to follow the staging directory.
const outDir = process.env.OPENCODE_USAGE_INSIGHTS_DIST
const outFile = outDir !== undefined && outDir !== "" ? join(outDir, "gui-experimental.cjs") : undefined

export default defineConfig({
  plugins: [gui(outFile === undefined ? {} : { outFile })],
  build: {
    ...(outDir !== undefined && outDir !== "" ? { outDir } : {}),
    emptyOutDir: false,
  },
})
