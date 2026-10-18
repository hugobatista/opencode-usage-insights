import { homedir } from "node:os"
import { join } from "node:path"
import { statSync } from "node:fs"

/**
 * SQLite database used when no `db` option is configured: the per-user state
 * directory of the current OS, never a shared temp directory.
 *
 * The subdirectory is the plugin's package name, never a generic one: the
 * `opencode` tree is shared with OpenCode itself and with every other plugin,
 * so a `stats/` of our own would be a collision waiting to happen.
 *
 * - Windows: `%LOCALAPPDATA%\opencode\opencode-usage-insights\usage.db`
 * - macOS: `~/Library/Application Support/opencode/opencode-usage-insights/usage.db`
 * - Linux/other: `$XDG_STATE_HOME/opencode/opencode-usage-insights/usage.db`,
 *   falling back to `~/.local/state/opencode/opencode-usage-insights/usage.db`
 *
 * Pure by design so every OS can be asserted from any machine.
 */
export function defaultDbPath(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  const name = join("opencode", "opencode-usage-insights", "usage.db")
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), name)
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", name)
  }
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), name)
}

/**
 * Expand a leading `~` (or `~/`), so a configured path reads the way every
 * shell does. Windows accepts the backslash form too.
 */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2))
  return path
}

/**
 * Resolve the effective database path: explicit plugin option first, then the
 * `OPENCODE_USAGE_INSIGHTS_DB` escape hatch (handy for dev and tests), then
 * the per-OS state directory. A leading `~` is expanded in all three.
 */
export function resolveDbPath(
  configured?: string | undefined,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir()
  if (configured) return expandHome(configured, home)
  if (env.OPENCODE_USAGE_INSIGHTS_DB) return expandHome(env.OPENCODE_USAGE_INSIGHTS_DB, home)
  return defaultDbPath(env, platform)
}

/**
 * A configured path must not be a directory, a device or a FIFO: SQLite would
 * fail obscurely, or write where nobody expects it. Symlinks to a regular file
 * are followed (`statSync`, not `lstat`) because moving the state directory to
 * another disk is a legitimate setup. A missing file is fine — the plugin
 * creates it.
 */
export function ensureRegularFile(path: string): void {
  let stats
  try {
    stats = statSync(path)
  } catch {
    return
  }
  if (!stats.isFile()) throw new Error(`not a regular file: ${path}`)
}
