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
- No vendor keyless allowance and no live success has been verified.
- Local protective counters: 30/minute, 500/hour, 12,000/day. These are guards, not a
  quota promise.
- Key page: `https://agent.tinyfish.ai/api-keys`.

## Exa

- Keyed native Exa MCP only, and only with `EXA_API_KEY`.
- The Exa MCP entry is currently absent because the environment prerequisite is not met.
- Key page: `https://dashboard.exa.ai/api-keys`.
- Free plan: recurring credit, no card, auto-recharge off.
- Do not claim the free arrangement is guaranteed for a paid key; that account's
  billing applies.
- Paid or unbounded Exa products are denied by retrieval policy.

## Composio

- Connected MCPs at activation: `context7`, `DuckDuckGo`, `gh_grep`, `Semble`, `SQZ`.
- eBay is disabled.
- Composio **needs authentication** under 2.2.5. Old OAuth is not claimed migrated or
  connected.
- Manual command: `opencode mcp auth [<name>]` with the optional name; choose Composio.

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
