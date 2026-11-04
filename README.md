# opencode-config

Canonical OpenCode configuration for this user, running **OpenCode 2.2.5**. It is a
source checkout at `~/.config/opencode` (on Windows,
`C:\Users\hermes\.config\opencode`) and the global config directory OpenCode loads.

> Status: **ACTIVATED at loader/config level.** Exactly one `opencode reload` was
> applied; the existing 2.2.5 background service (PID 41900) stayed unchanged. No
> restart, migration, search/model call, auth, session read, or push was performed by
> that activation. Dated connector/tool checks were recorded later, on 2026-11-04; real
> model-turn and Code Mode contract smoke checks remain pending. See `docs/verification.md`.

## Runtime

| Item | Value |
| --- | --- |
| CLI | `@opencode/cli` 2.2.5 |
| SDKs | `@opencode/plugin`, `@opencode/schema`, `@opencode/client` 2.2.5 |
| Lockfile | `bun.lock` authoritative |
| Process model | existing background service |
| Agents | build/plan primaries + six pinned workers |
| `small_model` | unsupported in native config; removed |

An already-open session keeps the tools it started with. Reopen the session or attach
through a new 2.2.5 client to pick up the activated toolset. Do not require a service
restart after a config-only reload; environment changes are separate.

## Layout

```text
~/.config/opencode/
  AGENTS.md                 small always-loaded index
  README.md                 this file
  opencode.jsonc            native config: providers, agents, permissions, mcp.servers, plugins
  agents/                   build, plan, six workers
  commands/                 slash-command templates
  instructions/             always-included instruction files
  docs/                     detailed docs and templates
  memory/                   ignored global memory (never committed)
  plugins/                  single active auto-discovery directory
  plugins.1x-disabled/      retained 1.x archive (not loaded)
  service.json / service.jsonc   ignored service credentials; never commit or dump
  secrets/                  ignored except user-created secrets/opencode.sops.yaml
  cli.json                  deliberately tracked public UI config
  tui.json                  historical; not assumed to be the active location
```

`plugins.v2-staging/` has been removed. The active local plugins are not also listed
in config. Do not read, print, commit, or copy `service.json`, `service.jsonc`,
`auth.json`, or other credential stores.

## Agents and delegation

Exactly one delegation level:

```text
build / plan  ->  code | review | explore | fetch | track | composio
```

- `build`, `plan` — the only user-selectable primaries; both allow `compress`,
  `customize-opencode`, and `todowrite`.
- `code` — scoped edits and narrow verification.
- `review` — read-only correctness, regression, scope, verification check.
- `explore` — read-only local discovery, including local Semble.
- `fetch` — the only worker allowed to touch external sources.
- `track` — Beads `br` / `bv` only.
- `composio` — one external-app workflow end-to-end.
- `general` — absent. There is no `research` layer and no replacement intermediary.

All workers have no children. The retrieval policy also denies `task` from child
sessions and from agents other than `build` / `plan`.

## Activation evidence

- Both idle checks returned 0.
- One `opencode reload`; the existing 2.2.5 service stayed up with the same PID.
- Active exactly once each:
  - local `plugins/retrieval-policy.ts` (id `retrieval-policy`)
  - local `plugins/sqz.ts` (id `sqz`)
  - `@tarquinen/opencode-dcp@3.2.0` (id `opencode-dcp`)
  - `cc-safety-net@2.7.2`
- No failed custom plugins.
- `plugins.v2-staging/` removed; `plugins.1x-disabled/` retained.
- Local entries are not also listed in config.
- Tests, typecheck, and config/service preflight were green at activation. The test
  count is a snapshot, not a future guarantee.

## Commands (OpenCode 2.2.5)

```text
opencode service status        show background service status
opencode reload                reload configuration
opencode auth list [--format default|json]
opencode auth login [<target>] connect an integration (target optional)
opencode auth switch [<target>] [<credential>]
opencode mcp list              list configured MCP servers and status
opencode mcp auth [<name>]     authenticate an OAuth-capable MCP server
opencode models                list available models
opencode plugin list           list plugins
opencode stats [flags]         shareable usage statistics
opencode upgrade <version>     manual runtime upgrade
opencode debug config          list configuration sources
```

`opencode stats` flags: `--days`, `--year`, `--all`, `--project`, `--models`,
`--tools`, `--cost`, `--full`, `--limit`, `--json`. It reports shareable usage
statistics, not vendor billing.

Repository checks, if the activated tree still defines them:

```text
bun install
bun run typecheck
bun test
bun run preflight -- --config
```

