---
name: 🐞 Bug report
about: Report a bug
title: "[BUG]: "
labels: [bug]
assignees: ''
---

## Checklist

- [ ] I have searched **existing issues** to make sure this bug hasn't already been reported.

## Description

Describe the bug you encountered.

## Steps to Reproduce

1. opencode-usage-insights version
2. Command you ran
3. See error

## Expected Behavior

What did you expect to happen?

## Screenshots, logs or files

If applicable, add screenshots, logs, or files to help explain your problem.

If the problem is about the numbers (tokens, cache, provider, upstream), please
include the output of:

```sh
bun run report --json
```

or the relevant rows from the database (`steps` table). Redact anything private.

## Additional Context

Add any other context about the problem here (OS, OpenCode version, provider and
model, `captureHeaders` setting, etc.).
