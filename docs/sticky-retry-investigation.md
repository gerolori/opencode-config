# opencode-sticky-retry: bounded investigation

Status: **static investigation only — not installed, not live tested.**

This note records a bounded review of the public `opencode-sticky-retry` plugin
(v0.3.0) against the installed OpenCode 2.2.5 plugin loader. It is documentation of
findings and open questions, not an implementation plan and not a recommendation to
deploy the plugin.

## Scope and method

- Read the public repository and `src/backoff.ts` at v0.3.0.
- Compared the plugin's export/interface shape with the installed
  `@opencode-ai/plugin` 2.2.5 loader contract.
- No network calls, no credential or vault access, no service restart, no session
  read, and no push were performed for this note.
- No live provider request, quota test, or process-restart test was run.

## Findings

### 1. Plugin interface mismatch (likely static incompatibility)

v0.3.0 uses the legacy `@opencode-ai/plugin` async interface. The installed 2.2.5
loader expects a default export carrying an `id` plus `setup`/`effect` (the 2.x
plugin shape). On static inspection the two contracts do not match, so the plugin is
**likely incompatible** with the 2.2.5 loader.

This is a static conclusion. It was not confirmed by loading the plugin in a live
2.2.5 process, and no compatibility shim was written or tested.

### 2. Global `fetch` patch

The plugin patches the global `fetch`. That is process-wide: it can affect requests
made by other plugins, tools, and provider clients in the same process, not only the
retry path it targets. Any future evaluation must treat this as a broad blast radius
and test for interference, not just retry behavior.

### 3. `Retry-After` is capped by `maxDelayMs`

`src/backoff.ts` honors `Retry-After`, but the resulting delay is bounded by the
configured `maxDelayMs`. A server-supplied wait longer than that cap is therefore
shortened. The cap is protective, but it means the plugin does not necessarily wait
as long as the server asked.

### 4. Quota classification is uncertain

The source does not establish a reliable distinction between transient throttling and
a hard quota/access denial. Classification of quota responses is **uncertain** from
static reading alone. This matters because retrying a quota or access wall is exactly
the behavior this configuration avoids.

### 5. Process-restart durability is unknown

Whether retry state survives a process restart is **not established** by the reviewed
source. No restart test was run. Do not assume durable retry state across restarts.

## Built-in model retry (for comparison)

The built-in model retry path honors `Retry-After` subject to a 15-minute cap and is
bounded. This is a static reading, not a live observation. It is noted only as a
baseline for comparing the plugin's behavior; it is not a claim that the built-in path
covers the same cases.

## Constraints and non-goals

- Do not use this plugin, or any retry mechanism, to bypass access controls, quota, or
  authentication walls.
- Do not run unattended infinite retries. Any retry must be bounded and observable.
- Do not treat the global `fetch` patch as isolated to one provider.
- Do not assume restart durability or accurate quota classification without tests.

## Suggested future work (isolated, simulated)

If this is pursued, keep it isolated from the live service and real providers:

1. Loader-contract test: confirm whether a 2.2.5-shaped wrapper can load the v0.3.0
   logic, or whether a port is required.
2. Mocked `fetch` tests with fake timers: verify `Retry-After` handling, the
   `maxDelayMs` cap, and bounded retry counts.
3. Quota/access classification tests: feed representative 429/403/quota bodies and
   assert that hard denials are not retried.
4. Restart-durability test in a disposable process: determine what state, if any,
   survives.
5. Interference test: confirm the global `fetch` patch does not alter unrelated
   requests in the same process.

No live provider, quota, or credential test is part of this proposal.

## Sources

- Repository: <https://github.com/ronanhansel/opencode-sticky-retry>
- Backoff source: <https://raw.githubusercontent.com/ronanhansel/opencode-sticky-retry/main/src/backoff.ts>
  (branch `main` assumed; confirm the tag/branch for v0.3.0 before relying on line-level
  details)

## Evidence summary

| Claim | Basis | Confidence |
| --- | --- | --- |
| v0.3.0 uses legacy async plugin interface | static source read | high |
| 2.2.5 loader requires default `id` + `setup`/`effect` | installed SDK/loader inspection | high |
| Static incompatibility likely | contract comparison | medium-high, not live tested |
| Patches global `fetch` | static source read | high |
| `Retry-After` capped by `maxDelayMs` | `src/backoff.ts` | high |
| Quota classification uncertain | static source read | open question |
| Restart durability unknown | no test performed | unknown |
| Built-in retry honors `Retry-After`, 15m cap, bounded | static reading | medium, not live |
