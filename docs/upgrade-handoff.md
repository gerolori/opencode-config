# OpenCode 2.2.5 activation handoff

Status: **ACTIVATED at loader/config level**.

One `opencode reload` was applied. The existing 2.2.5 background service (PID 41900)
stayed up unchanged. No restart, migration, search/model call, auth, session read, or
push was performed by that activation. Both idle checks returned 0.

This handoff records loader/config verification. Connector/tool checks were observed in
this session after a vault-backed restart (see below). Real model-turn and Code Mode
contract smoke checks remain pending, along with the manual OpenAI step below.

## Observed activation

- Runtime/service: `@opencode/cli` 2.2.5, existing service PID 41900 unchanged.
- SDKs: `@opencode/plugin`, `@opencode/schema`, `@opencode/client` 2.2.5.
- `bun.lock` authoritative.
- Active exactly once each:
  - local `plugins/retrieval-policy.ts` — id `retrieval-policy`
  - local `plugins/sqz.ts` — id `sqz`
  - `@tarquinen/opencode-dcp@3.2.0` — id `opencode-dcp`
  - `cc-safety-net@2.7.2`
- No failed custom plugins.
- `plugins.v2-staging/` removed.
- `plugins.1x-disabled/` archive retained and not loaded.
- Local entries are not also listed in config.
- Tests, typecheck, and config/service preflight were green at activation. The test
  count is an activation snapshot, not a future guarantee.

## Plugin behavior

- `opencode-dcp` 3.2.0 keeps the existing `dcp.jsonc` shape. Min/max is a soft-nudge
  band, not hard prune.
- SQZ is output-only in the native `execute.after` path. It preserves structured shell
  output and exit metadata, compresses model-visible successful content, never rewrites
  commands, and falls back on a hard deadline.
- SQZ MCP remains; do not add RTK or a second compressor.
- The primary allows `compress`, `customize-opencode`, and `todowrite`; it needs
  `compress` for SQZ.
- The remaining legacy optional plugins stay disabled: table formatter, smart title,
  unmoji. No native replacement is claimed to restore their functionality.
- `notification-ntfy` is a new opt-in 2.x local plugin that restores phone
  notifications on root-session idle (completion), errors, and permission asks.
  It is disabled unless `NTFY_URL` is present in the service environment. See
  `docs/notifications.md`.

## Native provider catalog and TinyFish

The native catalog still lists `exa`, `firecrawl`, `parallel`, `tavily`, and `tinyfish`.
It is not restricted or reduced.

- The public promise adapter exposes only `add` and `default` — not `list` or `remove`.
- The plugin discovers TinyFish through `websearch.providers` and pins the supported
  default with `default.set('tinyfish')`.
- It does **not** remove the other native providers.
- The native builtin tool accepts only `query`; explicit overrides are denied.
- A wrong-provider result or error disables native search without poisoning TinyFish.
- A real `fromPromise` adapter test exists.
- The custom TinyFish HTTP adapter was removed.
- `TINYFISH_API_KEY` is optional; keyless is supported under local safeguards.
- A live TinyFish search succeeded in this session (10 results); vendor keyless allowance
  remains unverified.
- Local caps (30/minute, 500/hour, 12,000/day) are protective counters, not a quota
  promise.

## Code Mode

- Code Mode leaves shared outer IDs.
- Identity queues handle normal and permission-reply cleanup while retaining sibling
  outcomes.
- Raw `fetch` is blocked; page reads must use the governed `webfetch`.
- A direct/plain permission reject can emit no after hook.
- Cleanup uses permission events plus TTL fallback and hard interrupt.

## MCP status

Host/session evidence observed in this session after a vault-backed restart: `context7`,
`gh_grep`, `Semble`, and `SQZ` connected and ran a search/read successfully; eBay, Exa,
and TinyFish searches succeeded; Composio read a spreadsheet range (A1:H2); and Home
Assistant `llm__GetDateTime` succeeded. A DuckDuckGo search was inconclusive (possible bot
detection or no results). These are host/session results, not universal guarantees.

