If no .beads folder present, ask user if it wants issue tracking for this session and ask instructions for implementation.

<!-- br-agent-instructions-v2 -->

## br (beads_rust) — Issue Management

### Platform split

- Windows: use `br` with `--no-db --no-auto-flush` unless a repo-local wrapper already adds them.
- Linux/macOS: use plain `br` unless repo-local docs override that behavior.

The bundled SQLite pager does not work on Windows. `--no-auto-flush` suppresses the harmless CONFIG_ERROR about stale DB export in that mode.

**Windows suffix for br commands:**
```bash
--no-db --no-auto-flush
```

Examples below show the Windows form where a suffix is present; adapt them for Linux/macOS if your repo uses plain `br` there.

### Creating Beads

```bash
br create --no-db --no-auto-flush \
  --title="Task title" \
  --description="Detailed description" \
  --type=task \
  --priority=1
```

**Available flags:**
- `--title <TITLE>` — Issue title (required)
- `--description <DESC>` — Description/body (use for multi-line content)
- `--type <TYPE>` — task|bug|feature|epic|chore|docs|question
- `--priority <N>` — 0=critical, 1=high, 2=medium, 3=low, 4=backlog
- `--labels <LABELS>` — Comma-separated labels (e.g., "security,urgent")
- `--parent <ID>` — Parent issue ID (creates parent-child relationship)
- `--deps <DEPS>` — Dependencies (format: `blocks:id,blocks:id`)
- `--assignee <NAME>` — Assign to person
- `--estimate <MINUTES>` — Time estimate in minutes

### Managing Dependencies

```bash
# Make ISSUE depend on DEPENDS_ON (i.e., DEPENDS_ON blocks ISSUE)
br dep add --no-db --no-auto-flush <ISSUE> <DEPENDS_ON>

# Remove dependency
br dep remove --no-db --no-auto-flush <ISSUE> <DEPENDS_ON>

# List dependencies for an issue
br dep list --no-db --no-auto-flush <ISSUE>

# Show full dependency tree
br dep tree --no-db --no-auto-flush <ISSUE>

# Detect cycles
br dep cycles --no-db --no-auto-flush
```

**Dependency types:**
- `blocks` (default) — DEPENDS_ON must complete before ISSUE can start
- `parent-child` — Hierarchical relationship (use `--parent` in create instead)
- `related` — Loose association

### Querying Beads

```bash
# List all open issues (default limit: 50)
br list --no-db --status=open

# List all open issues with no limit
br list --no-db --status=open --limit=0

# List ready-to-work issues (unblocked)
br ready --no-db

# Show full details for an issue
br show --no-db <ID>

# Search issues
br search --no-db "query text"

# Filter by multiple criteria
br list --no-db --status=open --priority=1 --label=security
```

### Updating & Closing Beads

```bash
# Update status
br update --no-db --no-auto-flush <ID> --status=in_progress

# Update priority
br update --no-db --no-auto-flush <ID> --priority=1

# Add labels
br update --no-db --no-auto-flush <ID> --add-label=security,urgent

# Change parent
br update --no-db --no-auto-flush <ID> --parent=<PARENT_ID>

# Close an issue
br close --no-db --no-auto-flush <ID> --reason="Completed successfully"

# Close multiple issues
br close --no-db --no-auto-flush <ID1> <ID2> <ID3>
```

### Syncing (JSONL Export)

In `--no-db` mode, beads are written directly to `.beads/issues.jsonl`. Sync commands are only needed to reconcile after manual JSONL edits or to verify state:

```bash
# Check sync status (read-only)
br sync --no-db --status
```

**Do NOT run** `br sync --flush-only` or `br sync --import-only` in `--no-db` mode — there is no database to sync from/to.

### Expected Errors (Safe to Ignore)

**CONFIG_ERROR "Refusing to export stale database..."**
- **Cause:** The DB export step detected a mismatch (expected in --no-db mode)
- **Impact:** None. The bead WAS successfully created in JSONL.
- **Fix:** Add `--no-auto-flush` to suppress this error entirely.

