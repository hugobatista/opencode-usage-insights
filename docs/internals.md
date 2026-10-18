# Internals

How the plugin works under the hood: the local database, where the endpoint
identity comes from, the rules the hot paths keep, and how the TUI side is
tested. The [README](../README.md) covers what a user sees; this file covers
why it behaves the way it does.

## Database

The recorder writes to the per-user state directory of the current OS:

| OS | Path |
| --- | --- |
| Linux / other | `$XDG_STATE_HOME/opencode/stats/stats.db` (default `~/.local/state/opencode/stats/stats.db`) |
| macOS | `~/Library/Application Support/opencode/stats/stats.db` |
| Windows | `%LOCALAPPDATA%\opencode\stats\stats.db` |

`OPENCODE_USAGE_INSIGHTS_DB=/path/to/stats.db` overrides the path, and the
`db` option overrides both. The database is opened with `journal_mode = WAL`, so
the TUI process (reader) and the server process (writer) never block each other.
Every write is an upsert keyed by message id, which makes recording idempotent:
replayed events, restarts and re-imports never duplicate rows.

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

## How the endpoint is found

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
   `us-central1-aiplatform.googleapis.com` → `vertex`, and the rest of the list
   in `src/endpoint.ts`).

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

## Performance

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
stopped using an index. `bun run bench` checks the budgets on 20k steps,
`bun run bench --full` on 120k, and `--explain` prints the query plans.

## Testing the TUI side

`bun test` runs through `bunfig.toml`, which preloads `test/preload.ts`. Bun
resolves the bare `solid-js` specifier to the package's server build, where
signals do not track and render effects run once; the host resolves the client
build (the one `@opentui/solid` uses internally). The preload points the
specifier at the client build so the harness, the plugin and the renderer share
one instance — otherwise every re-render assertion would pass vacuously.
`scripts/screenshot.ts` does the same alignment before it loads the harness, so
the documentation images are rendered by the real components.

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