Slash commands in `commands/`:

| Command | Purpose |
| --- | --- |
| `/claim` | claim a bead through `track` |
| `/triage` | dependency-aware Beads triage through `track` |
| `/review-diff` | review the current diff with `review` |
| `/worktree` | start a task in a dedicated worktree |
| `/tokenscope` | point at native `opencode stats`; no in-session token tool exists |

### Token telemetry

There is no in-session `tokenscope` or `context_usage` tool. Use `opencode stats`.
Do not invent per-tool in-session counts, and do not install tokenizer or telemetry
dependencies to reconstruct a removed command.

## Tool contracts

### `retrieval_control`

```text
retrieval_control({
  action: "status" | "extend" | "extend_explore" | "reset_provider",
  session_id?: string,
  extra_calls?: number,
  provider?: "duckduckgo" | "tinyfish" | "exa" | "gh_grep" | "context7" |
             "builtin_webfetch" | "semble"
})
```

- `status` — caller's own session by default. A `build` / `plan` parent may target a
  direct child. `fetch` may call only `status`.
- `extend` — `build` / `plan` only, direct child only, once, +3 searches and +3 reads.
- `extend_explore` — `build` / `plan` only, direct child only, once, +8 local
  search/list calls by default; `extra_calls` may request up to 32. This is separate
  from the fetch search/read extension and does not reset counters. The enforced
  budget is per explore child, not a total-task budget; direct primary searches and
  newly spawned children are not counted. Counters are in-memory and reset on plugin
  reload/service restart. There is no time limit and no claim to stop a stalled tool.
  Code Mode leaf-hook behavior remains unverified until a live smoke.
- `reset_provider` — root `build` / `plan` only. Clears a named provider's cooldown,
  operator-required flag, last error category, and consecutive failures. It preserves
  TinyFish rate counters, provider totals, resource blocks, and every session budget.
- The tool never calls an MCP server.

### Native TinyFish and the native catalog

The custom TinyFish HTTP adapter was removed. The native provider catalog still lists
`exa`, `firecrawl`, `parallel`, `tavily`, and `tinyfish`.

The public promise adapter exposes only `add` and `default` — not `list` or `remove`.
The plugin discovers TinyFish through `websearch.providers` and pins the supported
default with `default.set('tinyfish')`. It does **not** remove the other native
providers.

The native builtin tool accepts only `query`; explicit provider overrides are denied. A
wrong-provider result or error disables native search without poisoning TinyFish. A real
`fromPromise` adapter test exists.

TinyFish specifics:

- Optional `TINYFISH_API_KEY`.
- Keyless is supported under local safeguards.
- No vendor keyless allowance or live success is verified.
- Local protective counters: 30/minute, 500/hour, 12,000/day. These are guards, not a
  quota promise.

### Retrieval behavior

- General discovery: DuckDuckGo first, then native TinyFish.
- Semantic: keyed Exa MCP first, then one healthy alternative.
- Per child `fetch` assignment: 3 searches and 3 page reads.
- One `build` / `plan`-approved extension (+3/+3), then resume.
- Blocked attempts count. A valid read batch counts one read per URL; an invalid batch
  costs one blocked attempt.
- At most 2 providers per normalized query/URL.
- One bounded transient retry. No auth, quota, access-denial, or CAPTCHA loops.
- The main judges evidence sufficiency; no fixed search minimum.
- Do not change a pinned child model on resume unless the actual 2.x behavior is
  explicitly verified.

Provider ordering is advisory. The policy enforces caps, circuits, roles, and returns
suggested next providers; the agent executes normal tools.

### Code Mode

Code Mode leaves shared outer IDs. Identity queues handle normal and permission-reply
cleanup while retaining sibling outcomes. Raw `fetch` is blocked; HTML/text page reads
must use the governed `webfetch`. Native `webfetch` rejects PDFs. Exa has bounded live
evidence extracting one vendor PDF manual, but neither Exa nor DuckDuckGo content fetch
guarantees usable PDF text; DuckDuckGo has returned raw PDF binary. The primary decides
whether a likely-exact manual is worth an Exa read. See `docs/retrieval.md`. A
direct/plain permission reject can emit no after hook;
cleanup uses permission events plus TTL fallback and hard interrupt.

## Plugins

Active, exactly once each:

- local `plugins/retrieval-policy.ts` — id `retrieval-policy`
- local `plugins/sqz.ts` — id `sqz`
- `@tarquinen/opencode-dcp@3.2.0` — id `opencode-dcp`
- `cc-safety-net@2.7.2`

