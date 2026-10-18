# Internals

How the plugin works under the hood: the local database, where the identity of a
step comes from, the rules the hot paths keep, and how the TUI side is tested.
The [README](../README.md) covers what a user sees; this file covers why it
behaves the way it does.

## Database

The recorder writes to the per-user state directory of the current OS:

| OS | Path |
| --- | --- |
| Linux / other | `$XDG_STATE_HOME/opencode/opencode-usage-insights/usage.db` (default `~/.local/state/opencode/opencode-usage-insights/usage.db`) |
| macOS | `~/Library/Application Support/opencode/opencode-usage-insights/usage.db` |
| Windows | `%LOCALAPPDATA%\opencode\opencode-usage-insights\usage.db` |

`OPENCODE_USAGE_INSIGHTS_DB=/path/to/usage.db` overrides the path, and the
`db` option overrides both. The database is opened with `journal_mode = WAL`, so
the TUI process (reader) and the server process (writer) never block each other.
Every write is an upsert keyed by message id, which makes recording idempotent:
replayed events, restarts and re-imports never duplicate rows.

Tables: `sessions`, `prompts`, `steps`, `events` and `meta` (the schema
version). The `steps` table is the interesting one: `message_id` (primary key),
`session_id`, `parent_id`, provider/model/variant, input/output/reasoning and
cache-read/cache-write tokens, cost, `created_at`, `streamed_at`,
`completed_at`, `finish` and `recorded_at`.

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

## The identity of a step

Every view groups a step by one thing: the **provider the model ran through**,
as OpenCode is configured (`provider_id` in the table, `opencode`,
`opencode-go`, `deepseek`, …), and the model itself.

That is the whole answer available, and it is deliberate. For a while the plugin
also recorded the *routing endpoint* a gateway named in a response header
(`x-opencode-endpoint-id`), which said which downstream operator actually ran the
inference behind a gateway. The Zen routes stopped publishing it — the header
came from a legacy handler that was removed when the routes became a thin
forwarding proxy ([anomalyco/opencode#54563](https://github.com/anomalyco/opencode/pull/54563))
— and no other source names that upstream: the response body of a routed request
is provider-neutral, the request host is the gateway, and the host binary
contains no reference to the header. So there is nothing left to discover, and
nothing is inferred in its place.

What the recorder writes is what the event stream carries. `recordStep` takes
the provider from the step's own model reference (or, for a step that started
before the plugin loaded, from the last model the session selected), and
validates it as a single token (letters, digits, `. _ : / -`, at most 64
characters) before it becomes a grouping key: a value that is not a provider id
is stored as absent rather than splitting the views on a typo. Case is left
alone — the provider reads the way it is configured.

Two consequences are load-bearing in the analysis layer:

- **A provider switch forfeits the cache.** The prompt cache belongs to the
  provider that holds it, so `cacheDrop` — the rule shared with the live line —
  takes a scope. The switch and loss reports measure a drop across a provider
  switch (`"model"`: the model is the same, so the two steps share a cache to
  lose), while the survival report and the TTL evidence keep the strict
  `"provider"` scope: two providers are two caches, and a switch between them is
  not an idle-gap sample.
- **A model that ran through two providers is one model with two rows.** The
  `models` view keeps the family together and names the providers in a column;
  the `providers` view leads with the provider and lists the models it served.

## What the line counts

The line has two totals groups — the turn and the session — and they follow
different rules on purpose:

- **Tokens follow the view.** `turnTotals: "latest"` (the default) reports the
  prompt the turn ended with: summing `input`/`cached` over the steps of a
  tool-call loop would count the same re-sent prompt once per step, which is not
  what a context view means. `"sum"` adds every step instead, which is the
  billing view of the tokens.
- **Money is always summed.** Every step of a turn is paid for, so the turn's
  cost is the sum over its steps whatever the token view shows (`totalsText`
  takes the cost explicitly for that reason, never the `latest` step's share).
  The session's cost is the one the host reports for the session.
- **A zero cost is left out.** A free model reads as free instead of repeating
  `$0`; `fields.cost: false` hides the segment entirely for a narrower line.
- **Switches the line warns about are between turns.** A provider change against
  the previous prompt is `changed`, a model change inside one provider is
  `model changed`; the same comparison between *steps* is what the `models`
  view's detail line counts.

## Privacy and security

The plugin is local by construction: no network client, no subprocess, no
credentials, no telemetry. Everything it records stays in the SQLite file in the
user's own state directory.

**What is stored.** Per step: timings, token counts and cost, the
provider/model/variant it ran as, the finish reason, the session and parent ids,
and the session's title and working directory as the host reports them.
**Prompts and responses are not stored**: the recorder reads event payloads for
numbers and identifiers and keeps nothing else — no message text, no tool
arguments, no file contents, no environment variables.

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
  provider id the host reports, a session title, an imported NDJSON dump — is
  validated as an identifier token or stripped of control characters and capped
  in length, both when it is stored and again when it is rendered. A terminal
  escape sequence in a title cannot reach the terminal, and a dump cannot import
  a value that does not fit its column.
- **Parameterized SQL everywhere**, and no dynamic table or column names taken
  from data.

## Performance

The plugin sits on paths the host waits for: the recorder's event handlers and
the composer line. The rules it keeps are:

- **Writes are small and rare.** A step is one upsert, written when it ends;
  nothing is written on a response, because the response carries nothing the
  views read.
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
