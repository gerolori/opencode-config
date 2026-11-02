# Portability and rollback

## Canonical location

```text
~/.config/opencode
```

On Windows this host uses:

```text
C:\Users\hermes\.config\opencode
```

Git remote:

```text
https://github.com/gerolori/opencode-config.git
```

Never clone over an existing directory. Check out beside it and merge deliberately.

## Baseline and rollback

- Baseline config commit: `c31d80c`.
- Related dotfiles commit: `bad2347` (local only).
- Local rollback archive:
  `C:\Users\hermes\.local\share\opencode\config-backups\20261102-220711`.

The baseline commit is the recovery point for removed telemetry assets and config
edits.

## Reversible change discipline

- Inspect `git status` and `git diff` before and after changes.
- Restore only explicitly reviewed paths with `git restore <path>`.
- Do not use `git reset --hard`.
- Do not clobber ignored private overrides (`opencode.private.local.json`,
  `notification-ntfy.json`, `auth.json`, local env files).
- Do not commit or push unless explicitly requested.

## Runtime vs source

Runtime upgrades are independent of the source checkout. OpenCode auto-updated from
1.18.18 to 1.19.5 on its own. `autoupdate` is now `false`.

- Upgrade the runtime manually.
- Update the `@opencode-ai/plugin` pin and `bun.lock` together.
- Run `bun run preflight -- --config` before trusting the combination.
- Do not assume a runtime/SDK match; verify it.

## Host overlays

Tracked:

- `opencode.host.example.jsonc` — uses `SEMBLE_MCP_DIR` and `EBAY_MCP_DIR`, contains
  no credentials.

Ignored:

- `opencode.private.local.json` — this host's Semble path. It must be loaded with
  `OPENCODE_CONFIG` to date; automatic loading is not confirmed.

Preferred final behavior, pending final integration files:

- HOME-derived auto-enable for Semble, or
- a documented local override path.

Do not hard-code a machine path into tracked config.

## VM and OS notes

- No VM provisioning is part of this repository.
- Debian: use the distribution default repository.
- NixOS: approved nodes only.
- A common Git checkout must not depend on Home Manager ownership, host auth, or
  secrets stored in the Nix store.
- Secrets stay in the host environment or an approved secret store, never in tracked
  Nix files.

## Cross-host rules

- Do not copy `auth.json`.
- Do not copy `opencode.private.local.json` blindly; adapt paths.
- Do not copy retrieval state; it is per-host operational data.
- Keys are entered per host with the masked flows.

## Verification after portability changes

```text
bun run typecheck
bun test
bun run preflight -- --config
opencode debug config
```

Confirm the host overlay is actually merged, the expected MCP entries are enabled, and
no credential value is printed.
