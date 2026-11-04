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
- Tests and typecheck were green. The latest local run reported 316 pass / 1 skip /
  0 fail (317 tests, 11 files); this is a snapshot, not a future guarantee. No service
  preflight or restart was performed for this change.
- Host/session evidence observed in this session after a vault-backed restart: `fetch`
  ran one eBay search (one listing), an Exa search (three results), and a TinyFish search
  (10 results); Context7 and gh_grep searches succeeded; Composio read a spreadsheet range
  (A1:H2); and local Semble semantic search, a SQZ read, and a read-only Home Assistant
  `llm__GetDateTime` call succeeded (returned 2026-11-03 21:40 CET). A DuckDuckGo search
  was inconclusive (possible bot detection or no results). These are host/session results,
  not universal guarantees. eBay's historical errors remain undiagnosed, so one listing is
  not a connector-health guarantee.
- Offline policy/config tests cover eBay classification, budgets, fail-closed unknown
  tools, fetch-only access, conditional host activation, get()/list() asymmetry, and
  status connector evidence. These are not a live connector test.
- OpenCode 2.2.5 environment interpolation: the installed CLI binary contains
  `ConfigVariable.substitute`, which replaces `{env:NAME}` with
  `env?.[NAME] ?? process.env[NAME] ?? ""`; a missing variable becomes an empty
  string, not a literal placeholder. Host initialization now also writes the effective
  eBay values in memory and omits `EBAY_ENV` when unset, so it does not depend on
  transform-time re-interpolation. No config dump was run.
- Semble entrypoint: the local `.venv/Scripts/semble.exe --help` ran offline and
  exited 0. `semble` is provided by the `semble` dependency's console script, not by a
  local `[project.scripts]` table; the reviewer's "missing entrypoint" inference is
  incorrect.
- MCP editor contract: installed `@opencode/plugin` 2.2.5 `promise/mcp.d.ts` exposes
  `list`, `get`, `set`, `update`, and `remove`. Host initialization now seeds its view
  from `get()` because `list()` may omit a disabled entry; tests cover the asymmetric
  case and a `get()`-only custom entry is preserved.
- Installed CLI source inspection (minified `@opencode/cli` 2.2.5 binary): the MCP
  editor `set`/`update` path mutates an in-memory `Map` and triggers a runtime reload;
  no tracked-config write was observed in that path. This is not a runtime persistence
  proof, so `docs/secrets.md` does not claim proven memory-only persistence.
- SOPS/age: the user reports that the real vault decrypted on Windows with the
  passphrase-protected identity and a restored Bitwarden backup. This task did not read
  the real vault, identity, or passphrase. Linux interactive prompt behavior and
  end-to-end service restart environment inheritance remain unverified.
- Launcher executable validation now accepts only an `opencode` basename (`opencode.exe`
  / `opencode.cmd` on Windows) and refuses an arbitrary executable without echoing its
  name. Tests cover the default command, explicit Windows `.exe` path, and rejection.
  This is a name check, not binary integrity verification.
- `.gitignore` adds common private-key extensions and editor swap/backup artifacts. It
  remains best-effort, not comprehensive identity-path protection.
- No credential values were read or printed; only presence booleans and fake sentinel
  values in tests were used.

Real model-turn and Code Mode contract smoke checks (shared outer IDs, identity queues,
permission-reply cleanup) remain pending beyond the connector results above.

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
- [x] Retrieval tool call through the activated stack (observed in this session).
- [ ] Code Mode: shared outer IDs, identity queues, permission-reply cleanup, sibling
      outcomes retained.
- [ ] Raw Code Mode `fetch` blocked; governed `webfetch` succeeds.
- [x] Native TinyFish live search (observed in this session, 10 results).
- [x] Keyed Exa live search (observed in this session, three results).
- [x] Composio MCP authentication and one workflow (observed in this session; read-only
      spreadsheet).
- [ ] Old session reopened/attached through a new 2.2.5 client.
- [ ] Actual wire provider, entitlement, cost, and billing observation.

## Manual commands pending

Composio MCP re-authentication (authenticated in this session; run only if needed):

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
- TinyFish keyless vendor allowance (a live search succeeded in this session).
- Exa paid-key behavior (a keyed live search and PDF read succeeded in this session).
- Composio consumer-key user/project scope or access to pre-existing connections
  (authentication and one read-only sheet range succeeded in this session).
- Whether MCP editor changes can persist resolved secrets outside the in-memory
  effective configuration in every runtime path.
- Linux interactive passphrase/TTY behavior for the encrypted identity.
- That a real `opencode service restart` inherits the launcher environment, or that
  restart preserves all intended ambient-variable behavior.
- Comprehensive `.gitignore` protection for arbitrarily named age identities.
- Real model-turn and Code Mode contract behavior after activation (connector/tool
  calls succeeded in this session).
- Session compatibility across a runtime downgrade.

## Failure handling

If the same safe command fails twice, stop and report the error instead of retrying
blindly. Keep changes small and reversible; restore only reviewed paths. Do not restart
the service for documentation verification after a config-only reload. Environment
changes are separate: apply them with an idle `opencode service restart` from the
configured shell.
