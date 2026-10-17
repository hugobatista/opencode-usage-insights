# opencode-usage-insights

[![GitHub Tag](https://img.shields.io/github/v/tag/hugobatista/opencode-usage-insights?logo=github&label=latest)](https://github.com/hugobatista/opencode-usage-insights/releases)
[![Test](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-usage-insights/test.yml?label=Test)](https://github.com/hugobatista/opencode-usage-insights/actions/workflows/test.yml)
[![Lint](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-usage-insights/lint.yml?label=Lint)](https://github.com/hugobatista/opencode-usage-insights/actions/workflows/lint.yml)
[![npm](https://img.shields.io/npm/v/opencode-usage-insights.svg)](https://www.npmjs.com/package/opencode-usage-insights)

OpenCode TUI plugin. Shows one telemetry line above the composer after every
turn — response end time, the gap since the previous prompt, the provider (and
the upstream operator when it can be observed), turn and session token totals,
plus cache and provider-change warnings. The same plugin records every
assistant step into a local SQLite database and reads it back in a `/usage`
panel, so you can answer questions the host cannot: which inference operator is
actually serving a model, where the prompt cache was lost, how latency moves
over a period, what each session cost.

Everything is local: one SQLite file under the OpenCode state directory, read by
the TUI and written by the server-side recorder.

```text
14:32:07 · Δ 3m12s · orcarouter-dsv4.1flash · in 85.4k (1.62M), cached 1.53M, out 3.7k · sess in 2.1M (14.5M), cached 12.4M, out 88k · ⚠ cache expired (−11.7k)
```

See [docs/demo.md](docs/demo.md) for the full output of every view, generated
from a seeded database.

## What it does

- **Telemetry line** in `session.composer.top` after each response: end time,
  `Δ` since the previous prompt in the same session, the **gateway endpoint that
  served the turn** (`orcarouter-dsv4.1flash`) when a recorder learned one —
  falling back to `provider/model` (with the variant as a trailing word and
  `(via <operator>)`), and switchable with `identity: "model"` — turn tokens
  (`in`, `cached`, `out`) — the whole prompt, its cached part, and everything
  generated — plus session totals and warnings. The line belongs to a finished
  turn: while the session is running one it stays hidden — the host publishes
  that state from its execution events — so it never shows the zeroes of a
  request in flight, nor a line between the steps of a tool-call loop.
- **Warnings in the theme's warning color:** `⚠ cache expired (−11.7k)` when the
  prompt cache read drops against a comparable previous step, and `changed` when
  the displayed identity (endpoint, or provider in `model` mode) differs from the
  previous prompt — the same provider and model can be routed to a different
  endpoint per request, so that is what the line watches. Both are informed by
  OpenCode's own `turn-usage` heuristic: only identical model/variant pairs are
  compared, only finished steps count, and OpenAI's small
  (1024–2048 token) cache reads are treated as endpoint noise.
- **Persistent statistics** (server entry): every assistant step is recorded
  with tokens, cost, timings (time to first chunk, wall time, throughput),
  finish reason, raw `providerState`, session/parent ids and the upstream
  operator. Prompts, session lifecycle and compaction events are recorded too.
- **`/usage` panel** (TUI entry): six views — `overview`, `models`, `turns`,
  `cache`, `latency`, `sessions` — over five ranges — `session`, `today`, `7d`,
  `30d`, `all`. `/usage models 7d`, `/usage turns`, `/usage cache`,
  `/usage latency today`. The slash
  name is `usage` on purpose: OpenCode has its own `/stats` (its "Usage
  statistics" page and the `opencode stats` CLI), and this plugin must not
  shadow it.
- **Provider per model, including upstream operators.** The `models` view lists
  every model with each provider that served it, how many steps, tokens and
  cost — and the upstream operators observed behind that provider.
- **Portable data.** Export the whole database as NDJSON
  (`bun run report --ndjson`) and merge it back on another machine
  (`bun run report --import <file>`).
- **Observational by design.** The plugin never rewrites prompts, requests or
  responses, and a failure inside the recorder is swallowed: telemetry can never
  interrupt a session.

## Requirements

- **OpenCode V2.** The V2 release changed the plugin API (slots, panels, event
  stream); this plugin targets `>=2.0.0`.
- [Bun](https://bun.sh) to install dependencies (dev only).

## Install

```sh
opencode plugin add opencode-usage-insights
```

Or add the package to `~/.config/opencode/opencode.jsonc` (server entry) and
`~/.config/opencode/cli.json` (TUI entry):

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-usage-insights"]
}
```

```jsonc
// ~/.config/opencode/cli.json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-usage-insights"]
}
```

To pass [options](#configuration), use the object form:

```jsonc
{
  "plugins": [
    { "package": "opencode-usage-insights", "options": { "captureHeaders": true } }
  ]
}
```

Or register a local checkout. V2 resolves a local *directory* plugin through its
entry files, so pointing at `src/` loads the server recorder (`src/index.ts`)
and the TUI contributions (`src/tui.tsx`) from source:

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": [{ "package": "/home/you/code/projects/opencode-usage-insights/src" }] }
```

```jsonc
// ~/.config/opencode/cli.json
{ "plugins": [{ "package": "/home/you/code/projects/opencode-usage-insights/src" }] }
```

Restart OpenCode after changing the configuration.

Verify: send a prompt, and a telemetry line appears above the composer when the
response finishes. Run `/usage` (alias `/insights`) to open the panel.

## The line

```text
14:32:07 · Δ 3m12s · orcarouter-dsv4.1flash · in 85.4k (1.62M), cached 1.53M, out 3.7k · sess in 2.1M (14.5M), cached 12.4M, out 88k · ⚠ cache expired (−11.7k)
```

| Segment | Meaning |
| --- | --- |
| `14:32:07` | When the response ended (`completed`, else `streamed`, else `created`). |
| `Δ 3m12s` | Time since the previous prompt of the same session. |
| `orcarouter-dsv4.1flash` | The gateway endpoint that served the turn, when a recorder learned one (`identity: "endpoint"`, the default). Without one the segment falls back to `providerID/modelID`, with the variant as a trailing word (`… flash-free max`) and `(via <operator>)` as before; `identity: "model"` always shows that form. Yellow with `changed` when it differs from the previous prompt. |
| `(via fireworks)` | The upstream inference operator, when the recorder observed one. Hidden with `upstream: false`. |
| `in 85.4k (1.62M), cached 1.53M, out 3.7k` | `in` is the uncached part of the prompt (fresh input + cache writes), the parenthesised value the whole prompt — shown only when the two differ — `cached` its cached part, and `out` everything the model generated (visible output + reasoning). OpenCode's own debug line reconciles with these: `new = in + out` and `total = (in + cached) + out`. With several steps the segment reads `turn 3 steps · …` and, by default, reports the step the turn ended with (`latest`) instead of adding the same re-sent prompt once per step; `turnTotals: "sum"` gives that billing view. |
| `sess in 2.1M (14.5M), cached 12.4M, out 88k` | The session totals reported by the host, displayed with the same buckets as the turn. |
| `⚠ cache expired (−11.7k)` | Yellow. The prompt cache read fell by that many tokens against a comparable previous step. `×N` when several steps in the turn lost cache. |

The turn segment carries no label by default — the numbers are the turn's, and `sess` marks the session's. `labels.turn` (e.g. `"turn"`) brings a prefix back.

The panel (`/usage`) is a usage view instead: it sums the stored per-step buckets (`input` is the fresh prompt part only) across the selected range, and its header says how many steps that covers.

A turn is every consecutive assistant step after a prompt. Compaction, shell,
`idle` and info messages do not split a turn; `user`, `synthetic` and `system`
messages do. The line belongs to finished work: it stays hidden while the
session is running a turn and while the newest step has no final numbers, and
steps without final numbers are ignored when the cache drop is measured.
`bun run demo` prints one example per case, including the streaming one and both
turn-total views.

## The panel

`/usage [view] [range]` opens the panel (`/usage` alone opens `overview` over
`all`), and the panel header always lists the available views and ranges. While
the panel is open it owns input, so the prompt cannot take the command again:
`escape` closes it, `f` toggles full screen, and the palette entry (`ctrl+p` →
"Usage insights") toggles it closed. With the composer focused, `/usage` with no
arguments also toggles it closed, and any argument — including an unknown token,
which is ignored — keeps it open. There is no default key binding — the command
is palette-only, so it never shadows a key you use. OpenCode's own `/stats` (its
"Usage statistics" page, the same data as `opencode stats` in a terminal) is
left untouched.

```text
/usage models 7d
model                          provider                steps        in    cached       out      cost
deepseek-v4.1-flash-free       opencode                    4      124k     3.86M     13.3k   $0.5200
                               via fireworks, deepseek
glm-5.3-flash                  opencode                    2    104.7k    632.4k      9.9k   $0.7600
claude-opus-4.6                anthropic via bedrock       1     12.8k       96k      2.4k     $1.42
```

| View | Answers |
| --- | --- |
| `turns` | The per-prompt history: one line per finished turn, rendered exactly like the live line (end time, Δ, endpoint, `in (prompt)`, cached, out, warnings), newest first. A turn that is still running is left out. |
| `overview` | Steps, sessions, prompts, tokens, cache hit ratio, cost for the range — plus a `this session` block. |
| `models` | Every model, every provider that served it, the upstream operators observed per provider, and per-provider steps/tokens/cost. When the operator list does not fit the column, it continues on its own indented line instead of being truncated away. |
| `cache` | Reuse losses grouped by reason (`expired`, `compaction`, `unknown`), observed cache TTL bounds per provider/model (`hits up to` / `drops from`), and the most recent losses with their idle gap. |
| `latency` | Wall time (request to completed step), streaming window (request to the last streamed chunk) and throughput (`output + reasoning` tokens per streaming second) as p50/p90/p99. |
| `sessions` | Each session with the providers it used, steps, tokens and cost. |

### Per-prompt history

Two places keep the history visible, both built from the same database and the
same formatter as the live line:

- **`/usage turns [range]`** — the panel view, one line per finished turn.
- **The session sidebar** (`sidebar.content`) — the last `sidebarTurns` turns,
  two compact lines each (`09:24 orcarouter-dsv4.1flash` and
  `in 10.3k (1.62M) · out 1.25k`). It needs the sidebar visible
  (`session.sidebar` in `cli.json`); while it is hidden the contribution is
  simply invisible. `sidebar: false` turns it off.

A plugin cannot write into the conversation itself: the TUI API has no
transcript contribution, and the host's own per-turn line (`+ Tokens: …`, shown
with `debug.turn_tokens`) is synthesized inside the host. Writing to the terminal
scrollback is not an option either — `renderer.writeToScrollback` only works in
`split-footer` screen mode, and the TUI runs in `alternate-screen` by default.
The panel view and the sidebar are the supported way to keep a per-prompt record.

## Configuration

Options apply to both entries (each side reads the ones it needs):

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` disables that side completely — no line, no panel, no recording. |
| `db` | per-OS state path | SQLite path override. Must match between the server and TUI entries. |
| `captureHeaders` | `false` | Record the redacted response headers that upstream discovery inspects, as evidence. |
| `upstream` | `true` | Show the upstream operator on the line. |
| `turnTotals` | `"latest"` | How the turn segment counts prompt usage: `latest` shows the prompt size the turn ended with; `sum` adds every step of the turn. |
| `sidebar` | `true` | Show the per-prompt history in the session sidebar (the slot is invisible while the sidebar is hidden). |
| `sidebarTurns` | `5` | How many turns the sidebar history shows. |
| `panel` | `true` | Show the `/usage` statistics panel and its command. `false` keeps the line and the sidebar. |
| `identity` | `"endpoint"` | Which identity the line leads with: `endpoint` shows the gateway endpoint that served the turn (falling back to `provider/model`); `model` always shows `provider/model#variant` with the operator. |
| `fields` | see below | Toggle line segments. |
| `labels` | see below | Override line labels (the plugin is English-only by default). |

### Fields and labels

```jsonc
{
  "options": {
    "fields": { "clock": true, "delta": true, "model": true, "variant": true, "turn": true, "session": true, "reasoning": false, "cost": false, "cacheExpiry": true, "upstream": true },
    "turnTotals": "latest",
    "labels": { "delta": "Δ", "turn": "", "session": "sess", "step": "step", "steps": "steps", "input": "in", "cached": "cached", "output": "out", "cacheExpired": "cache expired", "providerChanged": "changed", "upstream": "via" }
  }
}
```

`fields: { "clock": false, "delta": false, "session": false }` turns the line
into a pure `provider/model · turn …` reading.

## Database

The recorder writes to the per-user state directory:

| OS | Path |
| --- | --- |
| Linux / other | `$XDG_STATE_HOME/opencode/stats/stats.db` (default `~/.local/state/opencode/stats/stats.db`) |
| macOS | `~/Library/Application Support/opencode/stats/stats.db` |
| Windows | `%LOCALAPPDATA%\opencode\stats\stats.db` |

```sh
OPENCODE_USAGE_INSIGHTS_DB=/path/to/stats.db   # environment override
```

The database is opened with `journal_mode = WAL`, so the TUI process (reader)
and the server process (writer) never block each other. Every write is an
upsert keyed by message id, which makes recording idempotent: replayed events,
restarts and re-imports never duplicate rows.

Tables: `sessions`, `prompts`, `steps`, `events`, `http_responses` (only used
with `captureHeaders: true`). The `steps` table is the interesting one:
`message_id` (primary key), `session_id`, `parent_id`, provider/model/variant,
input/output/reasoning/cache-read/cache-write tokens, cost, `created_at`,
`streamed_at`, `completed_at`, `finish`, `provider_state`, `upstream`,
`upstream_source`, `upstream_model`, `router`, `tps`, `recorded_at`.

`tps` is the step's tokens per second — everything the model generated
(`output + reasoning`) over the streaming window (`created → streamed`) —
recorded for analysis (SQL, exports); no view shows it as a column, the
`latency` view computes the same value from the timings and reports its
p50/p90/p99. The window is the streaming one on purpose: `streamed` marks the end
of streaming, and `completed` the end of the step, which for a tool-call step
happens after the tool calls were handled. It is `NULL` when that window or the
produced tokens are unknown, and existing rows are backfilled from their timings
when the column is added.

### How the upstream operator is found

OpenCode reports the provider it routes through (`providerID`), not necessarily
the operator that runs the inference. With a gateway (`opencode`, OpenRouter,
Vercel AI Gateway) that operator is chosen per request, and the gateway names it
in its own response headers — for example:

```text
x-opencode-upstream-model-id: deepseek/deepseek-v4.1-flash
x-opencode-endpoint-id: orcarouter-dsv4.1flash
server: cloudflare
```

Sources, in the order the recorder tries them:

1. **Gateway response headers** (`header:<name>`): `x-opencode-upstream-model-id`,
   `x-served-by`, `x-upstream*`, `x-inference-*`, `x-model-served-by`,
   `x-litellm-*`, `x-portkey-*`. A value may be `operator`, `operator/model` or a
   bare model id; the operator part is normalized (`deepseek` → DeepSeek) and the
   whole value is kept as `upstream_model`.
2. **The endpoint the request went to** (`endpoint:<host>`): a per-operator
   provider keeps its operator in the host (`api.fireworks.ai` → Fireworks,
   `bedrock-runtime.<region>.amazonaws.com` → AWS Bedrock).
3. **The provider package** in the model catalogue
   (`package:@opencode/ai/providers/fireworks` → Fireworks).
4. **Compaction provenance** (`provenance`), when the host recorded a route.

Infrastructure headers (`server`, `via`, `cf-ray`) name the CDN in front of the
gateway — `server: cloudflare` is the CDN, never the operator. They are stored as
evidence but never classified. Values that name a gateway (`opencode`,
`orcarouter`, `openrouter`, `vercel`) become `router` (`x-opencode-endpoint-id`
lands there too), and unrecognized values are kept as the upstream model id, not
as an operator: the plugin never guesses. A router is *not* an operator — it is
the path the request took, not the platform that ran the model. OrcaRouter, for
example, describes itself as an OpenAI-compatible endpoint in front of a whole
catalogue, billing at the provider's rate with zero markup; a response routed
through it reports `deepseek/deepseek-v4.1-flash` as the upstream model, whose
prefix names the provider, and `orcarouter-dsv4.1flash` as the endpoint.
`upstream_source` tells you where a value came from, and the raw `provider_state`
of every step is stored as evidence even when it does not name an operator. The
`models` panel view shows the operator, the upstream model and the routing
endpoint per provider.

## CLI report

The database can be read from a terminal without opening the TUI:

```sh
bun run report                          # overview over all time
bun run report models 7d                # one view, one range
bun run report all                      # every view
bun run report --json                   # raw query rows for scripting
bun run report --ndjson > backup.jsonl  # export the whole database
bun run report --import backup.jsonl    # merge an export (idempotent)
bun run report --help
```

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # pure logic + database + TUI plugin harness + render smoke tests
bun run build       # dist/index.js, dist/tui.js and declarations
bun run demo        # render the line and every view from a seeded database
```

- `src/core.ts` — pure turn accounting: transcript segmentation, token
  totals, prompt gaps, the cache-drop heuristic, line formatting. No host
  imports.
- `src/line.ts` — adapter from the host message shapes to the pure types, and
  the line parts the TUI renders.
- `src/stats/` — `db.ts` (schema, upserts, NDJSON export/import), `queries.ts`
  (overview, models, cache, latency, sessions), `paths.ts` (per-OS paths).
- `src/upstream.ts` — header allowlist, operator normalization.
- `src/recorder.ts` — the event-stream state machine that fills the database.
- `src/panel-data.ts` — the panel view models as plain text lines, so every
  view is unit-testable without a renderer.
- `src/index.ts` — the server entry (`Plugin.define` id `usage-insights`).
- `src/tui.tsx` — the TUI entry: line slot, panel slot, `/usage` command.
- `scripts/build.ts` — two-entry `Bun.build` (server + TUI) with
  `@opencode/*`, `@opentui/*` and `solid-js` external, then `tsc`
  declarations. npm `exports` point at `dist`, never at `src` (the Solid
  transform does not run inside `node_modules`).
- `scripts/demo.ts`, `scripts/report.ts` — the demo and report CLIs.

### Testing the TUI side

`bun test` runs through `bunfig.toml`, which preloads `test/preload.ts`. Bun
resolves the bare `solid-js` specifier to the package's server build, where
signals do not track and render effects run once; the host resolves the client
build (the one `@opentui/solid` uses internally). The preload points the
specifier at the client build so the harness, the plugin and the renderer share
one instance — otherwise every re-render assertion would pass vacuously.

Two consequences for render tests:

- The headless renderer paints a single frame, so assertions read the
  **renderable tree** (`treeText` in `test/plugin.test.ts`) after an update
  rather than the frame buffer.
- A render test must **drive an update** and check that the output was replaced,
  not appended. The line regressed once exactly that way: a `StyledText` passed
  as a child of `<text>` is appended as chunks that are never removed, so each
  reactive update added another full copy of the line. `bun run demo` shows the
  same cases as plain text.

## Pre-release checklist

```sh
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

Inspect the pack list (`dist/`, `README.md`, `LICENSE` only). Scan for secrets
before `npm publish`.

## License

MIT — see [LICENSE](./LICENSE). Author: Hugo Batista
(<https://github.com/hugobatista>).
