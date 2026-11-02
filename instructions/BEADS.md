# Beads

Beads issue tracking is available through the existing skills:

- `beads-br` — create, inspect, update, dependency, and close operations with `br`
- `beads-bv` — triage, prioritization, blocker analysis, and graph-aware planning with `bv`

Load a skill only when the task actually needs it. Do not inject the full command reference or paste long command blocks into the conversation.

On Windows only, `br` requires `--no-db --no-auto-flush`. `bv` uses only `--robot-*` commands and never takes `--no-db`. On other platforms, use the normal DB-backed commands unless the project documents otherwise.
