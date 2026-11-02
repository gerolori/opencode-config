# Architecture

## Purpose

`~/.config/opencode` is both the canonical source checkout and the live global config
directory. Changes take effect for new sessions; a running session keeps its loaded
plugins and config.

## Load path

1. OpenCode reads `opencode.jsonc` from the config directory.
2. Environment overlays can be added with `OPENCODE_CONFIG`. They merge over the base.
3. `instructions/*.md` are always included.
4. `AGENTS.md` is loaded as the global agent index.
5. `agents/*.md` declare primary and subagent behavior.
6. `commands/*.md` declare slash commands.
7. `plugins/*.ts` are auto-discovered. Files listed in the `plugin` array are external
   packages, not local files.
8. `skills/*/SKILL.md` are loaded on demand by the `skill` tool.

Do not list `plugins/sqz.ts` or `plugins/retrieval-policy.ts` in `opencode.jsonc`; they
load by discovery.

## Config layers

- `opencode.jsonc` — base, portable, tracked.
- `opencode.host.example.jsonc` — tracked example overlay for host-local MCP paths.
- `opencode.private.local.json` — ignored host override for this machine. As of this
  writing OpenCode does **not** load it automatically; pass it through
  `OPENCODE_CONFIG` (or use the example overlay with environment variables).
- Environment variables — keys and host paths only.

Base Semble and eBay entries stay disabled. Semble requires a host path on Windows.
The preferred final behavior is a HOME-derived auto-enable or an explicit local
override, decided after the final integration files are reviewed. Do not hard-code a
machine path into tracked config.

## Delegation model

One level only:

```text
build / plan
  -> code
  -> review
  -> explore
  -> fetch
  -> track
  -> composio
```

Rules enforced by config and the retrieval plugin:

- `subagent_depth` is 1.
- A child cannot call `task`.
- Only `build` and `plan` can spawn children.
- `code`, `review`, `explore`, `fetch`, `track`, and `composio` have `task: deny`.
- There is no `research` agent and no replacement layer.
- Only `fetch` has external retrieval tools.
- `track` is restricted to `br` / `bv`.
- `composio` owns one external-app workflow end-to-end and has no web or child access.

## Permissions

The global posture is deny-by-default for external surfaces. Each agent re-allows only
its own surface; the last matching rule wins.

- `build` / `plan` cannot edit or run shell directly. They delegate.
- `code` can read, write, edit, patch, and run shell.
- `review` is read-only, with a narrow `git status` / `git diff` / `git log` shell
  allowlist.
- `explore` is read-only and may use local Semble; remote git repo URLs are rejected.
- `fetch` is the only agent with `websearch`, `webfetch`, `context7_*`, `exa_*`,
  `gh_grep_*`, `duckduckgo_*`, `tinyfish_search`, and `retrieval_control`.
- `track` may run `br` / `bv`; `br delete` and `br close` ask for approval.
- `composio` may use `composio_*` only.

## Compaction

Native compaction is enabled with `preserve_recent_tokens: 40000` and
`reserved: 100000`. DCP runs with its own defaults (`dcp.jsonc`). Do not tune either
mid-task without evidence.

## Plugins

### sqz

`plugins/sqz.ts` does not rewrite shell commands. The shell tool runs exactly as
requested and the already-captured output is compressed in `tool.execute.after`, so
exit codes and stdout/stderr metadata are preserved. The MCP command is currently
`["sqz-mcp.exe"]`, which relies on `PATH`; this is a Windows-specific selection and is
still owned by the integration work.

### retrieval-policy

`plugins/retrieval-policy.ts` owns per-session retrieval budgets, provider circuits,
error classification, direct TinyFish search, Exa enablement, and metadata-only local
state. See `docs/retrieval.md`.

## Repository hygiene

- `memory/` is ignored.
- `opencode.private.local.json`, `notification-ntfy.json`, `auth.json`, `.env*`,
  `*.bak`, and logs are ignored.
- Operational retrieval state lives outside Git in
  `~/.local/share/opencode/retrieval/` (or `$XDG_STATE_HOME/opencode/retrieval`).
- Never commit personal memory, keys, auth stores, or host-local paths.

## Cross-file assumptions

- Local plugin discovery from `plugins/` remains in effect.
- `opencode.private.local.json` must be explicitly loaded until automatic host overlay
  support is confirmed.
- `sqz-mcp.exe` or a future portable command must exist on `PATH`.
- The exa base entry must keep its header/env wiring for the plugin's enable switch to
  be meaningful.
- The script and tests under `scripts/` and `tests/` are the verification contract.
