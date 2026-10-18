import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, sep } from "node:path"
import { defaultDbPath, ensureRegularFile, expandHome, resolveDbPath } from "../src/stats/paths"

/**
 * Where the database lives, on every OS, and what the plugin refuses to open.
 * Pure path rules, so all three platforms are asserted from any machine.
 */

const POSIX = process.platform !== "win32"

describe("defaultDbPath", () => {
  test("linux honours XDG_STATE_HOME", () => {
    expect(defaultDbPath({ XDG_STATE_HOME: "/x" }, "linux")).toBe("/x/opencode/stats/stats.db")
  })

  test("linux falls back to ~/.local/state", () => {
    expect(defaultDbPath({}, "linux")).toBe(join(homedir(), ".local", "state", "opencode", "stats", "stats.db"))
  })

  test("macOS uses Application Support", () => {
    expect(defaultDbPath({}, "darwin")).toBe(join(homedir(), "Library", "Application Support", "opencode", "stats", "stats.db"))
  })

  test("windows uses LOCALAPPDATA", () => {
    expect(defaultDbPath({ LOCALAPPDATA: "C:/AppData" }, "win32")).toBe(join("C:/AppData", "opencode", "stats", "stats.db"))
  })

  test("windows falls back to the home directory", () => {
    expect(defaultDbPath({}, "win32")).toBe(join(homedir(), "AppData", "Local", "opencode", "stats", "stats.db"))
  })
})

describe("resolveDbPath", () => {
  test("precedence: option, env, default", () => {
    expect(resolveDbPath("/custom.db", { OPENCODE_USAGE_INSIGHTS_DB: "/env.db", XDG_STATE_HOME: "/x" }, "linux")).toBe("/custom.db")
    expect(resolveDbPath(undefined, { OPENCODE_USAGE_INSIGHTS_DB: "/env.db", XDG_STATE_HOME: "/x" }, "linux")).toBe("/env.db")
    expect(resolveDbPath(undefined, { XDG_STATE_HOME: "/x" }, "linux")).toBe("/x/opencode/stats/stats.db")
  })

  test("expands a leading ~ in every source", () => {
    const home = join(sep, "home", "someone")
    expect(resolveDbPath("~/stats.db", { HOME: home }, "linux")).toBe(join(home, "stats.db"))
    expect(resolveDbPath(undefined, { HOME: home, OPENCODE_USAGE_INSIGHTS_DB: "~/env.db" }, "linux")).toBe(join(home, "env.db"))
    // A Windows configuration uses the backslash form.
    expect(resolveDbPath("~\\stats.db", { HOME: home }, "linux")).toBe(join(home, "stats.db"))
    // A `~` in the middle of a path is a literal character, not a home.
    expect(resolveDbPath("/tmp/~stats.db", { HOME: home }, "linux")).toBe("/tmp/~stats.db")
  })

  test("uses USERPROFILE when HOME is unset", () => {
    expect(resolveDbPath("~/stats.db", { USERPROFILE: "C:/Users/dev" }, "win32")).toBe(join("C:/Users/dev", "stats.db"))
  })
})

describe("expandHome", () => {
  test("expands only a leading tilde", () => {
    const home = join(sep, "home", "u")
    expect(expandHome("~", home)).toBe(home)
    expect(expandHome("~/a/b", home)).toBe(join(home, "a/b"))
    expect(expandHome("~user/a", home)).toBe("~user/a")
    expect(expandHome("./a", home)).toBe("./a")
  })
})

describe("ensureRegularFile", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-insights-paths-"))

  test("accepts a missing file: the plugin creates it", () => {
    expect(() => ensureRegularFile(join(directory, "new.db"))).not.toThrow()
  })

  test("accepts a regular file, and a symlink to one", () => {
    const file = join(directory, "stats.db")
    writeFileSync(file, "")
    expect(() => ensureRegularFile(file)).not.toThrow()
    // Creating a symlink needs a privilege Windows only grants with developer
    // mode; where it cannot be made, only that half of the check is skipped.
    const link = join(directory, "link.db")
    try {
      symlinkSync(file, link)
    } catch {
      return
    }
    expect(() => ensureRegularFile(link)).not.toThrow()
  })

  test("refuses a directory", () => {
    const nested = join(directory, "nested")
    mkdirSync(nested, { recursive: true })
    expect(() => ensureRegularFile(nested)).toThrow(/not a regular file/)
  })

  test.skipIf(!POSIX)("refuses a device or a FIFO", () => {
    expect(() => ensureRegularFile("/dev/null")).toThrow(/not a regular file/)
  })

  test("cleanup", () => {
    rmSync(directory, { recursive: true, force: true })
  })
})
