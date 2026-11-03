---
description: Run dependency-aware beads triage
agent: plan
---

Delegate to the `track` subagent via the `subagent` tool. Do not run `bv` or `br` directly from this primary.

Ask `track` to run the standard triage workflow using only `bv --robot-*` commands, then report:

- top actionable item
- blockers
- quick wins
- next recommended command
