/**
 * Types for the explicit client build import used by `test/preload.ts`.
 *
 * Bun resolves the bare `solid-js` specifier to the package's server build,
 * where signals do not track; the tests point it at the client build instead
 * (the one `@opentui/solid` uses internally). The client build ships no types of
 * its own, and its public surface is the package's.
 */
declare module "solid-js/dist/solid.js" {
  export * from "solid-js"
}