- eBay is enabled (conditionally available): the host transform force-disables it when its
  local project or credentials are missing. A read-only search returned one listing;
  historical errors remain undiagnosed.
- Composio is authenticated on this host/session; a read-only spreadsheet
  range read (A1:H2) succeeded. Old OAuth migration is not claimed.
- Exa requires `EXA_API_KEY`; connected on this host/session after a vault-backed restart,
  where a live Exa search (three results) and a PDF read succeeded. This is host/session
  evidence, not a portability or permanence guarantee. Home Assistant is also connected on
  this host/session after a vault-backed restart; a live read-only `llm__GetDateTime` call
  succeeded and returned 2026-11-03 21:40 CET. That is host/session evidence, not a
  portability or permanence guarantee.
- No credential values were read.

## Host defaults

Host initialization adds Exa, Semble, and Home Assistant only when the corresponding
entries are absent.

- `opencode.host.example.jsonc` sets Semble `disabled: true` by default.
- `OPENCODE_DISABLE_SEMBLE=1` is a real one-way kill switch, even for an explicit
  enabled entry.
- Otherwise explicit entries, including `disabled: true` and custom fields, are
  preserved.
- Exa requires `EXA_API_KEY`.
- Semble requires a valid local project directory or `~/mcp-servers/semble`, unless the
  kill switch is set.
- Home Assistant requires both `HA_MCP_URL` and `HA_BEARER_TOKEN`; no personal fallback.
- eBay is enabled; the host transform force-disables it when its local project or
  credentials are missing.
- Headers stay in memory, never source or logs.

## Credentials and UI files

- `cli.json` is deliberately tracked; it is public UI configuration only.
- `service.json` / `service.jsonc` are ignored and unprinted. Never commit, print, or
  copy them.
- Historical `tui.json` is untouched and not assumed to be the active location.
- `auth.json` is never copied between hosts.
- No automatic signups or payments are performed.

## Manual commands still pending

Composio MCP authentication:

```text
opencode mcp list
opencode mcp auth [<name>]
```

`<name>` is optional; choose Composio from the picker. Do not claim the old OAuth was
migrated.

Native OpenAI login and model selection:

```text
opencode auth login [<target>]
opencode models
opencode auth list [--format default|json]
opencode auth switch [<target>] [<credential>]
```

`<target>` is optional and must not be guessed. Read the exact catalog, make one real
entitlement call, then make an approved manual config change to persist the exact id.
Do not fabricate a subscription model id or promise fallback.

Exa and TinyFish live searches succeeded in this session (see above). The strong main
remains on OpenRouter `gpt-6-luna` (`openai/gpt-6-luna`, high) until the native OpenAI
handoff succeeds. No actual wire provider, entitlement, cost, or billing test has been
performed.

## Pending runtime smoke

- [ ] Real model turn on the configured strong main.
- [ ] Real model turn after native OpenAI login and model selection.
- [x] Governed retrieval tool call, not just loader config (observed in this session).
- [ ] Code Mode smoke: shared outer IDs, identity queues, permission-reply cleanup,
      sibling outcomes retained.
- [ ] Raw Code Mode `fetch` blocked and governed `webfetch` succeeds.
- [x] Native TinyFish live search, keyed and/or keyless as available (observed in this
      session).
- [x] Keyed Exa live search (observed in this session).
- [x] Composio MCP authentication and one workflow (observed in this session; read-only
      spreadsheet).
- [ ] Old session reopened/attached through a new 2.2.5 client.
- [ ] Real wire provider, entitlement, cost, and billing observation.

## Rollback

Old checkpoint rollback is historical. Do not use 1.x config as a drop-in on 2.2.5.
Check downgrade and session compatibility first, then restore only reviewed Git
checkpoints. Do not copy auth or service credentials between hosts. See
`docs/portability.md`.
