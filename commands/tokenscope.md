---
description: Show native OpenCode token and cost usage (CLI)
---

Native OpenCode exposes usage and cost statistics through the CLI, not through an in-session tool.
There is no `tokenscope` or `context_usage` tool in this setup. Do not invent tool calls or
per-tool token counts.

Tell the user to run this in a terminal:

    opencode stats [--days N] [--tools N] [--models [N]] [--project ""]

Notes:

- Omit `--days` for all time.
- `--tools N` limits the tool breakdown.
- `--models` optionally adds model statistics.
- `--project ""` filters to the current project.

Do not install tokenizer or telemetry dependencies to reconstruct the removed command.
