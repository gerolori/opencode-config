# Verification

## Commands

Run from `~/.config/opencode`:

```text
bun run typecheck
bun test
bun run preflight -- --config
```

Narrow checks after documentation-only changes:

```text
git status --short
git diff --stat
```

Native checks:

```text
opencode --version
opencode debug config
opencode stats
```

## What preflight verifies

`bun run preflight -- --config` is the environment contract:

- `runtime.present` — `opencode --version`.
- `bun.present` — Bun version.
- `node.present` — Node version.
- `package.sdk_pin` — `@opencode-ai/plugin` declared.
- `sdk.installed` — installed SDK version.
- `sdk.matches_pin` — installed SDK equals the pin.
- `lock.authoritative_bun` — `bun.lock` exists.
- `lock.package_lock_not_tracked` — `package-lock.json` is not tracked.

With `--config`, it also parses `opencode debug config` and reports only top-level key
presence and compaction keys. It never prints secret values.

Expected healthy snapshot on this host:

```text
runtime 1.19.5, sdk_pin 1.19.5, sdk_installed 1.19.5
bun 1.3.9, node v25.6.1
runtime_matches_sdk true
```

A warning about `package-lock.json` existing but being ignored is expected; `bun.lock`
remains authoritative.

## Typecheck

`tsconfig.json` includes `tests/**/*.ts`, `scripts/**/*.ts`, and `plugins/**/*.ts`.
`lib/` is exercised through tests. Removing the dead `.opencode/` telemetry assets does
not affect this include set.

## Tests

`bun test` runs the retrieval policy, TinyFish adapter, sqz compressor/plugin, config,
permissions, and smoke suites. Tests use injected clocks, filesystems, clients, and
fetch implementations where applicable; they must not perform live vendor calls.

## Native usage

`opencode stats` shows token and cost statistics:

```text
opencode stats [--days N] [--tools N] [--models [N]] [--project ""]
```

There is no native in-session token tool. Do not describe local plugin counters as
native stats or as vendor billing.

## Manual checks

- `opencode debug config` shows the resolved config.
- Confirm the intended MCP entries are enabled and no credential value is printed.
- Confirm `OPENCODE_CONFIG` (if used) actually merged the host overlay.
- Confirm `sqz` is on `PATH` if the sqz MCP is expected to start.
- Confirm Exa is enabled only when `EXA_API_KEY` is set.
- Confirm TinyFish is unavailable without `TINYFISH_API_KEY` and does not affect
  offline work.

## What is not verified

- Upstream provider identity, plan, or billing for a configured model.
- Exa/TinyFish free-tier terms beyond local caps.
- ChatGPT Plus/Pro entitlement until a real call is made.
- Host-specific paths on other machines.
- Automatic loading of `opencode.private.local.json`.

## Failure handling

If the same verification command fails twice, stop and report the error instead of
retrying blindly. Keep changes small and reversible; restore only reviewed paths.
