# Contributing to opencode-usage-insights

Thank you for considering contributing to opencode-usage-insights! Before diving in, please read these guidelines carefully.

## Before You Write Any Code

**Open an issue first.** For anything beyond a small bug fix, typo, or documentation improvement, please open an issue and wait for a response before writing code. This can save you hours of work on something that won't be merged.

If an issue already exists, comment on it to signal your intent so work isn't duplicated.

## Pull Request Size

**Keep PRs small and focused on a single concern.**

- **Target under ~300 lines changed** (excluding lock files and generated code)
- **One PR = one thing.** Don't bundle a bug fix with a refactor with a new feature
- If your change is naturally large, break it into a chain of smaller PRs

PRs that are too large to review efficiently will be asked to be split.

## Prerequisites

- **Bun** (installed globally) — see [bun.sh](https://bun.sh)

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/opencode-usage-insights.git
   ```
3. **Create a branch** with a descriptive name:
   ```bash
   git checkout -b fix/description-of-fix
   # or
   git checkout -b feat/description-of-feature
   ```
4. Install dependencies:
   ```bash
   bun install
   ```
5. **Make your changes** and validate before pushing:
   ```bash
   bun run typecheck && bun test
   ```
6. **Push and open a PR** against the `main` branch, filling in the PR template completely.

## Ground Rules for This Plugin

- `src/core.ts`, `src/line.ts`, `src/panel-data.ts`, `src/stats/`,
  `src/endpoint.ts` and `src/text.ts` must stay free of host imports
  (`@opencode/*`, `@opentui/*`, `solid-js`) so they remain unit-testable
  without a TUI runtime.
- Every view or line change needs a test at the level it lives at: pure text for
  the view models, the shared harness (`test/harness.ts`) for slots, commands
  and the line, and a render test for anything that changes JSX.
- A render test must **drive a reactive update** and assert the new output
  (see `test/plugin.test.ts`): render-once smoke tests cannot catch content that
  is appended on every update. Assertions read the renderable tree (`treeText`),
  because the headless renderer paints a single frame. `test/preload.ts` (wired
  in `bunfig.toml`) resolves `solid-js` to the client build for the same reason;
  without it the tests would pass without any reactivity.
- A line or panel contribution is a *single* renderable filled through its
  `content` property. Passing a `StyledText` as a JSX child accumulates a copy
  of the content per update in the current OpenTUI build.
- Recording must stay observational: never rewrite prompts, requests or
  responses, and never let a telemetry failure surface as a session error.
- A database write must be idempotent (upsert by message id) — replayed events
  and restarts are normal.
- Report an endpoint only from evidence: a gateway's response header or the host
  of the request. Never guess an endpoint from the provider id.
- Changes that touch the queries, the panel assembly or the line should keep
  `bun run bench` green; changes to paths, the database or maintenance should
  keep `bun run check:platform` green. CI runs the suite on Linux, so run that
  check on macOS or Windows when you touch those.

## Response Time Expectations

Reviews may take a few days depending on availability. A PR sitting without a response is not a rejection. Please feel free to leave a polite ping after a week if there's been no activity.

## Thank You

Every contribution makes a real difference. Thank you for taking the time to improve opencode-usage-insights.
