# Architecture

## Runtime and service model

This config runs on `@opencode/cli` **2.2.5** with `@opencode/plugin`,
`@opencode/schema`, and `@opencode/client` at 2.2.5. `bun.lock` is authoritative.

OpenCode uses the existing background service. Activation was completed with exactly
one `opencode reload`; the existing service PID stayed unchanged. No restart or
migration was performed.

- An already-open session keeps the toolset it started with.
- Reopen the session or attach through a new 2.2.5 client to pick up the activated
  toolset.
- Do not require a service restart after a config-only reload.
- Environment changes are different: keys and host variables must reach the background
  service's launch environment. Reopening only the TUI does not update the running
  service; apply them with an idle `opencode service restart` from the configured shell.

## Config shape

Use the native 2.2.5 sections: `providers`, `agents`, `permissions`, `mcp.servers`,
and `plugins`. `small_model` is unsupported and removed.

## Load path

1. OpenCode reads the base config from the config directory.
2. Host initialization adds default server entries only when they are absent.
3. `instructions/*.md` are included.
4. `AGENTS.md` is the global agent index.
5. `agents/*.md` declare primaries and workers.
6. `commands/*.md` declare slash commands.
7. Local plugins are discovered from the single active `plugins/` directory.
8. Skills load on demand through the `skill` tool.

Do not list local plugin files in the config `plugins` array; they are active exactly
once through discovery.

## Plugin layout

| Path | Role |
| --- | --- |
| `plugins/` | single active auto-discovery directory |
| `plugins.1x-disabled/` | retained 1.x archive; not loaded |

`plugins.v2-staging/` has been removed.

Active exactly once each:

- local `plugins/retrieval-policy.ts` — id `retrieval-policy`
- local `plugins/sqz.ts` — id `sqz`
- `@tarquinen/opencode-dcp@3.2.0` — id `opencode-dcp`
- `cc-safety-net@2.7.2`

No failed custom plugins. The four legacy optional plugins remain disabled: table
formatter, smart title, unmoji, ntfy. Native features are not claimed to restore their
functionality.

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

- `build` and `plan` are the only user-selectable primaries.
- Six cheap pinned workers: `code`, `review`, `explore`, `fetch`, `track`, `composio`.
- `general` is absent.
- There is no `research` agent and no replacement layer.
- `subagent_depth` is 1; all workers have no children.
- Worker model pins are independent of the primary and must not be changed on resume
  unless the actual 2.x behavior is explicitly verified.

## Permissions

The posture is deny-by-default for unknown tools, with explicit local and role-specific
allows. The last matching rule wins.

- `build` / `plan` cannot edit or run shell directly; they delegate. Both allow
  `compress`, `customize-opencode`, and `todowrite`.
- `build` retains the authorized Home Assistant exception; `plan` does not.
- `code` can read, write, edit, patch, and run shell. Its shell allowlist denies obvious
  direct web-fetch commands (`curl`, `wget`, `Invoke-WebRequest`, `Invoke-RestMethod`,
  `iwr`, `irm`, `Start-BitsTransfer`, `git clone`). This is **not** a network jail:
  package installs and language tooling can still reach the network.
- `review` is read-only, with a narrow `git status` / `git diff` / `git log` shell
  allowlist.
- `explore` is read-only and may use local Semble; remote git repo URLs are rejected.
- `fetch` is the only agent with external retrieval surfaces. It may call
  `retrieval_control` for `status` only.
- `track` may run `br` and robot-only `bv --robot-*`; `bv ... --no-db` is denied.
  Destructive `br` operations keep the approval convention.
- `composio` may use `composio_*` only.
- Unknown MCP namespaces are denied for all agents by default.

## Local discovery budget

`explore` is the bounded local worker. An assignment starts with **8 local
search/list calls** (`glob`, `grep`, SQZ list/grep, local Semble search, and
search/list shell invocations). Reading a known file does not consume the budget.
The plugin charges one unit per leaf `execute.before` event, including leaves
inside one Code Mode `execute` script; the outer `execute` call is not a search.

- `explore` stops when the objective is met, the budget is exhausted, or further
  calls have poor marginal yield.
- The parent may grant exactly one extension with `retrieval_control`
  (`action=extend_explore`, target a direct child). The default is +8 calls;
  `extra_calls` may request up to 32 for a genuinely larger assignment.
- The worker cannot extend itself; `retrieval_control` remains build/plan-only.
- The budget is **per explore child assignment**, not a total-task budget. Direct
  searches by the primary and newly spawned children are prompt-governed, not
  counted by this counter.
- This is a call budget, not a time budget. It does not interrupt inference or a
  blocking/stalled tool call, and there is no hard wall-clock promise.
