# Retrieval policy

## Scope

External retrieval is restricted to the `fetch` agent. `fetch` is budgeted by the
retrieval policy plugin and its implementation. The plugin makes no MCP calls itself;
it governs the normal tools the agent calls, enforces caps/circuits/roles, and returns
advisory `allowedNextProviders`.

The plugin is **not** a network sandbox and is **not** a general automatic-memory
detector.

## `retrieval_control`

```text
retrieval_control({
  action: "status" | "extend" | "reset_provider",
  session_id?: string,
  provider?: "duckduckgo" | "tinyfish" | "exa" | "gh_grep" | "context7" |
             "builtin_webfetch" | "semble" | "ebay"
})
```

- `status` — caller's own session by default. A `build` / `plan` parent may target a
  direct child. `fetch` may call only `status`. `available` / `key_configured` are
  policy eligibility, not a live connector check; `connector_status` is one of
  `not_configured`, `configured_unverified`, `live_success_recorded` (a recorded
  successful call exists; still not a current health probe). The report also carries
  `availability_note=policy_eligibility_not_live_connector_health`.
- `extend` — root `build` / `plan` only, direct child only, once. Grants +3 searches
  and +3 reads. Self-targets, non-children, unknown sessions, and repeats are refused.
- `reset_provider` — root `build` / `plan` only. Requires one of the named providers.
  Clears cooldown, operator-required state, last error category, and consecutive
  failures. It preserves TinyFish rate counters, provider totals, resource blocks, and
  every session budget. A `fetch` child cannot reset or self-extend.
- The result marks attempt counts as local, not vendor billing.

## Native catalog and TinyFish

The native provider catalog still lists `exa`, `firecrawl`, `parallel`, `tavily`, and
`tinyfish`. This config does not restrict or remove those entries.

- The public promise adapter exposes only `add` and `default` — not `list` or `remove`.
- The plugin discovers TinyFish through `websearch.providers` and pins the supported
  default with `default.set('tinyfish')`.
- It does not remove the other native providers.
- The native builtin tool accepts only `query`; explicit provider overrides are denied.
- A wrong-provider result or error disables native search without poisoning TinyFish.
- A real `fromPromise` adapter test exists.
- The custom TinyFish HTTP adapter was removed.

TinyFish specifics:

- Optional `TINYFISH_API_KEY`.
- Keyless is supported under local safeguards.
- No vendor keyless allowance or live success is verified.
- Local protective counters: 30/minute, 500/hour, 12,000/day. These are guards, not a
  quota promise.

Key page: `https://agent.tinyfish.ai/api-keys`.

## Budgets

Per child `fetch` assignment:

- 3 searches
- 3 page reads

One `build` / `plan`-approved extension adds 3 and 3, then the child resumes.

Blocked attempts count against the budget intentionally. `status.remaining` is clamped
at zero and never reports a negative remainder.

## Provider order

At most 2 distinct providers are allowed per normalized query/URL. Provider order is
**advisory**: the policy returns suggested next providers, but the agent executes the
normal tools and the policy enforces caps, circuits, and role.

- General discovery: DuckDuckGo, then native TinyFish.
- Semantic: keyed Exa MCP, then one healthy alternative.
- Page reads: governed `webfetch`.

## Query and retry durability

- Per-assignment provider sets are hashed and durable in the session state.
- One bounded transient retry is tracked durably across process restarts.
- Governance TTL is 24 hours, bounded to 32 query-provider records and 16 retry
  records per session. The 3/6 budgets persist independently.
- Maximum 2 providers per normalized query/URL.
- No auth, quota, access-denial, or CAPTCHA retry loops. Only one bounded transient
  retry is allowed.

## Reads and batches

- A valid batch counts one read per URL.
- At most 3 reads are allowed per call; over-budget batches are rejected, not truncated.
- An invalid/malformed batch costs one blocked attempt.
- Opaque expansion tokens are denied because the policy cannot verify the target URL.
  This includes opaque DuckDuckGo expand tokens.
- Page reads must use the governed `webfetch`.

## Blocked resources and errors

- A normal read `403` or CAPTCHA blocks that URL, not the whole provider.
- Other URLs remain eligible.
- Do not switch extractors for a blocked URL while the block is active.
- Errors are classified only from structured tool error metadata, not generic page
  prose.

## Code Mode

Code Mode leaves shared outer IDs. Identity queues handle normal and permission-reply
cleanup while retaining sibling outcomes.

- The outer `execute` is not counted as a search or read.
- Each governed MCP leaf is counted.
- Raw Code Mode `fetch()` is blocked by the permission guard; page reads must use the
  governed `webfetch`.
- A direct/plain permission reject can emit no after hook.
- Cleanup uses permission events plus TTL fallback and hard interrupt.

## State

Metadata-only state:

- `state.json` — budgets, circuits, hashed provider/retry records, hashed blocked URLs.
- `events.jsonl` — bounded metadata event log.

Location:

```text
$XDG_STATE_HOME/opencode/retrieval
# or
~/.local/share/opencode/retrieval
```

Safety properties:

- Atomic, locked reload → mutate → save across processes.
- Live PID locks are not stolen; stale locks are bounded; contention fails closed.
- Directories use `0700` and files `0600` where the platform supports it; this is
  best-effort on Windows.
- Events contain no queries, URLs, raw arguments, raw session IDs, page content, or
  secrets.
- State is outside Git and per-host, not a shared cache.

## Exa

- Keyed Exa MCP only. Requires `EXA_API_KEY`.
- The Exa MCP entry is currently absent because the environment prerequisite is not met.
- Key page: `https://dashboard.exa.ai/api-keys`.
- Free plan: recurring credit, no card, auto-recharge off.
- Do not claim the free arrangement is guaranteed for a paid key; that account's
  billing applies.
- Paid or unbounded Exa products are denied by policy.

## eBay

- Only `fetch` may call `ebay_*`; it is denied globally and allowed only for `fetch`.
- `ebay_search_listings` and `ebay_price_summary` each consume one search;
  `ebay_get_item` consumes one read. Cost class is `free_bounded` (eBay API quota),
  not an unlimited bypass.
- A per-item denial on `get_item` blocks that item key; a search-level denial cools the
  eBay provider circuit. Auth/quota classification uses the same rules as other
  external providers.
- eBay is not part of the general provider order; it is used only when an assignment is
  explicitly about eBay listings. Unknown `ebay_*` tools are denied by default.
- Credentials present makes eBay policy-eligible (`available`, `key_configured`), but
  `status` reports `connector_status=configured_unverified` until a successful call is
  recorded. Do not read that as proof the MCP server is connected.

## Denials and limits

- Native web search with an unknown/paid/unbounded backend is denied.
- Unclassified tools from known retrieval namespaces are denied by default.
- Paid or unbounded Exa research products are denied.
- Remote git/HTTP references are rejected for local Semble.
- The plugin cannot detect every possible retrieval tool; known namespaces fail closed.

## Memory boundary

Retrieval failure counts and provider health are operational telemetry. They are not
memory candidates, and no plugin here classifies or auto-writes lessons. Memory capture
remains the prompt and human approval workflow in `docs/memory.md`.
