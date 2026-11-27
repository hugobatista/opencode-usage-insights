import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// The GUI part is one CommonJS bundle: the app evaluates it in every window
// and in its main process. `gui()` keeps the modules the app provides
// external and fails the build on a dependency it cannot share.
export default defineConfig({
  plugins: [gui()],
  build: { emptyOutDir: false },
})
