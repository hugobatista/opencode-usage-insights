/**
 * Render the documentation images: the live line, the session sidebar and a
 * few panel views, from the same seeded database `bun run demo` prints.
 *
 *   bun run docs:images
 *
 * Each image is captured from the real components through the same headless
 * harness the tests use (`test/harness.ts`), so a screenshot cannot drift from
 * what the TUI renders. The SVG source goes to a throwaway directory and the
 * PNG lands in `docs/images/`; converting needs ImageMagick with an SVG
 * delegate (`magick`), and without it the SVGs are kept instead.
 */
import { mock } from "bun:test"
import * as clientSolid from "solid-js/dist/solid.js"

// The same alignment `test/preload.ts` does for the tests, and the reason the
// Solid imports below are dynamic: Bun resolves the bare `solid-js` specifier
// to the server build, where signals do not track, while the renderer uses the
// client build. Both sides must share one instance or nothing ever paints.
mock.module("solid-js", () => clientSolid)

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { RGBA, type CapturedFrame } from "@opentui/core"
import { PANEL_NAME } from "../src/panel-data"
import { DEMO_SESSION_ID, demoAt, openDemoDatabase, recorderTurn1, recorderTurn2 } from "./demo-seed"

// Dynamic on purpose: both load Solid, which must resolve to the mocked client
// build above. Load anything that imports `solid-js` from a static import and
// it runs before `mock.module`, against the server build.
const { testRender } = await import("@opentui/solid")
const { createHarness } = await import("../test/harness")

const FONT_SIZE = 15
const LINE_HEIGHT = 20
// Monospace advance width: every font in the stack below is 0.6 em wide.
const CHAR_WIDTH = FONT_SIZE * 0.6
const PADDING = 16
const FONT_STACK = "MesloLGS Nerd Font Mono, Noto Sans Mono, DejaVu Sans Mono, monospace"

/** A dark palette with the plugin's four tones; coordinates with the panel. */
const THEME = {
  background: RGBA.fromHex("#101215"),
  raised: RGBA.fromHex("#232833"),
  raisedHigh: RGBA.fromHex("#323a4a"),
  base: RGBA.fromHex("#d7dae0"),
  muted: RGBA.fromHex("#8b93a1"),
  warning: RGBA.fromHex("#e5c07b"),
  accent: RGBA.fromHex("#61afef"),
}

const here = dirname(fileURLToPath(import.meta.url))
const imagesDir = join(here, "..", "docs", "images")
const svgDir = mkdtempSync(join(tmpdir(), "usage-insights-docs-"))
mkdirSync(imagesDir, { recursive: true })

const demo = openDemoDatabase()
// The plugin resolves its database on first use, so the escape hatch must be
// in place before any component renders.
process.env.OPENCODE_USAGE_INSIGHTS_DB = demo.path

const harness = createHarness({
  sessions: [
    {
      id: DEMO_SESSION_ID,
      created: demoAt(0),
      tokens: { input: 106_400, output: 6_100, reasoning: 900, cache: { read: 2_890_000, write: 700 } },
      cost: 0.27,
      messages: [...recorderTurn1, ...recorderTurn2],
    },
  ],
  theme: {
    text: { base: THEME.base, muted: THEME.muted, feedback: { warning: { base: THEME.warning }, info: { base: THEME.accent } } },
    background: { base: THEME.background, raised: { base: THEME.raised, high: THEME.raisedHigh } },
  },
})

/**
 * Render one claim, capture the frame, and return its SVG. The `background` is
 * the surface the claim sits on: the session panel is drawn on `raised.base`, so
 * its images use that canvas and the cursor band reads as it does in the TUI.
 */
async function renderSvg(render: () => unknown, size: { width: number; height: number }, background: RGBA = THEME.background): Promise<string> {
  // First pass at a generous height: the panel draws a full-height scrollbar
  // even when the view fits, so the painted content — not the frame — decides
  // how tall the image is. The second pass renders at exactly that height.
  const probe = await renderFrame(render, { width: size.width, height: Math.max(size.height, 60) }, background)
  const height = Math.max(1, contentHeight(probe))
  const frame = height === probe.lines.length ? probe : await renderFrame(render, { width: size.width, height }, background)
  return frameToSvg(frame, background)
}

async function renderFrame(render: () => unknown, size: { width: number; height: number }, background: RGBA): Promise<CapturedFrame> {
  const setup = await testRender(render as never, { ...size, backgroundColor: background })
  try {
    await setup.renderOnce()
    return setup.captureSpans()
  } finally {
    await setup.dispose()
  }
}

/** The last row the component painted, ignoring the scrollbar column. */
function contentHeight(frame: CapturedFrame): number {
  let last = 0
  for (const [index, line] of frame.lines.entries()) {
    const text = line.spans.map((span) => span.text).join("")
    if (text.slice(0, Math.max(0, text.length - 2)).trim() !== "") last = index + 1
  }
  return last
}

