## Git Workflow & Parallelism Rules
1. **New Task Protocol**: For every new request, you MUST create a new branch and a separate git worktree.
   - Use: `git worktree add -b <task-name> ../worktrees/<task-name> main`
   - Switch your operations to that directory immediately.
2. **Parallel Tasks**: If multiple tasks are assigned, each must live in its own unique worktree and branch to avoid file conflicts.
3. **Task Completion & Cleanup**: Once a task is finished:
   - You MUST ask the user: "Should I merge this branch into main now?"
   - You MUST ask the user: "Should I delete this branch and its worktree, or keep them for reference?"
   - Do NOT perform the merge or deletion until the user explicitly confirms.