`opencode-dcp` 3.2.0 keeps the existing `dcp.jsonc` shape; min/max is a soft-nudge
band, not hard prune.

SQZ is output-only in the native `execute.after` path. It preserves structured shell
output and exit metadata, compresses model-visible successful content, never rewrites
commands, and falls back on a hard deadline. Do not stack RTK or a second compressor.
The primary needs the `compress` permission.

The four legacy optional plugins remain disabled and are not restored by native
replacements: table formatter, smart title, unmoji, ntfy.

## Models and auth

The strong main stays on OpenRouter `customkey` `gpt-6-luna`, wire id
`openai/gpt-6-luna`, high variant, until the user interactively logs in to native
OpenAI and selects/tests a real entitled catalog model. No actual wire provider,
entitlement, or billing test has been performed.

The six worker pins are independent of the primary. Changing the main does not move
them. `small_model` is unsupported and removed.

Manual native OpenAI steps (unverified user step):

1. `opencode auth login` — target is optional; choose the OpenAI integration from the
   picker. Do not guess a provider argument.
2. `opencode models` — read the exact native catalog.
3. Make one real entitlement call on a candidate model.
4. Only after success, make an approved manual config change to persist that exact id.
5. Use `opencode auth list` or `opencode auth switch` to inspect or switch accounts.

A catalog entry is not an entitlement test. Do not invent a subscription model id or
promise automatic fallback.

## MCP status

Dated host/session evidence (2026-11-04, after a vault-backed restart): `fetch` ran one
eBay search (one listing), an Exa search (three results), and a TinyFish search (10
results); Context7 and gh_grep searches succeeded; Composio read a spreadsheet range
(A1:H2); and local Semble semantic search, a SQZ read, and a read-only Home Assistant
`llm__GetDateTime` call succeeded. A DuckDuckGo search was inconclusive (possible bot
detection or no results). These are dated host/session results, not universal guarantees.
Semble remains host-auto-detected; this change did not force-enable it or bypass its
explicit-disable/kill-switch handling.

- **Configured / available / verified** are distinct. "Configured" means an entry
  exists; "available" means policy-eligible (prerequisites and credentials present in
  the service environment, no active circuit); "verified" means a live call succeeded.
  `retrieval_control` reports these as `key_configured` / `connector_status`
  (`not_configured`, `configured_unverified`, `live_success_recorded`). Do not promote
  a connector on configuration alone.
- eBay: configured entry, conditionally available. Host initialization resolves the
  tracked placeholder and enables it only when the local project exists and both
  `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` are present in the service environment.
  A read-only eBay search returned one listing in this host/session (2026-11-04). That
  dated result is not a connector-health guarantee: the historical eBay errors
  (previously 108 retained errors) remain **undiagnosed**, so do not generalize one
  listing into broad eBay coverage.
- Composio: authenticated on this host/session (2026-11-04), where a read-only
  spreadsheet range read (A1:H2) succeeded. Old OAuth migration is not claimed. If it
  ever needs re-authentication, use `opencode mcp auth [<name>]` (name optional; choose
  Composio). A configured `COMPOSIO_CONSUMER_API_KEY` disables OAuth for the managed
  entry while set. Removing it restores the managed default OAuth entry only if no
  explicit host override (custom URL/headers, populated OAuth config, or disabled entry)
  changes that behavior. Consumer-key scope and access to pre-existing connections are
  unverified.
- Exa: conditional configuration requires `EXA_API_KEY`; connected on this host/session
  after a vault-backed restart (2026-11-04), where a live Exa search (three results) and a
  PDF read succeeded. This is dated host/session evidence, not a portability or permanence
  guarantee.
- Home Assistant: connected on this host/session after a vault-backed restart (2026-11-04);
  a live read-only `llm__GetDateTime` call succeeded. This is dated host/session evidence,
  not a portability or permanence guarantee.
- No credential values were read.

## Keys and accounts

- Exa: `EXA_API_KEY`; free account at `https://dashboard.exa.ai/api-keys`. Free plan is
  described as a recurring credit with no card and auto-recharge off. Do not guarantee
  this if a paid key is supplied; that account's billing applies.
- TinyFish: optional `TINYFISH_API_KEY` from
  `https://agent.tinyfish.ai/api-keys`. Keyless is supported locally under safeguards;
  vendor entitlement is unverified.
- OpenRouter: optional `OPENROUTER_API_KEY`, also accepted by the SOPS vault. Local
  installed `@opencode/ai` provider source uses it for bearer auth, but credential
  precedence over stored auth, service environment inheritance, provider routing and
  billing, and a live model request are unverified. It is API-billed and separate from
  ChatGPT subscription OAuth; it does not override or upgrade ChatGPT access.
