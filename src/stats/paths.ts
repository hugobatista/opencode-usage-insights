import { homedir } from "node:os"
import { join } from "node:path"

/**
 * SQLite database used when no `db` option is configured: the per-user state
 * directory of the current OS, never a shared temp directory.
 *
 * - Windows: `%LOCALAPPDATA%\opencode\stats\stats.db`
 * - macOS: `~/Library/Application Support/opencode/stats/stats.db`
 * - Linux/other: `$XDG_STATE_HOME/opencode/stats/stats.db`, falling back to
 *   `~/.local/state/opencode/stats/stats.db`
 *
 * Pure by design so every OS can be asserted from any machine.
 */
export function defaultDbPath(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const name = join("opencode", "stats", "stats.db")
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), name)
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", name)
  }
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), name)
}

/**
 * Resolve the effective database path: explicit plugin option first, then the
 * `OPENCODE_USAGE_INSIGHTS_DB` escape hatch (handy for dev and tests), then
 * the per-OS state directory.
 */
export function resolveDbPath(
  configured?: string | undefined,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  if (configured) return configured
  if (env.OPENCODE_USAGE_INSIGHTS_DB) return env.OPENCODE_USAGE_INSIGHTS_DB
  return defaultDbPath(env, platform)
}