- Real 2.2.5 Code Mode leaf-hook emission remains unverified until a live smoke;
  the offline tests simulate those hook events.
- `explore` has no per-task `steps` ceiling in this config. Local 2.2.5 step
  semantics on subagent resume are not verified; a low ceiling could make a
  parent-approved extension unusable. `fetch` keeps its existing `steps: 10`.
- Budget state is in memory for the plugin process. A plugin reload or service
  restart resets it. Normal session resume keeps the same session ID and budget.

## Compaction

Native compaction remains enabled. DCP 3.2.0 keeps the existing `dcp.jsonc` shape:
min/max is a soft-nudge band, not a hard prune. Do not tune it mid-task without
evidence.

## SQZ

SQZ is a retained local plugin plus the SQZ MCP. Compression is output-only in the
native `execute.after` path:

- structured shell output and exit metadata are preserved;
- only model-visible successful content is compressed;
- commands are never rewritten;
- a hard deadline falls back to the original output.

Do not add RTK or a second compressor. The primary needs the `compress` permission.

## Native provider catalog and TinyFish

The native catalog still lists `exa`, `firecrawl`, `parallel`, `tavily`, and `tinyfish`.
It is not restricted or reduced by this config.

- The public promise adapter exposes only `add` and `default`, not `list` or `remove`.
- The plugin discovers TinyFish through `websearch.providers` and pins the supported
  default with `default.set('tinyfish')`.
- Other native providers are not removed.
- The native builtin tool accepts only `query`; explicit overrides are denied.
- A wrong-provider result or error disables native search without poisoning TinyFish.
- A real `fromPromise` adapter test exists.

## Code Mode

- Code Mode leaves shared outer IDs.
- Identity queues handle normal and permission-reply cleanup while retaining sibling
  outcomes.
- Raw `fetch` is blocked; page reads must use the governed `webfetch`.
- A direct/plain permission reject can emit no after hook.
- Cleanup uses permission events plus TTL fallback and hard interrupt.

## Host defaults and credentials

Host initialization adds Exa, Semble, eBay, and Home Assistant defaults **only when
those server entries are absent**. Explicit entries are preserved, including
`disabled: true` and custom commands/URLs, except the tracked eBay placeholder, which
is resolved and enabled only when its local project and both credentials exist.

- `opencode.host.example.jsonc` sets Semble `disabled: true` by default.
- `OPENCODE_DISABLE_SEMBLE=1` is a real one-way kill switch, even for an explicit
  enabled entry.
- Exa requires `EXA_API_KEY`.
- Semble requires a valid local project directory (env override or
  `~/mcp-servers/semble`), unless the kill switch is set.
- Home Assistant requires both `HA_MCP_URL` and `HA_BEARER_TOKEN`; there is no personal
  fallback URL.
- eBay requires a valid local project (`EBAY_MCP_DIR` or `~/mcp-servers/ebay`) and both
  `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`; missing prerequisites leave it disabled.
  `OPENCODE_DISABLE_EBAY=1` is a one-way kill switch.
- eBay's historical errors remain undiagnosed and it is not live-verified.

Headers stay in memory, never source or logs. `service.json` / `service.jsonc` may
contain service credentials; they are ignored and must never be committed, printed, or
copied. `cli.json` is deliberately tracked public UI configuration. `tui.json` is
historical; do not assume it is the active location.

## MCP status

Previously observed connected (not re-verified here): `context7`, `DuckDuckGo`,
`gh_grep`, `Semble`, `SQZ`. Semble stays host-auto-detected and explore-only.

- eBay: configured, conditionally available, not verified. Its historical errors are
  undiagnosed; do not claim a working connector without a live read-only test.
- Composio needs authentication under 2.2.5; old OAuth is not claimed migrated or
  connected.
- Exa and Home Assistant are absent because env prerequisites are not met.

## Repository hygiene

- `memory/` is ignored.
- `opencode.private.local.json`, `notification-ntfy.json`, `auth.json`, `.env*`,
  `*.bak`, logs, and service credential files are ignored.
- Operational retrieval state lives outside Git in
  `~/.local/share/opencode/retrieval/` (or `$XDG_STATE_HOME/opencode/retrieval`).
- Never commit personal memory, keys, auth stores, service credentials, or host paths.

## Cross-file facts

- The activated tree uses one auto-discovery directory (`plugins/`) and does not
  double-list local plugins.
- Host defaults only fill absent server entries; explicit entries win.
- Native OpenAI subscription selection is a manual user step and is not assumed.
- Old sessions must be reopened/attached to pick up the new toolset.
- Real model-turn, tool, and Code Mode smoke checks remain pending.