- SOPS/age: on Windows the user-tested passphrase-protected identity, restored from a
  Bitwarden backup, decrypted the real vault. Linux interactive prompt behavior and
  end-to-end service restart inheritance remain unverified. A direct service launch
  preserves all ambient caller variables outside the documented allowlist and SOPS
  identity variables, so avoid launching from a shell that contains unrelated secrets.
  See `docs/secrets.md`.
- Use a masked prompt so a key never enters command history:

```powershell
$secure = Read-Host -AsSecureString "EXA_API_KEY"
$env:EXA_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

```bash
read -rs EXA_API_KEY && export EXA_API_KEY
```

Keys and host variables are read by the background service process, not retroactively by
a new TUI terminal. Set them in the shell or launcher that starts the service, then apply
them with an idle `opencode service restart` from that same environment. Reopening only
the TUI is insufficient. A config-only activation uses the verified `opencode reload`
instead. Do not create tracked `.env` files, dump auth stores, copy `auth.json` between
hosts, or enable automatic signups/payments.

## Host defaults

Host initialization adds Exa, Semble, eBay, and Home Assistant defaults **only when
those server entries are absent**. Explicit entries are preserved, including
`disabled: true` and custom commands/URLs, except the tracked eBay placeholder, which
is enabled only when its local project and both credentials exist.

- `opencode.host.example.jsonc` sets Semble `disabled: true` by default.
- `OPENCODE_DISABLE_SEMBLE=1` is a real one-way kill switch, including for an explicit
  enabled entry.
- Exa is enabled only with `EXA_API_KEY`. Connected on this host/session after a
  vault-backed restart (2026-11-04); a live Exa search (three results) and a PDF read
  succeeded. This is not a portability or permanence guarantee.
- Semble is enabled for a valid local project directory (env override or
  `~/mcp-servers/semble`) unless disabled by the kill switch.
- Home Assistant requires **both** `HA_MCP_URL` and `HA_BEARER_TOKEN`; there is no
  personal fallback URL. It is connected on this host/session after a vault-backed restart
  (2026-11-04); a live read-only `llm__GetDateTime` call succeeded. This is dated
  host/session evidence, not a portability or permanence guarantee.
- eBay requires a valid local project directory (`EBAY_MCP_DIR` or
  `~/mcp-servers/ebay`) **and** both `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` in the
  service environment. `OPENCODE_DISABLE_EBAY=1` is the one-way kill switch. Missing
  prerequisites leave the entry disabled and do not block startup.
- Header and credential values are used in memory only, never written to source or
  logs.

`opencode.private.local.json` is optional and not required for the connected Semble
instance on this host.

## Memory

Global memory is ignored and lives in `memory/`. It is read lazily through `AGENTS.md`
pointers, never by globbing. The protocol is in `docs/memory.md`. Only templates and
protocol docs are tracked; personal entries are never committed. No memory entry was
created by this activation.

## Verification

Safe checks that do not start/restart the service or read sessions:

```text
opencode --version
opencode --help
opencode stats --help
git status --short
git diff --stat
```

Loader/config verification is complete. Pending real model-turn, tool, and Code Mode
smoke checks are listed in `docs/verification.md`.

## Honest constraints

- No actual upstream wire provider, cost, subscription entitlement, or paid key is
  verified.
- `opencode stats` reports local/shareable usage, not vendor billing.
- Local TinyFish caps are protective counters, not a quota guarantee.
- Native OpenAI subscription access remains a manual check. Dated host/session evidence
  (2026-11-04, after a vault-backed restart) recorded successful eBay, Exa, TinyFish,
  Context7, and gh_grep searches; a Composio spreadsheet read; local Semble search; a SQZ
  read; and a Home Assistant `llm__GetDateTime`. A DuckDuckGo search was inconclusive.
  These are not universal guarantees.
- Old sessions keep old tools until reopened/attached through a new 2.2.5 client.
- Dynamic context pruning is a soft-nudge band, not a hard prune.
- No VM provisioning is part of this repository.
- Old checkpoint rollback is historical. Do not use 1.x config as a drop-in on 2.x;
  check downgrade and session compatibility first.

## Docs index

- `docs/architecture.md`
- `docs/retrieval.md`
- `docs/memory.md`
- `docs/setup.md`
- `docs/secrets.md`
- `docs/providers.md`
- `docs/portability.md`
- `docs/verification.md`
- `docs/upgrade-handoff.md`
- `docs/templates/`
