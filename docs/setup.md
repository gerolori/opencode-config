# Setup

## Status

Loader/config activation is complete on OpenCode 2.2.5. One `opencode reload` was
applied; the existing service PID stayed unchanged. No restart or migration was
performed. Real model-turn, tool, and Code Mode smoke checks remain pending.

## Prerequisites

- `@opencode/cli` 2.2.5.
- `@opencode/plugin`, `@opencode/schema`, and `@opencode/client` 2.2.5.
- Bun with `bun.lock` as the authoritative lockfile.
- `uv` / `uvx` if the DuckDuckGo MCP server or local Semble is used.
- `sqz-mcp` (or the Windows `.exe` shim) on `PATH` when SQZ MCP is enabled.
- `br` / `bv` only if Beads tracking is used.

An already-open session keeps its old toolset until reopened or attached through a new
2.2.5 client.

## Install

From the config directory:

```text
bun install
```

Repository checks, if the activated tree still defines them:

```text
bun run typecheck
bun test
bun run preflight -- --config
```

`bun.lock` is authoritative. Do not reintroduce `package-lock.json` as the lock source.

## Service and reload

```text
opencode service status
opencode reload
```

Activation used exactly one reload and left the existing service PID unchanged. Do not
demand a restart after a config-only reload; environment changes are separate (see
“Environment changes vs config reload” under Keys). Reopen the session or attach through
a new 2.2.5 client to pick up the activated toolset.

## Config layering

Use the native 2.2.5 sections: `providers`, `agents`, `permissions`, `mcp.servers`, and
`plugins`. `small_model` is unsupported and removed.

Host initialization adds Exa, Semble, eBay, and Home Assistant defaults **only when
the corresponding entries are absent**.

- `opencode.host.example.jsonc` sets Semble `disabled: true` by default.
- `OPENCODE_DISABLE_SEMBLE=1` is a real one-way kill switch, even for an explicit
  enabled entry.
- Otherwise explicit entries are preserved, including `disabled: true` and custom
  fields.
- Exa requires `EXA_API_KEY`. Current observed status on this host: connected after a
  vault-backed restart; a live Exa PDF read succeeded. This is host/session evidence and is
  not portable or permanent. An Exa/TinyFish search was not independently re-verified.
- Semble requires a valid local project directory (env override or
  `~/mcp-servers/semble`), unless the kill switch is set.
- Home Assistant requires **both** `HA_MCP_URL` and `HA_BEARER_TOKEN`; there is no
  personal fallback URL. It is connected on this host/session after a vault-backed restart;
  a live read-only `llm__GetDateTime` call succeeded. This is host/session evidence and is
  not portable or permanent.
- eBay is **conditionally available**: enabled only when a valid local project exists
  (`EBAY_MCP_DIR` or `~/mcp-servers/ebay`) and both `EBAY_CLIENT_ID` /
  `EBAY_CLIENT_SECRET` are in the service environment. The tracked entry ships
  `disabled: false` (enabled); host initialization force-disables a managed entry while
  prerequisites are missing and re-enables it when they return, so the placeholder is
  never launched without them. `OPENCODE_DISABLE_EBAY=1` is a one-way kill switch. Host
  initialization writes the effective credential values into the in-memory MCP
  environment and omits `EBAY_ENV` when unset, so the child never receives a literal
  `{env:...}` placeholder. The config model does not distinguish a managed entry's toggle
  from the tracked default, so the transform may also enable a managed `disabled: true`
  entry. Use `OPENCODE_DISABLE_EBAY=1` or an explicit custom overlay (for example, a
  custom command) for an explicit opt-out.
- eBay is **not verified** in this tree: no live call was made, and the historical
  eBay errors remain undiagnosed. Configuration is not evidence that the connector
  works.

Status terms: **configured** = entry present; **available** = policy-eligible
(prerequisites and credentials present, no active circuit); **verified** = a live call
succeeded. `retrieval_control` exposes `key_configured` and `connector_status`
(`not_configured`, `configured_unverified`, `live_success_recorded`); credentials
alone never report a connector as verified. Only `fetch` may call `ebay_*` tools, and
only `explore` may call `semble_*`.

`opencode.private.local.json` is optional and not required for the connected Semble
instance on this host.

## Host paths

Use forward-slash paths in environment values on Windows:

```powershell
$env:SEMBLE_MCP_DIR = "C:/Users/hermes/mcp-servers/semble"
$env:EBAY_MCP_DIR = "C:/Users/hermes/mcp-servers/ebay"
```

Invalid, missing, remote, or UNC Semble paths keep Semble disabled without blocking
startup. These variables must reach the background service launch environment; see
“Environment changes vs config reload” under Keys. Do not hard-code a machine path into
tracked config.

## Keys

For the portable SOPS/age vault path, the user-run creation, permissions, backup,
and idle-restart procedure is in `docs/secrets.md`. The launcher is
`scripts/secret-launch.ts`; it decrypts in memory, accepts only the documented
allowlist, and never prints values or SOPS stderr. Do not ask the agent to create
or read the real vault or identity.

