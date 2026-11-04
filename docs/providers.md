# Providers and authentication

## Strong main

The strong primary stays on the configured OpenRouter custom-key route:

```text
provider: openrouter
model:    gpt-6-luna
wire id:  openai/gpt-6-luna
variant:  high reasoning
```

Loader/config activation is complete. The actual upstream wire provider, routing,
entitlement, cost, and billing are **not verified** until a real request is made. Do not
present the configured model name as a measured provider or billing fact.

`build` and `plan` are the only user-selectable primaries; `general` is absent.

Sampling is intentionally left unpinned for `build` and `plan`: their config sets a
reasoning variant (currently `high`) and no `request.body` override, so no explicit wire
`temperature`/`top_p` is sent. Reasoning-effort models can reject or ignore an explicit
`temperature` when reasoning effort is not `none`; omitting it lets the provider/model
apply a valid default. The six workers keep their independent low-reasoning pins and
per-agent `temperature` overrides. This does not describe or verify an interactive model
swap: if a primary's model is changed manually, the temperature omission still applies,
but OpenRouter or the upstream provider may strip, translate, or reject fields, and the
live wire body is **not verified**.

### OpenRouter credential route

`OPENROUTER_API_KEY` is optional. Local installed `@opencode/ai` source
(`dist/providers/openrouter.js`) calls
`AuthOptions.bearer(input, "OPENROUTER_API_KEY")`, so an environment-variable route is
supported by that source. It can be delivered through the SOPS vault
(`docs/secrets.md`). This tree does **not** verify that the environment key takes
precedence over stored `opencode auth` credentials, that the restarted background
service inherits it, or that OpenRouter routing, billing, and a live model request use
it. The key is API-billed and separate from ChatGPT subscription OAuth; it does not
override or upgrade ChatGPT access.

## Native OpenAI handoff

Native OpenAI/ChatGPT subscription access is a manual, unverified user step. Use only
the verified 2.2.5 CLI forms:

```text
opencode auth login [<target>]
opencode models
opencode auth list [--format default|json]
opencode auth switch [<target>] [<credential>]
```

`<target>` is optional. Do not guess a provider argument or reuse a 1.x form.

1. Run `opencode auth login` and choose the OpenAI integration from the picker.
2. Complete the browser flow.
3. Read the exact catalog with `opencode models`.
4. Do not guess or invent a model id.
5. Make one real entitlement call on a candidate model.
6. Only after success, make an approved manual config change that persists that exact
   id.

Rules:

- A catalog entry is not proof of entitlement; only a real call proves access.
- Do not claim a subscription was verified before the user completes this flow.
- Do not fabricate a subscription model id or promise automatic fallback.
- Until the handoff succeeds, the strong main remains on the OpenRouter route above.
- An already-open session keeps its old toolset until reopened/attached through a new
  2.2.5 client.

## Worker models

The six workers (`code`, `review`, `explore`, `fetch`, `track`, `composio`) are pinned
to cheap low-reasoning models. Their pins are independent of the primary. Changing the
main model does not move them.

Do not change a pinned child model on resume unless the actual 2.x behavior is
explicitly verified. `small_model` is unsupported in native config and removed.

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

TinyFish:

- The custom TinyFish HTTP adapter was removed.
- Optional `TINYFISH_API_KEY`; keyless is supported under local safeguards.
- A live TinyFish search succeeded on this host/session (10 results); vendor keyless
  allowance and keyed entitlement remain unverified.
- Local protective counters: 30/minute, 500/hour, 12,000/day. These are guards, not a
  quota promise.
- Key page: `https://agent.tinyfish.ai/api-keys`.

## Exa

- Keyed native Exa MCP only, and only with `EXA_API_KEY`.
- Current observed status on this host: connected after a vault-backed restart; a live Exa
  search (three results) and a PDF read succeeded. This is host/session evidence, not a
  portability or permanence guarantee.
- Key page: `https://dashboard.exa.ai/api-keys`.
- Free plan: recurring credit, no card, auto-recharge off.
- Do not claim the free arrangement is guaranteed for a paid key; that account's
  billing applies.
- Paid or unbounded Exa products are denied by retrieval policy.

## eBay

- Local, read-only eBay Browse API server for `EBAY_IT`; tools are
  `ebay_search_listings`, `ebay_price_summary`, and `ebay_get_item`.
- Only `fetch` may call them. They are budgeted as external retrieval:
  `search_listings` and `price_summary` consume one search; `get_item` consumes one
  read. Unknown `ebay_*` tools fail closed.
- Requires a valid local project (`EBAY_MCP_DIR` or `~/mcp-servers/ebay`) and both
  `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` in the service environment.
- Status: configured and conditionally available. A read-only search returned one listing
  on this host/session. Historical eBay errors remain undiagnosed; do not generalize one
  such result into a connector-health claim. No account action was performed.

## Composio

- MCPs connected/observed at activation: `context7`, `DuckDuckGo`, `gh_grep`, `Semble`,
  `SQZ`; a DuckDuckGo search was inconclusive (possible bot detection or no results).
- eBay is configured, conditionally available, and returned one listing on a read-only
  search.
- Composio is authenticated on this host/session; a read-only spreadsheet
  range read (A1:H2) succeeded. Old OAuth migration is not claimed.
- Manual re-authentication command: `opencode mcp auth [<name>]` with the optional name;
  choose Composio.
- When `COMPOSIO_CONSUMER_API_KEY` is set, the managed entry uses
  `x-consumer-api-key` and `oauth: false`; OAuth is disabled while the key remains
  configured. Removing the key restores the managed default OAuth entry only if no
  explicit host override changes that behavior. Custom URLs, extra headers, populated
  OAuth settings, or a disabled entry are preserved and may prevent restoration.
- Consumer-key user/project scope, access to existing connections, and whether MCP
  editor changes can persist outside the in-memory effective config are **unverified**.

## API fallback and credentials

- Do not promise automatic failover between native OpenAI subscription access and any
  API-key path.
- Do not maintain duplicate credentials for the same provider.
- Never copy `auth.json`, `service.json`, `service.jsonc`, or other auth/service
  credential files between hosts.
- Enter keys with the masked flow in `docs/setup.md`. Keys and host variables must reach
  the background service's launch environment; reopening only the TUI does not update the
  running service. Apply them with an idle `opencode service restart` from the configured
  shell. A config-only activation uses the verified `opencode reload` instead.
- No automatic signups or payments are performed by this setup.
- `cli.json` is deliberately tracked public UI configuration; `service.json` /
  `service.jsonc` are ignored and unprinted.

## What must not be claimed

- That a subscription or entitlement was verified when it was not.
- That a paid key or plan exists when it was not observed.
- That a configured model maps to a specific upstream provider without a real call.
- That `opencode stats` is vendor billing.
- That local TinyFish caps guarantee available vendor quota.
- That the old Composio OAuth migrated or is connected.
- That Exa or Home Assistant is connected while its env prerequisites are missing.

## Comparing models

Do not run a benchmark campaign. Compare normal tasks using runtime, cache behavior,
reasoning, cost, retries, and success. Only real calls can validate routing or billing.
