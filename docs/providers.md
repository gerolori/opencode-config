# Providers and authentication

## Interactive ChatGPT orchestration

The intended strong-orchestrator flow in the TUI:

```text
/connect -> OpenAI -> ChatGPT Plus/Pro -> browser
```

After authentication:

1. Use `/models` and read the exact available native OpenAI catalog.
2. Do not guess or invent a model ID.
3. Test entitlement on one model the user actually has, then choose the main
   orchestrator model.

Caveats:

- A catalog entry is not an entitlement test. Only a real call proves access.
- Until the browser flow succeeds, the API path remains the default.
- The browser flow and `/models` behavior are TUI features; confirm them in the
  running 1.19.5 client rather than assuming older behavior.

## Worker models

Worker agents stay on OpenRouter. They are explicitly pinned in `opencode.jsonc`:

- `code`, `review`, `composio`: `openrouter/deepseek-v4.1-flash-1017` (low reasoning).
- `explore`, `fetch`, `track`: `openrouter/deepseek-v4.1-flash` (low reasoning).

The pins describe intended weights and low reasoning options. Actual upstream
provider selection, caching behavior, and cost are not validated until a call is made.
Do not present configured names as measured wire-provider or billing facts.

## API fallback

A manual API-key path exists for OpenAI. Rules:

- Do not maintain duplicate credentials for the same provider.
- Do not promise automatic failover between ChatGPT auth and the API key.
- Never copy `auth.json` between hosts.
- If a key is used, enter it with the masked flow in `docs/setup.md`.

## Exa

- Base MCP entry: disabled, `oauth: false`, header
  `x-api-key: {env:EXA_API_KEY}`.
- The retrieval plugin enables it only when `EXA_API_KEY` is non-empty.
- Key page: `https://dashboard.exa.ai/api-keys`.
- Free plan: recurring credit, no card, no automatic recharge.
- Do not claim that free arrangement is guaranteed if the user supplies a paid key;
  that account's terms and billing apply.
- Exa retrieval tools are classified `free_tier_then_paid`. Paid/unbounded Exa
  products are denied by policy.

## TinyFish

- Not a native MCP server in OpenCode 1.19.5.
- The only integration is the custom `tinyfish_search` tool.
- Key: `TINYFISH_API_KEY` from `https://agent.tinyfish.ai/api-keys`.
- Direct endpoint: `GET https://api.search.tinyfish.ai`.
- Free-only local caps: 30/minute, 500/hour, 12,000/day.
- Snippets only. No TinyFish Agent, Browser, MCP, or wallet usage.
- Re-check quotas and plan terms with the vendor; they can change.

## What must not be claimed

- That a subscription was verified when it was not.
- That a paid key or plan exists when it was not observed.
- That a configured model maps to a specific upstream provider without a call.
- That aggregate quality or cost figures apply per task. Any aggregate (for example
  85.1%) is aggregate.
- That a tool attempt equals a vendor-billed request. Local counts are attempts.

## Comparing models

Do not run a benchmark campaign. Compare the next normal tasks instead, using:

- runtime
- cache hits
- fresh tokens
- reasoning effort
- cost
- retries
- success

One real task is better evidence than a synthetic sweep, and only calls can validate
provider routing or billing.