/** What a captured frame looks like as an SVG: one text element per row. */
function frameToSvg(frame: CapturedFrame, background: RGBA): string {
  // Drop the rows the component never painted, and size the canvas to the
  // last cell any row actually wrote.
  let lastRow = -1
  let columns = 0
  for (const [index, line] of frame.lines.entries()) {
    let cell = 0
    for (const span of line.spans) {
      if (span.text.trim() !== "") {
        lastRow = index
        columns = Math.max(columns, cell + span.width)
      }
      cell += span.width
    }
  }
  const rows = frame.lines.slice(0, lastRow + 1)

  const width = columns * CHAR_WIDTH + PADDING * 2
  const height = rows.length * LINE_HEIGHT + PADDING * 2
  const pieces: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="8" fill="${hex(background)}"/>`,
    `<g font-family="${FONT_STACK}" font-size="${FONT_SIZE}" xml:space="preserve">`,
  ]

  for (const [row, line] of rows.entries()) {
    const y = PADDING + row * LINE_HEIGHT
    let cell = 0
    const backgrounds: string[] = []
    const texts: string[] = []
    let run: { fg: RGBA; text: string } | undefined
    for (const span of line.spans) {
      const cellX = cell * CHAR_WIDTH
      if (!span.bg.equals(background)) {
        backgrounds.push(`<rect x="${round(cellX)}" y="0" width="${round(span.width * CHAR_WIDTH)}" height="${LINE_HEIGHT}" fill="${hex(span.bg)}"/>`)
      }
      if (run !== undefined && run.fg.equals(span.fg)) run.text += span.text
      else {
        if (run !== undefined) texts.push(`<tspan fill="${hex(run.fg)}">${escapeXml(run.text)}</tspan>`)
        run = { fg: span.fg, text: span.text }
      }
      cell += span.width
    }
    if (run !== undefined) texts.push(`<tspan fill="${hex(run.fg)}">${escapeXml(run.text)}</tspan>`)
    // Backgrounds sit on the row's own box; the text baseline is the row top
    // plus one font size, so the two need different offsets.
    if (backgrounds.length > 0) pieces.push(`<g transform="translate(${PADDING} ${y})">${backgrounds.join("")}</g>`)
    pieces.push(
      `<g transform="translate(${PADDING} ${y + FONT_SIZE})"><text xml:space="preserve">${texts.join("")}</text></g>`,
    )
  }

  pieces.push("</g>", "</svg>", "")
  return pieces.join("\n")
}

const round = (value: number): string => String(Math.round(value * 100) / 100)

function hex(color: RGBA): string {
  const [r, g, b] = color.toInts()
  return `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Write one image: the SVG source, then the PNG next to it when `magick` can. */
function writeImage(name: string, svg: string): { name: string; png: boolean } {
  const svgPath = join(svgDir, `${name}.svg`)
  writeFileSync(svgPath, svg)
  const pngPath = join(imagesDir, `${name}.png`)
  const converted = spawnSync("magick", ["-density", "192", svgPath, pngPath], { stdio: "ignore" })
  if (converted.status === 0) return { name, png: true }
  // No ImageMagick (or no SVG delegate): keep the vector source instead of
  // failing the run, and say which images are still vectors.
  writeFileSync(join(imagesDir, `${name}.svg`), svg)
  return { name, png: false }
}

const results: Array<{ name: string; png: boolean }> = []

const lineClaim = harness.claim("session.composer.top")
if (lineClaim === undefined) throw new Error("the plugin did not claim the composer slot")
results.push(
  writeImage(
    "line",
    await renderSvg(() => lineClaim.render({ sessionID: DEMO_SESSION_ID } as never), { width: 170, height: 3 }),
  ),
)

const sidebarClaim = harness.claim("sidebar.content")
if (sidebarClaim === undefined) throw new Error("the plugin did not claim the sidebar slot")
results.push(
  writeImage(
    "sidebar",
    await renderSvg(() => sidebarClaim.render({ sessionID: DEMO_SESSION_ID } as never), { width: 40, height: 20 }),
  ),
)

const panelClaim = harness.claim("session.panel")
if (panelClaim === undefined) throw new Error("the plugin did not claim the session panel")
const panelInput = {
  name: PANEL_NAME,
  sessionID: DEMO_SESSION_ID,
  width: 104,
  presentation: "panel",
  focused: false,
  close: () => {},
  focus: () => {},
  toggleFullscreen: () => {},
}
for (const view of ["overview", "endpoints", "cache"] as const) {
  const command = harness.command("usage-insights.stats")
  if (command === undefined) throw new Error("the plugin did not register the /usage command")
  command.run(view)
  results.push(
    writeImage(`panel-${view}`, await renderSvg(() => panelClaim.render(panelInput as never), { width: 104, height: 40 }, THEME.raised)),
  )
}

harness.cleanup?.()
demo.db.close()
rmSync(demo.root, { recursive: true, force: true })
rmSync(svgDir, { recursive: true, force: true })

for (const result of results) {
  console.log(`${result.name}.${result.png ? "png" : "svg (magick unavailable)"} -> docs/images/`)
}
if (results.some((result) => !result.png)) {
  console.log("Install ImageMagick with an SVG delegate to write PNGs.")
}
