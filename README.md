# opencode-usage-insights

[![GitHub Tag](https://img.shields.io/github/v/tag/hugobatista/opencode-usage-insights?logo=github&label=latest)](https://github.com/hugobatista/opencode-usage-insights/releases)
[![Test](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-usage-insights/test.yml?label=Test)](https://github.com/hugobatista/opencode-usage-insights/actions/workflows/test.yml)
[![Lint](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-usage-insights/lint.yml?label=Lint)](https://github.com/hugobatista/opencode-usage-insights/actions/workflows/lint.yml)
[![npm](https://img.shields.io/npm/v/opencode-usage-insights.svg)](https://www.npmjs.com/package/opencode-usage-insights)

OpenCode TUI plugin. Shows one telemetry line above the composer after every
turn — response end time, the gap since the previous prompt, the **endpoint that
served it**, turn and session token totals, plus cache and endpoint-change
warnings. The same plugin records every assistant step into a local SQLite
database and reads it back in an interactive `/usage` panel, so you can answer
questions the host cannot: which endpoint is really serving a model, where the
prompt cache was lost, how latency and cost move over a period, and what each
session used.

Everything is local: one SQLite file under the OpenCode state directory, read by
the TUI and written by the server-side recorder.

```text
14:32:07 · Δ 3m12s · orcarouter-dsv4.1flash · in 85.4k (1.62M), cached 1.53M, out 3.7k · sess in 2.1M (14.5M), cached 12.4M, out 88k · ⚠ cache expired (−11.7k)
```

See [docs/demo.md](docs/demo.md) for the full output of every view, generated
from a seeded database.

## What it does

- **Telemetry line** in `session.composer.top` after each response: end time,
  `Δ` since the previous prompt in the same session, the **endpoint that served
  the turn** (`orcarouter-dsv4.1flash`) when a recorder learned one — falling
  back to `provider/model` (with the variant as a trailing word), and switchable
  with `identity: "model"` — turn tokens
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
  finish reason, the provider/model it ran as, the session and parent ids, and
  the endpoint that served the request. Prompts, session lifecycle and
  compaction events are recorded too.
- **`/usage` panel** (TUI entry): nine keyboard-driven views — `overview`,
  `models`, `endpoints`, `affinity`, `cache`, `periods`, `latency`, `sessions`,
  `turns` — over five ranges — `session`, `today`, `7d`, `30d`, `all`, plus a
  `db` view that shows where the file lives and lets a retention be pruned or
  the file compacted. A cursor
  walks the rows, `enter` drills into one, and view, range, sort, bucket and
  filters are remembered between openings. `/usage models 7d`,
  `/usage affinity`, `/usage endpoints 30d`. The slash name is `usage` on purpose:
  OpenCode has its own `/stats` (its "Usage statistics" page and the
  `opencode stats` CLI), and this plugin must not shadow it.
- **Which endpoint actually served each model.** The `endpoints` view gives one
  row per endpoint with the models, steps, share, tokens, cache reuse, throughput
  and cost of everything it served — and `affinity` counts how often a step's
  model or endpoint changed mid-session, with the cache it cost.
- **Cache and periods.** `cache` reports the token-weighted hit, the per-step
  median, the losses by reason, how long an idle gap the prompt cache survives
  and the observed TTL bounds; `periods` totals every day, week or month with a
  sparkline.
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

### Supported systems

| | |
| --- | --- |
| **OS** | Linux, macOS and Windows. The database lives in the per-user state directory of each (table below). CI runs the data layer — paths, database, recorder, queries, panel assembly, dump round-trip, file permissions — on all three, and the whole suite (including the TUI render tests, which need OpenTUI's native stack) on Linux. `bun run check:platform` runs that same cross-platform check by hand. |
| **Runtime** | Bun, the runtime OpenCode ships with. SQLite comes from `bun:sqlite`: there is no native module to build and nothing to compile on install. |
| **OpenCode** | V2 (`>=2.0.0`). |

## Install

> **Not on the npm registry yet.** Until the first release is published,
> `opencode plugin add` and the package-name form below cannot resolve it — use
> the local checkout, the last form of this section.

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
    { "package": "opencode-usage-insights", "options": { "identity": "endpoint" } }
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
| `orcarouter-dsv4.1flash` | The endpoint that served the turn, when the recorder learned one (`identity: "endpoint"`, the default): the gateway names it in a response header, or the host of the request names the operator. Without one the segment falls back to `providerID/modelID`, with the variant as a trailing word (`… flash-free max`); `identity: "model"` always shows that form. Yellow with `changed` when it differs from the previous prompt. |
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

`/usage [view] [range]` opens the panel (`/usage` alone opens the last view, or
`overview` over `all` the first time). While the panel is open it owns input, so
the prompt cannot take the command again: `escape` closes it, `f` toggles full
screen, and the palette entry (`ctrl+p` → "Usage insights") toggles it closed.
With the composer focused, `/usage` with no arguments also toggles it closed,
and any argument — including an unknown token, which is ignored — keeps it open.
There is no default key binding — the command is palette-only, so it never
shadows a key you use. OpenCode's own `/stats` (its "Usage statistics" page, the
same data as `opencode stats` in a terminal) is left untouched.

### Keys

The view bar at the top names every view and brackets the active one; `?` opens
a help overlay that repeats the keys and defines every number.

| Key | Does |
| --- | --- |
| `↑` `↓` / `j` `k` | Move the cursor; the row under it is highlighted. |
| `enter` | Drill into the row: a model → the endpoints that served it and its affinity; an endpoint → the models it served and its latency; a session → its turns; a period → the endpoints that were active. |
| `backspace` | Go back from a drill-down. |
| `1`–`9` / `[` `]` | Pick a view / cycle views. |
| `t` / `shift+t` | Next / previous range. |
| `s` / `shift+s` | Cycle the sort column / reverse it. |
| `b` | `periods` bucket: day → week → month. |
| `a` | `turns` scope: this session ↔ every session. |
| `m` `e` | Filter by model or by **endpoint** (a picker of the values actually observed). |
| `x` | Clear the filters. |
| `r` | Re-read the database. |
| `?` | Help overlay. |
| `f` / `escape` | Full screen / close. |

The view, range, sort, bucket, scope and filters are stored through the host's
durable storage, so the panel reopens where it was left.

### Views

```text
/usage endpoints
endpoint                        models  steps  share     prompt     cached     hit  tps p50     wall
orcarouter-claude                    1      1    14%     119.8k        96k   80.1% 1178.6/s    1m14s
– (never observed)                   1      2    29%     754.1k     632.4k   83.9% 3000.0/s    58.0s
orcarouter-dsv4.1-flash…             1      4    57%         4M      3.86M   96.5% 2625.0/s    31.0s
```

| View | Answers |
| --- | --- |
| `overview` | Steps, sessions, prompts, `in`/`cached`/`write`/`out`, `hit`, cost, an activity sparkline, a `this session` block and a **data coverage** block (how many steps lack a model, an endpoint or a completion — a zero elsewhere is only trustworthy when this is complete). |
| `models` | Every model with its cache (`hit` and the per-step `hit p50`), tokens, cost, the **endpoints that actually served it** and how often its identity changed. `enter` opens the per-endpoint detail. |
| `endpoints` | **Who served the work**: one row per routing endpoint, with the models it served, steps, share, prompt, cached, `hit`, p50 throughput, wall time and cost. `enter` lists every model it served. A request whose endpoint was never observed is dimmed — the panel does not invent an identity. |
| `affinity` | How often the step's identity changed against the step before it in the same session — by provider, model and endpoint — the cache those changes cost, and the most frequent transitions. |
| `cache` | Reuse by model, losses grouped by reason (`expired`, `compaction`, `unknown`), **cache survival against idle time** (per gap bucket: pairs, kept, drops, tokens lost), reuse kept per endpoint, the observed TTL bounds (`hits up to` / `drops from`) and the most recent losses. |
| `periods` | Day, week or month totals — steps, sessions, `in`, `cached`, `write`, `hit`, `out`, cost — with a sparkline per metric and a totals row. `enter` lists the models of a period. |
| `latency` | Wall time, streaming window and throughput as p50/p90/p99 overall and per model (per endpoint when a model is filtered). `n < 5` is dimmed. |
| `sessions` | Each session with steps, prompts, tokens, `hit`, cost, its directory and how many models it used; subagent sessions are indented under their parent and rolled up. |
| `turns` | The per-prompt history: one line per finished turn, rendered exactly like the live line (end time, Δ, endpoint, `in (prompt)`, cached, out, warnings). `a` widens it to every session, titled. |

### Metrics

The panel uses the live line's own buckets, so a number read in one place means
the same in the other:

| Name | Meaning |
| --- | --- |
| `prompt` | Everything the provider saw: `cached + fresh + writes`. |
| `in` | The uncached part of it: fresh input **plus cache writes** (what the line calls `in`). |
| `cached` | Prompt read from the provider prompt cache. |
| `write` | Part of `in`: prompt written into that cache. |
| `hit` | `cached / prompt`, weighted over the selection. |
| `hit p50` | Median of the per-step hit — a few huge steps cannot hide a split pattern. |
| `out` | Everything generated: visible output **plus reasoning**. |
| `reasoning` | Part of `out`. |
| `tps` / `wall` / `stream` | Produced tokens per streaming second / request to completed step / request to the last chunk, reported as p50 (p90/p99 in `latency`). |
| `changed` | The step's model or endpoint differs from the step before it in the same session. |
| `gap` | Time between the previous step's completion and the next request. |

A change of identity is not by itself a fault — a gateway may re-route
deliberately — so `affinity` pairs the count with the cache reuse it actually
cost, using the same rule the live line uses.

The `session` range and the `this session` block mean exactly that session — not
every session recorded after it started, which for a parallel terminal or an
agent-heavy workflow is a different, much larger number. Subagent sessions are
sessions of their own: `overview` lists them apart and `sessions` rolls them up,
which is why neither total matches the line's `sess` segment on its own.

### The endpoint is the identity

The panel answers "who ran this inference" with one thing: the **endpoint**
(`router`) the request was actually sent to. The line leads with it, `models`
lists the endpoints behind each model, `endpoints` lists the models behind each
endpoint, and changes in it are what `affinity` counts.

The other candidate is recorded as evidence and never surfaced: the
**provider** (`providerID`) is the OpenCode provider you configured — it says
where the request came from, not who served it. It stays in the database
(`steps.provider_id`) and in `bun run report --json`, so nothing is lost, but it
does not compete with the endpoint on screen.

### Per-prompt history

Two places keep the history visible, both built from the same database and the
same formatter as the live line:

- **`/usage turns [range]`** — the panel view, one line per finished turn.
- **The session sidebar** (`sidebar.content`) — the session's accumulated usage
  first (`473 steps · $0.10`, `in 2.54M · cached 157.3M`,
  `out 356.6k · hit 98.4%`), then the last `sidebarTurns` turns, two compact
  lines each (`09:24 orcarouter-dsv4.1flash` and
  `in 10.3k (1.62M) · out 1.25k`). The summary is the session's own steps, with
  the same buckets as the line and the panel. It needs the sidebar visible
  (`session.sidebar` in `cli.json`); while it is hidden the contribution is
  simply invisible. `sidebar: false` turns the whole block off.

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
| `turnTotals` | `"latest"` | How the turn segment counts prompt usage: `latest` shows the prompt size the turn ended with; `sum` adds every step of the turn. |
| `sidebar` | `true` | Show the session summary and the per-prompt history in the session sidebar (the slot is invisible while the sidebar is hidden). |
| `sidebarTurns` | `5` | How many turns the sidebar history shows. |
| `panel` | `true` | Show the `/usage` statistics panel and its command. `false` keeps the line and the sidebar. |
| `identity` | `"endpoint"` | Which identity the line leads with: `endpoint` shows the endpoint that served the turn (falling back to `provider/model`); `model` always shows `provider/model#variant`. |
| `fields` | see below | Toggle line segments. |
| `labels` | see below | Override line labels (the plugin is English-only by default). |

### Fields and labels

```jsonc
{
  "options": {
    "fields": { "clock": true, "delta": true, "model": true, "variant": true, "turn": true, "session": true, "reasoning": false, "cost": false, "cacheExpiry": true },
    "turnTotals": "latest",
    "labels": { "delta": "Δ", "turn": "", "session": "sess", "step": "step", "steps": "steps", "input": "in", "cached": "cached", "output": "out", "reasoning": "reason", "cost": "cost", "cacheExpired": "cache expired", "providerChanged": "changed", "modelChanged": "model changed" }
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

Tables: `sessions`, `prompts`, `steps`, `events` and `meta` (the schema
version). The `steps` table is the interesting one: `message_id` (primary key),
`session_id`, `parent_id`, provider/model/variant, input/output/reasoning and
cache-read/cache-write tokens, cost, `created_at`, `streamed_at`,
`completed_at`, `finish`, `router` (the endpoint that served the request) and
`recorded_at`.

Throughput is not stored: `tps` is everything the model generated
(`output + reasoning`) over the streaming window (`created → streamed`), and the
`latency` view computes it from the timings and reports its p50/p90/p99. The
window is the streaming one on purpose — `streamed` marks the end of streaming
and `completed` the end of the step, which for a tool-call step happens after
the tool calls were handled — so a step whose window or produced tokens are
unknown has no throughput and is left out of the percentiles.

Two expression indexes carry every ranged view: `steps_at` on
`COALESCE(created_at, recorded_at)` (the step's own clock, falling back to the
recording time for a step that was already in flight when the plugin loaded)
and `steps_session_at` on the same expression scoped to a session, which is what
the per-prompt history and the sidebar read. Without them a range filter is a
full table scan on every panel rebuild.

The file is private to the user: its directory is created `0700` and the file
`0600` (POSIX), re-applied every time either is opened. The TUI reads through a
read-only connection — it can never write, never migrate and never hold the
writer's lock — and prune and compact use a separate short-lived writer with a
250 ms busy timeout, so maintenance fails fast with a message instead of
stalling the recorder.

### How the endpoint is found

OpenCode reports the provider it routes through (`providerID`) — where the
request came from, not who served it. The endpoint that actually served the
request comes from two sources, and the header wins:

1. **The gateway's own response header** (`x-opencode-endpoint-id`), as in
   `x-opencode-endpoint-id: orcarouter-dsv4.1flash`. The value has to be a single
   token (letters, digits, `. _ : / -`, at most 64 characters) and is folded to
   lowercase, so a gateway that changes the case between responses still reads
   as one endpoint.
2. **The host of the request URL**, when no header named one: gateway hosts
   (`opencode.ai` → `opencode`, `openrouter.ai` → `openrouter`,
   `ai-gateway.vercel.sh` → `vercel-ai-gateway`) and per-operator hosts
   (`api.fireworks.ai` → `fireworks`, `api.deepseek.com` → `deepseek`,
   `bedrock-runtime.us-east-1.amazonaws.com` → `bedrock`,
   `us-central1-aiplatform.googleapis.com` → `vertex`).

A host matches on a label boundary only: the domain itself, a subdomain of it
(`gateway.api.fireworks.ai`), or a region label joined to it by a dash
(`us-central1-aiplatform.googleapis.com`). A host that merely contains a known
domain — `api.anthropic.com.evil.tld` — names nothing, so a lookalike cannot
label the telemetry.

What the recorder learns is applied to the step in flight and to the steps of
the same session and model that were recorded without an endpoint, and it is
never overwritten once set: a re-route is not retroactive. A value that is not a
token — a sentence, a control character, a name a gateway invented — is not an
endpoint and is not stored. The operator a header *might* have mentioned is
deliberately not recorded: the plugin answers "who ran this inference" with the
endpoint alone, and `bun run report --json` still exposes the provider for
anyone auditing a route.

## Privacy and security

The plugin is local by construction: no network client, no subprocess, no
credentials, no telemetry. Everything it records stays in the SQLite file in the
user's own state directory.

**What is stored.** Per step: timings, token counts and cost, the
provider/model/variant it ran as, the endpoint label, the finish reason, the
session and parent ids, and the session's title and working directory as the
host reports them. **Prompts and responses are not stored**: the recorder reads
event payloads for numbers and identifiers and keeps nothing else — no message
text, no tool arguments, no file contents, no environment variables.

**What protects it.**

- **Private files.** The database directory is created `0700` and the file
  `0600` (POSIX), re-applied on every open; on Windows the file inherits the
  user profile's ACL.
- **A read-only reader.** The TUI opens the database read-only, so the panel and
  the sidebar can never write, migrate or take the recorder's lock. Prune and
  compact open a separate short-lived writer with a 250 ms busy timeout: a
  maintenance action that cannot take the lock tells the user and stops, instead
  of stalling the request pipeline that records usage.
- **Validated input.** Anything that reaches the database from outside — a
  gateway's endpoint header, a session title, an imported NDJSON dump — is
  validated as an identifier token or stripped of control characters and capped
  in length, both when it is stored and again when it is rendered. A terminal
  escape sequence in a response header cannot reach the terminal, and a dump
  cannot import a value that does not fit its column.
- **Parameterized SQL everywhere**, and no dynamic table or column names taken
  from data.

## CLI report

The database can be read from a terminal without opening the TUI:

```sh
bun run report                          # overview over all time
bun run report models 7d                # one view, one range
bun run report all                      # every view
bun run report endpoints --model deepseek-v4.1-flash-free
bun run report periods --granularity month
bun run report affinity --endpoint orcarouter-dsv4.1flash
bun run report --json                   # raw rows and every analysis, for scripting
bun run report --ndjson > backup.jsonl  # export the whole database
bun run report --import backup.jsonl    # merge an export (idempotent)
bun run report --help
```

The views come from the same `buildPanel` the TUI renders, so the terminal and
the panel never drift apart. `--width`, `--granularity`, `--model`,
`--endpoint`, `--sort` and `--asc` mirror what the panel's keys do.

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
  (the SQL aggregates: totals, models, sessions, turns, the per-prompt window,
  the timeline) and `aggregates.ts` (the analysis layer: coverage, latency
  percentiles, reuse medians, the endpoint breakdown, affinity, idle-gap
  survival, TTL bounds, reuse losses, calendar periods), `paths.ts` (per-OS
  paths, `~` expansion and the file-type check) and `maintenance.ts` (what the
  file holds, prune, vacuum).
- `src/endpoint.ts` — endpoint discovery: the gateway header, the known hosts
  (gateway and per-operator, matched on a label boundary) and the merge rule.
  Pure, so it is testable without a network stack.
- `src/text.ts` — text hygiene: control-character stripping, length caps and the
  identifier-token rule shared by the endpoint, the recorder and the renderers.
- `src/recorder.ts` — the event-stream state machine that fills the database.
- `src/panel-data.ts` — the panel view models as plain text lines, so every
  view is unit-testable without a renderer.
- `src/panel-build.ts` — the panel's data assembly: one request object in, the
  active view's lines out, shared by the panel and the CLI report.
- `src/panel.tsx` — the panel component: cursor, drill-down, keymap layer,
  filter pickers and the durable panel state.
- `src/index.ts` — the server entry (`Plugin.define` id `usage-insights`).
- `src/tui.tsx` — the TUI entry: line slot, panel slot, `/usage` command.
- `scripts/build.ts` — two-entry `Bun.build` (server + TUI) with
  `@opencode/*`, `@opentui/*` and `solid-js` external, then `tsc`
  declarations. npm `exports` point at `dist`, never at `src` (the Solid
  transform does not run inside `node_modules`).
- `scripts/demo.ts`, `scripts/report.ts` — the demo and report CLIs.
- `scripts/bench.ts` — the performance harness: builds a synthetic database of a
  given size and times the writes on the request path, every panel view and the
  line. `bun run bench` checks the budgets on 20k steps, `bun run bench --full`
  on 120k, `--explain` prints the query plans, and a read that stops using the
  indexes fails the run whatever the timing says.
- `scripts/check-platform.ts` — `bun run check:platform`: the data layer end to
  end on the current OS (paths, database, recorder, every panel view, prune,
  vacuum, dump round-trip, file permissions) against a throwaway database.

### Performance

The plugin sits on paths the host waits for: the recorder's event handlers, the
`http.response` hook (which the host awaits) and the composer line. The rules it
keeps are:

- **Writes are small and rare.** A step is one upsert; an endpoint is written
  once per session and model and only when it changed; a repeated observation
  costs a map lookup, not a statement.
- **Reads are index-driven.** Every range filter compares the expression the
  `steps_at` index covers, the per-prompt history is bounded to the last few
  prompts, and the line and the sidebar never scan a session's whole history.
- **The TUI reads, and reads at most 300 ms apart.** The panel and the sidebar
  share one read-only connection, a burst of step events is coalesced into one
  rebuild, and each view is memoised; the file's own numbers (`dbInfo`) are only
  asked for by the `db` view.
- **The panel's cost is the range it shows.** A view folds the steps of its
  range — in SQLite where the answer is a sum or a count, in JavaScript where it
  is a percentile or a comparison between consecutive steps. That is why the
  range is a first-class setting, why each view reads the rows once and shares
  them between its reports, and why the budgets in `scripts/bench.ts` are per
  view.

Two rules came out of measuring, and the bench enforces both:

- **Aggregate in SQL, fold in JS.** `overview` and the `sessions` and `turns`
  views are sums and counts: they never move a row into JavaScript
  (`coverageOf` is one SQL statement). Percentiles and pair comparisons read the
  four to sixteen columns they use and fold them in JS, because SQLite's window
  functions cost several times more per row than the projection does.
- **One read per report per view.** `test/panel-build.test.ts` counts the
  statements a view prepares, and fails if one view asks the database for the
  steps more than twice.

`bun run bench` is the check: it fails on a budget overrun or on a read that
stopped using an index.

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
bun test              # whole suite, Linux
bun run check:platform
bun run bench --full  # budgets at 120k steps
bun run build
npm pack --dry-run
```

Inspect the pack list (`dist/`, `README.md`, `LICENSE` only). Scan for secrets
before `npm publish`.

## License

MIT — see [LICENSE](./LICENSE). Author: Hugo Batista
(<https://github.com/hugobatista>).
