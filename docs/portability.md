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

## Local checkpoints

- Baseline config commit: `c31d80c` (local commit).
- Related dotfiles commit: `bad2347` (local-only).
- The 2.2.5 activation/optimization remains uncommitted for review unless a later
  commit actually exists. Do not claim a new commit or push.

Old checkpoint rollback is **historical**. Do not use 1.x config as a drop-in on
2.2.5. Check downgrade and session compatibility first.

## Service, reload, and session compatibility

Activation used exactly one `opencode reload`; the existing 2.2.5 service PID stayed
unchanged. No restart or migration was performed.

- `opencode service status` reports service state.
- `opencode reload` reloads configuration for the running service. It does not refresh
  the service process environment.
- Keys and host variables must be present in the background service's launch
  environment. Apply them with an idle `opencode service restart` from the configured
  shell or launcher; reopening only the TUI is insufficient.
- An already-open session keeps its loaded tools. Reopen it or attach through a new
  2.2.5 client to pick up the activated toolset.
- Do not demand a service restart after a config-only reload.
- `opencode service start/restart` are operational actions, not documentation checks.

## Rollback discipline

- Use reviewed Git checkpoints.
- Inspect `git status` and `git diff` before and after changes.
- Restore only explicitly reviewed paths with `git restore <path>`.
- Do not use `git reset --hard`.
- Do not clobber ignored private/credential files.
- Do not recommend reverting 1.x config on top of 2.2.5 without downgrade and
  session-compatibility checks.
- Do not commit or push unless explicitly requested.

## Host defaults

Host initialization adds Exa, Semble, and Home Assistant defaults **only when the
corresponding entries are absent**.

- `opencode.host.example.jsonc` sets Semble `disabled: true` by default.
- `OPENCODE_DISABLE_SEMBLE=1` is a real one-way kill switch, even for an explicit
  enabled entry.
- Otherwise explicit entries, including `disabled: true` and custom fields, are
  preserved.
- Exa requires `EXA_API_KEY`. Current observed status on this host: connected after a
  vault-backed restart; a live Exa PDF read succeeded. This is host/session evidence and is
  not portable or permanent. An Exa/TinyFish search was not independently re-verified.
- Semble requires a valid local project directory (env override or
  `~/mcp-servers/semble`), unless the kill switch is set.
- Home Assistant requires both `HA_MCP_URL` and `HA_BEARER_TOKEN`; no personal fallback.
  It is connected on this host/session after a vault-backed restart; a live read-only
  `llm__GetDateTime` call succeeded. This is host/session evidence and is not portable or
  permanent.
- eBay is enabled only when a valid local project (`EBAY_MCP_DIR` or
  `~/mcp-servers/ebay`) and both eBay credentials are present in the service
  environment. `OPENCODE_DISABLE_EBAY=1` disables it. It is not live-verified, and its
  historical errors remain undiagnosed.

`opencode.private.local.json` is optional and not required for the connected Semble
instance on this host. Do not hard-code a machine path into tracked config.

## Credential and UI files

- `cli.json` is deliberately tracked; it is public UI configuration only.
- `service.json` / `service.jsonc` may contain service credentials. They are ignored and
  unprinted; never commit, print, or copy them.
- `auth.json` is never copied between hosts.
- Headers and keys stay in memory or the environment, never in source or logs.
- Historical `tui.json` is untouched and not assumed to be the active location.

## VM and OS notes

- No VM provisioning is part of this repository.
- Debian: use the distribution default repository.
- NixOS: approved nodes only.
- A common Git checkout must not depend on Home Manager ownership, host auth, or
  secrets stored in the Nix store.
- Secrets stay in the host environment or an approved secret store, never in tracked
  Nix files.

## Verification after portability changes

```text
opencode --version
opencode --help
opencode stats --help
git status --short
git diff --stat
```

Do not start/restart the service or read sessions as part of documentation
verification. Loader/config activation is complete; pending real model-turn, tool, and
Code Mode smoke checks are in `docs/verification.md`.
