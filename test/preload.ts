import { mock } from "bun:test"
import * as clientSolid from "solid-js/dist/solid.js"

/**
 * Test-only preload.
 *
 * Bun resolves the bare `solid-js` specifier to `dist/server.js`, where signals
 * do not track and render effects run once. The host resolves the client build
 * (as `@opentui/solid` does internally with an explicit path), so every module
 * loaded by the tests — the harness, the plugin under test and the renderer —
 * must share that one instance for re-render assertions to mean anything.
 */
mock.module("solid-js", () => clientSolid)