**DATABASE_ERROR "not implemented: file-backed pager..."**
- **Cause:** You forgot `--no-db` flag.
- **Fix:** Add `--no-db` to the command.

**DATABASE_ERROR "database disk image is malformed..."**
- **Cause:** The `.db` file is corrupted or missing.
- **Impact:** None in `--no-db` mode (the DB is irrelevant).
- **Fix:** Do NOT try to fix the DB. Just use `--no-db`.

### Batch Creation Pattern

When creating multiple beads with parent-child relationships:

1. **Create the parent first**, capture its ID from output
2. **Create children** with `--parent=<PARENT_ID>`
3. **For sibling dependencies**, use `--deps=blocks:<ID>` or `br dep add` after creation

**Example:**
```bash
# Step 1: Create epic
br create --no-db --no-auto-flush \
  --title="Single source of truth — centralize all dynamic values" \
  --type=epic \
  --priority=1
# Output: ✓ Created homeserver-abc1

# Step 2: Create children referencing parent
br create --no-db --no-auto-flush \
  --title="Phase 1: Fix bugs + extend infrastructure.yml" \
  --type=task \
  --priority=1 \
  --parent=homeserver-abc1
# Output: ✓ Created homeserver-def2

# Step 3: Create dependent child (Phase 2 depends on Phase 1)
br create --no-db --no-auto-flush \
  --title="Phase 2: Convert .env files to templates" \
  --type=task \
  --priority=1 \
  --parent=homeserver-abc1 \
  --deps=blocks:homeserver-def2
# Output: ✓ Created homeserver-ghi3
```

<!-- end-br-agent-instructions -->

<!-- bv-agent-instructions-v2 -->

---

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue tracking and [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for graph-aware triage. Issues are stored in `.beads/` and tracked in git.

### Using bv as an AI sidecar

bv is a graph-aware triage engine for Beads projects (.beads/beads.jsonl). Instead of parsing JSONL or hallucinating graph traversal, use robot flags for deterministic, dependency-aware outputs with precomputed metrics (PageRank, betweenness, critical path, cycles, HITS, eigenvector, k-core).

**Scope boundary:** bv handles *what to work on* (triage, priority, planning). `br` handles creating, modifying, and closing beads.

**CRITICAL: Use ONLY --robot-* flags. Bare bv launches an interactive TUI that blocks your session.**

#### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns everything you need in one call:

- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command

# Token-optimized output (TOON) for lower LLM context usage:
bv --robot-triage --format toon
```

#### Other bv Commands

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-priority` | Priority misalignment detection with confidence |
| `--robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-suggest` | Hygiene: duplicates, missing deps, label suggestions, cycle breaks |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified issues |
| `--robot-graph [--graph-format=json\|dot\|mermaid]` | Dependency graph export |

#### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank scores
```

<!-- end-bv-agent-instructions -->

### Workflow Pattern

1. **Triage**: Run `bv --robot-triage` to find highest-impact actionable work
2. **Claim**: Windows `br update --no-db --no-auto-flush <id> --status=in_progress`; Linux/macOS `br update <id> --status=in_progress` unless repo-local docs say otherwise
3. **Work**: Implement the task
4. **Complete**: Windows `br close --no-db --no-auto-flush <id> --reason="Completed: <summary>"`; Linux/macOS `br close <id> --reason="Completed: <summary>"` unless repo-local docs say otherwise
5. **Commit**: Stage code + `.beads/issues.jsonl` together

### Session Protocol

```bash
git status              # Check what changed
git add <files>         # Stage code changes
git add .beads/         # Stage beads changes (JSONL is the source of truth)
git commit -m "..."     # Commit everything together
git push                # Push to remote
```

**Key principle:** The `.beads/issues.jsonl` file is the single source of truth. Always commit it with the code changes it documents.
