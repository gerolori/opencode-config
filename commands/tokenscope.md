---
description: Show native OpenCode usage statistics (CLI)
---

OpenCode 2.2.5 exposes usage through the native CLI, not through an in-session token tool.
There is no `tokenscope` or `context_usage` tool in this setup. Do not invent tool calls or
per-tool in-session token counts.

Tell the user to run one of these in a terminal:

    opencode stats --days 7
    opencode stats --cost --models --tools --limit 20
    opencode stats --json

Supported 2.2.5 flags: `--days`, `--year`, `--all`, `--project`, `--models`, `--tools`,
`--cost`, `--full`, `--limit`, `--json`.

Notes:

- `--days 0` means today.
- `--all` shows lifetime statistics.
- `--project "."` filters to the current project.
- `--cost` adds cost and token details; `--models` and `--tools` add their sections.

`opencode stats` reports shareable usage statistics, not vendor billing. Do not install
tokenizer or telemetry dependencies to reconstruct the removed command.
