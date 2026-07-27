---
name: beads-br
description: Use Beads Rust commands for creating, updating, and closing Beads issues across Windows and Unix-like shells.
compatibility: opencode
---
# Beads BR Workflow

Use this skill when interacting with `br`, the Beads issue-management tool.

## Purpose

This skill defines the safe operating rules for `br` across platforms.

`br` is the lifecycle and mutation tool for Beads:
- create issues
- inspect issue details
- update status or metadata
- manage dependencies
- close completed work

Use `bv` instead for graph-aware triage, prioritization, and recommendations.

## Environment split

- Windows: every `br` command must include:

```bash
--no-db --no-auto-flush
```

This is mandatory on Windows.

- Linux/macOS: use plain `br` commands unless the current repo documents a different wrapper or flag requirement.

## Windows suffix

Use this suffix on Windows:

```bash
--no-db --no-auto-flush
```

Examples below use the Windows form; on Linux/macOS, omit the suffix unless repo-local docs say otherwise.

## When to use

Use this skill when:
- creating a bead
- claiming a bead
- updating issue metadata
- changing status or priority
- adding labels
- setting parent-child structure
- adding or removing dependencies
- closing completed work
- inspecting a bead in detail

Do not use this skill for project-wide triage or “what should I work on next?” flows.

## Common commands

### Create a bead

```bash
br create --no-db --no-auto-flush \
  --title="Task title" \
  --description="Detailed description" \
  --type=task \
  --priority=1
```

### Show an issue

```bash
br show --no-db --no-auto-flush <ID>
```

### List open issues

```bash
br list --no-db --no-auto-flush --status=open
```

### List ready issues

```bash
br ready --no-db --no-auto-flush
```

### Search issues

```bash
br search --no-db --no-auto-flush "query text"
```

### Mark an issue in progress

```bash
br update --no-db --no-auto-flush <ID> --status=in_progress
```

### Change priority

```bash
br update --no-db --no-auto-flush <ID> --priority=1
```

### Add labels

```bash
br update --no-db --no-auto-flush <ID> --add-label=security,urgent
```

### Set parent

```bash
br update --no-db --no-auto-flush <ID> --parent=<PARENT_ID>
```

### Close an issue

```bash
br close --no-db --no-auto-flush <ID> --reason="Completed successfully"
```

## Dependency management

### Add dependency

```bash
br dep add --no-db --no-auto-flush <ISSUE> <DEPENDS_ON>
```

### Remove dependency

```bash
br dep remove --no-db --no-auto-flush <ISSUE> <DEPENDS_ON>
```

### List dependencies

```bash
br dep list --no-db --no-auto-flush <ISSUE>
```

### Show dependency tree

```bash
br dep tree --no-db --no-auto-flush <ISSUE>
```

### Detect cycles

```bash
br dep cycles --no-db --no-auto-flush
```

## Parent-child creation workflow

When creating multiple related beads:

1. create the parent first
2. capture the parent ID
3. create children with `--parent=<PARENT_ID>`
4. add sibling dependencies after creation when needed

Example:

```bash
br create --no-db --no-auto-flush --title="Epic title" --type=epic --priority=1
# capture created ID

br create --no-db --no-auto-flush --title="Child task" --type=task --priority=1 --parent=<PARENT_ID>
```

## Safe error interpretation

### CONFIG_ERROR about stale database export
Cause: expected side effect of this environment.
Impact: usually none if JSONL write succeeded.
Mitigation: include `--no-auto-flush`.

### DATABASE_ERROR about file-backed pager
Cause: missing `--no-db`.
Fix: add `--no-db`.

### DATABASE_ERROR about malformed database image
Cause: broken `.db`, irrelevant in `--no-db` mode.
Fix: do not try to repair the DB; continue using `--no-db`.

## Source of truth and commit discipline

`.beads/issues.jsonl` is the source of truth.

If a task changes both code and Beads state, commit the related `.beads/` changes with the code changes they document.

## Rules

- On Windows, always include `--no-db --no-auto-flush`.
- On Linux/macOS, use the repo's documented wrapper or plain `br` as appropriate.
- Do not use DB-backed sync workflows.
- Use `br` for issue mutation and lifecycle operations.
- Keep Beads changes aligned with the code changes they represent.

## Output format

When using this skill, report:
- command intent
- issue IDs affected
- resulting status or structure
- recommended next action
