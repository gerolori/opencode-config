---
name: beads-bv
description: Use Beads Viewer robot commands for triage, planning, blocker analysis, and graph-aware prioritization.
compatibility: opencode
---
# Beads BV Workflow

Use this skill when interacting with `bv`, the graph-aware triage and analysis tool for Beads.

## Purpose

This skill defines the safe operating rules for `bv`.

`bv` is for:
- triage
- prioritization
- blocker analysis
- execution planning
- graph-aware insights
- project health and suggestion workflows

Use `br` instead for creating, updating, closing, or mutating issues.

## Critical rules

Use only `--robot-*` commands.

Never launch bare `bv`, because that opens an interactive TUI and can block the session.

Do not pass `--no-db` to `bv`.

That flag is for `br`, not `bv`.

## When to use

Use this skill when:
- you need project-wide triage
- you want the highest-impact next task
- you need a dependency-respecting execution plan
- you want blocker analysis
- you want priority or graph insights
- you want suggestions for missing dependencies, duplicates, or hygiene issues

Do not use this skill to mutate Beads state.

## Default entry point

Start with:

```bash
bv --robot-triage
```

This is the main recommendation workflow.

It typically returns:
- quick reference
- ranked recommendations
- blockers to clear
- quick wins
- project health
- suggested next commands

## Other useful commands

### Minimal next recommendation

```bash
bv --robot-next
```

### Dependency-respecting plan

```bash
bv --robot-plan
```

### Priority analysis

```bash
bv --robot-priority
```

### Graph and insight views

```bash
bv --robot-insights
bv --robot-graph
```

### Alerts and suggestions

```bash
bv --robot-alerts
bv --robot-suggest
```

### Historical diff

```bash
bv --robot-diff --diff-since <ref>
```

## Filtering and scoping

Examples:

```bash
bv --robot-plan --label backend
bv --robot-insights --as-of HEAD~30
bv --recipe actionable --robot-plan
bv --recipe high-impact --robot-triage
```

## sqz usage

If output should be compressed with `sqz`, use shell-appropriate env syntax.

PowerShell:

```powershell
$env:SQZ_CMD="bv"; bv --robot-triage 2>&1 | sqz compress
```

POSIX shells:

```sh
SQZ_CMD=bv bv --robot-triage 2>&1 | sqz compress
```

Do not:
- duplicate `2>&1`
- use shell-style env assignment in PowerShell
- pass `--no-db` to `bv`

## Rules

- Use only `--robot-*` commands.
- Never launch bare `bv`.
- Never pass `--no-db`.
- Use `bv` for analysis, not issue mutation.
- Prefer `--robot-triage` as the first step unless a narrower command is clearly better.

## Output format

When using this skill, report:
- which robot command was used
- the top recommendation or key finding
- blockers or quick wins if relevant
- the most useful next action
