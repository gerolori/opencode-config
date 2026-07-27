---
name: worktree-flow
description: Create isolated git worktrees with tracker-aware naming for GitHub issues, Beads tasks, and local work.
compatibility: opencode
---
# Worktree Flow

Use this skill when a task should be isolated in its own branch and git worktree.

## Purpose

This skill provides a safe workflow for:
- starting medium or large tasks in isolation
- running concurrent tasks without branch conflicts
- keeping risky changes separate from the main development flow
- aligning branch and worktree names with the task tracker source

## When to use

Use this skill when:
- the task is non-trivial
- the task may span multiple commits
- multiple tasks may be worked on in parallel
- the user explicitly wants branch isolation
- the task is risky enough that clean separation is useful

Do not force this workflow for every tiny change.

For very small, single-file, low-risk tasks, staying in the current tree may be fine unless project rules require isolation.

## Tracking-aware naming policy

The branch name and worktree directory name must reflect the task source.

### GitHub issue-backed task

Use:

```text
gh-<issue-number>-<short-slug>
```

Examples:
- `gh-142-fix-auth-timeout`
- `gh-311-add-cache-invalidation`

### Beads-backed task

Use:

```text
bd-<bead-id>-<short-slug>
```

Examples:
- `bd-homeserver-abc1-fix-proxmox-vars`
- `bd-api-x7k2-add-rate-limit-check`

### Local untracked task

Use:

```text
local-<short-slug>
```

Examples:
- `local-debug-ci-flake`
- `local-review-auth-refactor`

## Slug rules

The `<short-slug>` must be:
- short
- descriptive
- lowercase
- hyphen-separated
- safe for filesystem and git branch names

Avoid:
- spaces
- punctuation-heavy names
- generic names like `fix-bug`, `update-code`, or `task-work`
- copying the full issue title verbatim if it is too long

Good slugs:
- `fix-session-refresh`
- `add-cache-headers`
- `cleanup-login-flow`

## Canonical workflow

### 1. Identify the task source

Determine whether the task is:
- GitHub issue-backed
- Beads-backed
- local and untracked

If the task is tracked, capture the issue number or bead ID first.

### 2. Derive the canonical task name

Construct the branch and worktree name using the tracking-aware naming policy.

Examples:
- GitHub issue `#142` titled `Fix auth timeout handling` → `gh-142-fix-auth-timeout`
- Bead `homeserver-abc1` titled `Fix Proxmox variable drift` → `bd-homeserver-abc1-fix-proxmox-vars`
- Local task `Investigate flaky auth test` → `local-investigate-auth-flake`

If a GitHub issue number or bead ID exists, do not fall back to a generic local name.

### 3. Create the worktree

Canonical command pattern:

```bash
git worktree add -b <task-name> ../worktrees/<task-name> main
```

If the repository uses another default branch, use that instead of `main`.

### 4. Switch operations to the worktree immediately

After creation, all further file operations for that task must happen inside the new worktree path.

Do not keep editing in the original checkout by mistake.

### 5. Verify location before proceeding

Confirm:
- current branch
- current working directory
- git status

Useful checks:

```bash
git branch --show-current
git status
git worktree list
```

### 6. Perform the task

Keep all changes for that task within the dedicated worktree and branch.

If the task is linked to GitHub or Beads, keep commits and notes aligned with that task identity.

## Completion workflow

When implementation is finished:

1. review the diff
2. confirm verification status
3. stage code and related tracking files together
4. commit on the task branch
5. ask the user before merge or cleanup

## Required questions at completion

Always ask both before cleanup:

- Should I merge this branch into main now?
- Should I delete this branch and its worktree, or keep them for reference?

Do not merge or delete until explicitly confirmed.

## Rules

- Never create multiple unrelated tasks in the same worktree.
- Never forget to move into the worktree before editing.
- Never delete the branch or worktree without explicit confirmation.
- Always prefer tracker-aware names over generic names.
- Use the issue number or bead ID in the branch name whenever available.

## Output format

When using this skill, report:
- task source: GitHub | Beads | local
- canonical task name
- worktree path
- branch name
- current status
- any required user confirmation before merge or cleanup
