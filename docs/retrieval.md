# Retrieval policy

## Scope

External retrieval is restricted to the `fetch` agent. `fetch` is budgeted by
`plugins/retrieval-policy.ts` and its implementation under `lib/retrieval/`. The
plugin makes no MCP calls itself; it registers two custom tools and gates the
MCP-backed tools that other configs expose.

## Custom tools

### `retrieval_control`

```text
retrieval_control({ action: "status" | "extend", session_id?: string })
```

- `status` returns limits, remaining budget, blocked counts, provider availability,
  provider cost class, suggested next providers, persistence health, and an optional
  runtime usage snapshot.
- `status` defaults to the caller's session. A `build` / `plan` parent may name a
  direct child.
- `extend` is `build` / `plan` only. It requires a direct child `session_id`, grants
  +3 searches and +3 reads once, and refuses self-targets, non-children, unknown
  sessions, and repeated extensions.
- The result marks attempt counts as local, not vendor billing.

### `tinyfish_search`

```text
tinyfish_search({ query: string, max_results?: number })
```

- `query` is 1–2000 characters.
- `max_results` is 1–5; the default is 5.
- Only the `fetch` agent may call it; other agents get an error.
- The adapter performs a direct `GET https://api.search.tinyfish.ai` with an
  `X-API-Key` header from `TINYFISH_API_KEY`.
- It returns `{ url, title, snippet }` records with `evidence_type=snippet`.
- It never calls TinyFish Agent, Browser, MCP, or wallet APIs.
- Timeouts default to 8s and are capped at 15s. Responses are capped at 256 KiB.
- It never fetches full pages.

## Budgets

Per child `fetch` session:

- 3 searches
- 3 page reads

A single extension adds 3 and 3. The parent calls `retrieval_control` with
`action=extend` and the child's session ID, then resumes the child. Budgets are
per-session, persisted locally, and reset with a new session.

## Provider order

At most two distinct providers are allowed per normalized query. Candidate lists are
intentionally finite so a failure cannot turn into a tour of every free service.

- General search: DuckDuckGo, TinyFish, gh_grep, Context7, Exa.
- Semantic search: Exa, DuckDuckGo, TinyFish, gh_grep, Context7.
- Page reads: built-in `webfetch`, DuckDuckGo, Exa.

In practice: DuckDuckGo first, TinyFish next if DuckDuckGo is unavailable or weak;
semantic queries prefer Exa and then one healthy alternative.

## Denials

- Native `websearch` and `websearch_cited` are denied by default because the backend
  is unknown, possibly paid, and unbounded.
- Paid or unbounded Exa products (company research, LinkedIn search, deep researcher)
  are denied.
- Unclassified tools from known retrieval namespaces are denied by default.
- Remote git/HTTP URLs passed to local Semble `repo` are rejected.
- Only one transient retry is allowed; auth, quota, CAPTCHA and access-denial failures
  are reported, not retried or bypassed.
- A blocked URL stays blocked while the block is active; switching extractors does not
  bypass it.

## Provider failures

Failures are classified as `auth`, `quota`, `captcha`, `access_denied`, `transient`,
or `unknown`. The engine opens provider circuits and records metadata only.

Persistence is fail-closed for external retrieval: if state cannot be saved, external
calls are denied rather than silently resetting budgets.

## State

Metadata-only state:

- `state.json` — session budgets, provider circuits, hashed blocked resources.
- `events.jsonl` — bounded event log.

Location:

```text
$XDG_STATE_HOME/opencode/retrieval
# or
~/.local/share/opencode/retrieval
```

Session IDs and blocked resource keys are hashed. The state is operational, outside
Git, and not shared between hosts.

## TinyFish

TinyFish is not a native MCP server in OpenCode 1.19.5. The custom tool is the whole
integration.

- Key: `TINYFISH_API_KEY` from `https://agent.tinyfish.ai/api-keys`.
- Free plan caps enforced locally: 30/minute, 500/hour, 12,000/day.
- Snippets only; no full-page extraction, no TinyFish Agent or Browser.
- Free-tier terms can change; re-check the vendor dashboard.

## Exa

- Base config: `enabled: false`, `oauth: false`,
  `headers: { "x-api-key": "{env:EXA_API_KEY}" }`.
- The plugin's `config` hook sets `enabled` to whether `EXA_API_KEY` is non-empty and
  keeps `oauth` false. It never writes the key.
- Key page: `https://dashboard.exa.ai/api-keys`.
- Free plan is described as a recurring credit with no card and no automatic recharge.
  Do not guarantee that if the user brings a paid key.
- Exa tools are `free_tier_then_paid`; paid-tier behavior is the account owner's
  responsibility.

## Other providers

- `context7` — library/API documentation, free.
- `gh_grep` — public code search, free.
- `duckduckgo` — general search and page reads, free.
- Built-in `webfetch` — page reads, free.
- `semble` — local code retrieval for `explore` only, never external.

## Limitations

- Budget and circuit counts are local attempts, not vendor-side quotas or invoices.
- The plugin cannot detect every possible retrieval tool; it fails closed for known
  namespaces and common web-search names.
- Provider ordering is a preference, not a guarantee. Availability, keys, and
  circuits determine what actually runs.
- The plugin has no memory feature. Retrieval failure counts are not memory
  candidates and must not be treated as an automatic lesson detector.
