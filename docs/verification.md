# Verification

## Activation status

**Loader/config activation: complete.**

Observed during activation:

- Both idle checks returned 0.
- Exactly one `opencode reload`.
- Existing 2.2.5 service PID 41900 stayed up unchanged; no restart or migration.
- No searches, model calls, auth operations, session reads, or pushes.
- Active exactly once each: local `retrieval-policy` (id `retrieval-policy`), local
  `sqz` (id `sqz`), `@tarquinen/opencode-dcp@3.2.0` (id `opencode-dcp`), and
  `cc-safety-net@2.7.2`.
- No failed custom plugins.
- `plugins.v2-staging/` removed; `plugins.1x-disabled/` retained.
- Local entries are not double-listed in config.
- Tests, typecheck, and config/service preflight were green. At the activation run the
  suite reported 184 pass / 1 POSIX-only skip / 0 fail; this is a snapshot, not a
  future guarantee.
- MCP connected: `context7`, `DuckDuckGo`, `gh_grep`, `Semble`, `SQZ`. eBay disabled;
  Composio needs authentication; Exa and Home Assistant absent because env
  prerequisites are not met.
- No credential values were read.

Real model-turn, tool, and Code Mode smoke checks remain pending.

## Safe checks

These do not start/restart the service or read sessions:

```text
opencode --version
opencode --help
opencode stats --help
git status --short
git diff --stat
```

Expected CLI identity: `opencode v2.2.5`.

## Repository checks

If the activated 2.2.5 tree still defines the package scripts:

```text
bun install
bun run typecheck
bun test
bun run preflight -- --config
```

Do not freeze the activation test count as a contract. Re-run the commands and report
the current result.

## Native usage

`opencode stats` is the supported read-only usage path in 2.2.5:

```text
opencode stats --days 7
opencode stats --cost --models --tools --limit 20
opencode stats --json
opencode stats --all
```

Flags: `--days`, `--year`, `--all`, `--project`, `--models`, `--tools`, `--cost`,
`--full`, `--limit`, `--json`.

It reports shareable usage statistics, not vendor billing. There is no in-session
`tokenscope` or `context_usage` tool.

## Loader/config checklist (complete)

- [x] Runtime reports `opencode v2.2.5`.
- [x] One `opencode reload`; existing service stayed up.
- [x] SDK packages are 2.2.5.
- [x] `plugins/` is the single auto-discovery directory.
- [x] Local plugins are not double-listed.
- [x] `retrieval-policy` id loaded exactly once.
- [x] `sqz` id loaded exactly once.
- [x] DCP 3.2.0 loaded exactly once.
- [x] `cc-safety-net` 2.7.2 loaded.
- [x] No failed custom plugins.
- [x] `plugins.v2-staging/` removed; `plugins.1x-disabled/` retained.
- [x] Four legacy optional plugins remain disabled.
- [x] `cli.json` is deliberately tracked.
- [x] `service.json` / `service.jsonc` remain ignored and unprinted.
- [x] `tui.json` remains historical.

## Pending real smoke checks

- [ ] Real model turn on the configured strong main.
- [ ] Native OpenAI login, actual catalog model selection, and one entitlement call.
- [ ] Retrieval tool call through the activated stack.
- [ ] Code Mode: shared outer IDs, identity queues, permission-reply cleanup, sibling
      outcomes retained.
- [ ] Raw Code Mode `fetch` blocked; governed `webfetch` succeeds.
- [ ] Native TinyFish live search (keyed/keyless as available).
- [ ] Keyed Exa live search.
- [ ] Composio MCP authentication and one workflow.
- [ ] Old session reopened/attached through a new 2.2.5 client.
- [ ] Actual wire provider, entitlement, cost, and billing observation.

## Manual commands pending

Composio MCP authentication:

```text
opencode mcp list
opencode mcp auth [<name>]
```

`<name>` is optional; choose Composio from the picker. Do not claim old OAuth migrated.

Native OpenAI:

```text
opencode auth login [<target>]
opencode models
opencode auth list [--format default|json]
opencode auth switch [<target>] [<credential>]
```

`<target>` is optional and must not be guessed. After a real entitlement call, persist
the exact catalog id only through an approved manual config change. No fabricated id or
fallback promise.

## What is not verified

- Actual upstream wire provider, cost, or billing for any configured model.
- Native OpenAI/ChatGPT subscription entitlement.
- A real native OpenAI model id to persist.
- TinyFish keyless vendor allowance or live success.
- Exa keyed live success or paid-key behavior.
- Composio authentication or workflow execution.
- Real model-turn, tool, and Code Mode behavior after activation.
- Session compatibility across a runtime downgrade.

## Failure handling

If the same safe command fails twice, stop and report the error instead of retrying
blindly. Keep changes small and reversible; restore only reviewed paths. Do not restart
the service for documentation verification after a config-only reload. Environment
changes are separate: apply them with an idle `opencode service restart` from the
configured shell.