The Windows passphrase-protected identity path is user-tested: a restored
Bitwarden backup of the `.age` identity plus its passphrase decrypted the real
vault. Linux interactive prompt behavior, end-to-end service restart
inheritance, and ambient environment inheritance by the service child remain
unverified. A direct service launch preserves all ambient variables except the
documented allowlist and SOPS identity variables, so avoid launching from a
shell that holds unrelated secrets.

For one-off values, never paste a literal key into a command, file, or transcript.
Use a masked prompt so it does not enter shell history.

PowerShell:

```powershell
$secure = Read-Host -AsSecureString "EXA_API_KEY"
$env:EXA_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

```powershell
$secure = Read-Host -AsSecureString "TINYFISH_API_KEY"
$env:TINYFISH_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

Bash:

```bash
read -rs EXA_API_KEY && export EXA_API_KEY
read -rs TINYFISH_API_KEY && export TINYFISH_API_KEY
```

eBay (both values required; set them in the environment that starts the service):

```powershell
$secure = Read-Host -AsSecureString "EBAY_CLIENT_ID"
$env:EBAY_CLIENT_ID = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$secure = Read-Host -AsSecureString "EBAY_CLIENT_SECRET"
$env:EBAY_CLIENT_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

```bash
read -rs EBAY_CLIENT_ID && export EBAY_CLIENT_ID
read -rs EBAY_CLIENT_SECRET && export EBAY_CLIENT_SECRET
```

After setting them, an idle `opencode service restart` from that same environment is
intended to pick them up; a config-only `opencode reload` does not. The 2.2.5 CLI
command exists, but **end-to-end inheritance by the background service is
unverified in this tree**. Confirm with an idle local smoke test. The direct
launcher preserves all other ambient caller variables deliberately (only the
documented allowlist and SOPS identity variables are rewritten), so an unrelated
credential in the launching shell can also reach the service.

### Environment changes vs config reload

Environment variables are read by the **background service process**. A new TUI terminal
does not retroactively update that process. Set keys and host variables in the shell or
launcher that starts the service, then perform an **idle** service restart from that same
environment:

```text
opencode service restart
```

The `opencode service restart` command exists in 2.2.5, but whether the restarted
background service inherits this shell/launcher environment is **unverified**.
Reopening only the TUI does not update an already-running service. Ambient
variables outside the SOPS allowlist are not scrubbed by the direct launcher;
that preservation is intentional for PATH/locale/host settings and is a residual
risk. Configuration-only activation is different: the verified `opencode reload`
was sufficient and does not require a restart.

Do not create tracked `.env` files, dump auth stores, or copy `auth.json` between hosts.

## Accounts and billing

- Exa: free account at `https://dashboard.exa.ai/api-keys`. Free plan is described as a
  recurring credit with no card and auto-recharge off. Do not guarantee this if a paid
  key is supplied; that account's billing applies.
- TinyFish: optional key from `https://agent.tinyfish.ai/api-keys`. Keyless is
  supported locally under safeguards; vendor keyless allowance is unverified.
- No automatic signups and no automatic payments are performed by this setup.

## Manual authentication

Use only the verified 2.2.5 forms; do not guess provider arguments or reuse 1.x forms.

Native OpenAI:

```text
opencode auth login [<target>]
opencode models
opencode auth list [--format default|json]
opencode auth switch [<target>] [<credential>]
```

`<target>` is optional; choose the integration from the picker. After the browser flow,
read the exact catalog, make one real entitlement call, and only then persist that exact
id through an approved manual config change. Do not invent a subscription model id or
promise fallback.

Composio MCP:

```text
opencode mcp list
opencode mcp auth [<name>]
```

`<name>` is optional; choose Composio. Composio needs authentication under 2.2.5. Do
not claim the old OAuth migrated or connected.

When `COMPOSIO_CONSUMER_API_KEY` is present in the service environment, host
initialization adds the documented `x-consumer-api-key` header to the managed
Composio entry and sets `oauth: false`; OAuth is disabled for that entry while
the key stays configured. Removing the key restores the managed default OAuth
entry only if no explicit host override changes that behavior. A custom URL,
extra headers, a populated OAuth config, or an explicitly disabled entry is
preserved as a host override and may prevent automatic restoration. The
persistence behavior of MCP editor `set`/`update` outside the in-memory effective
configuration is not runtime-proven in this tree. Do not assume the consumer key
reuses an existing Composio connection; its user/project scope and connection
visibility are unverified. Local OAuth remains a supported fallback. Never log
the transformed header.

## Service credentials and UI config

- `cli.json` is deliberately tracked; it is public UI configuration only.
- `service.json` / `service.jsonc` may contain service credentials. They are ignored and
  unprinted; never commit, print, or copy them.
- Historical `tui.json` is untouched and not assumed to be the active 2.2.5 location.

## Auto-update and rollback

Runtime upgrades are manual. Old checkpoint rollback is historical. Do not use 1.x
config as a drop-in on 2.2.5; check downgrade and session compatibility first, then
restore reviewed Git checkpoints.

See `docs/portability.md` for canonical paths and backup discipline.
