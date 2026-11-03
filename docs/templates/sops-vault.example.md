# SOPS vault example (documentation only)

This is a Markdown sample, not a real SOPS config or vault. Do not commit a
filled-in copy with real recipients or values. Create the real files yourself
with the commands in `docs/secrets.md`.

## `.sops.yaml` sample (user creates at the repository root)

Replace `age1example...` with the **public** recipient printed by
`age-keygen -y`. This file is ignored by Git in this repository.

```yaml
creation_rules:
  # Works on Windows and Linux. SOPS matches the vault path relative to this
  # file's directory using the OS separator: "secrets\opencode.sops.yaml" on
  # Windows, "secrets/opencode.sops.yaml" on Linux. [\\/] accepts both.
  - path_regex: '(^|[\\/])secrets[\\/].*\.sops\.ya?ml$'
    age: age1example...
```

Why the older `^secrets/...` form fails on Windows: SOPS matches `path_regex`
against the vault path **relative to the directory containing `.sops.yaml`**,
after normalizing to the OS separator. On Windows that path is
`secrets\opencode.sops.yaml`, so a rule anchored with `^secrets/` never
matches and SOPS exits 1 with `error loading config: no matching creation
rules found`. The same rule works on Linux, where the separator is `/` — hence
`[\\/]` so one file is portable.

SOPS also discovers `.sops.yaml` by walking **up from the current working
directory**, not from the vault's directory. Run `sops` and the launcher from
this repository root (or a subdirectory); running from an unrelated directory
fails with `config file not found and no keys provided through command line
options` even when the vault path is absolute.

`docs/secrets.md` and `scripts/secret-launch.ts` do not pass `--config`, so the
launcher uses the same discovery and inherits your working directory.

### Writing the file on Windows

Windows PowerShell 5.1 writes `>` and `Out-File` as UTF-16LE and `Set-Content`
as the ANSI code page. Installed `sops 3.7.3` accepts UTF-8 (with or without a
BOM), UTF-16LE, and ANSI for this file, so encoding is not the cause of a
`no matching creation rules` error. For portability, write UTF-8:

```powershell
Set-Content -Encoding utf8 .sops.yaml
```

(Windows PowerShell 5.1 adds a UTF-8 BOM; `sops 3.7.3` accepts it.)

## Vault plaintext shape (edit through `sops <file>`)

```yaml
# One shared vault. Any machine with the identity can read every value.
EXA_API_KEY: "replace-me"
TINYFISH_API_KEY: "optional-replace-me"
EBAY_CLIENT_ID: "replace-me"
EBAY_CLIENT_SECRET: "replace-me"
EBAY_ENV: "production"
HA_MCP_URL: "https://home-assistant.example/api/mcp"
HA_BEARER_TOKEN: "replace-me"
COMPOSIO_CONSUMER_API_KEY: "optional-replace-me"
OPENROUTER_API_KEY: "optional-replace-me"
```

Rules enforced by `scripts/secret-launch.ts`:

- Top-level `KEY: value` only; no nesting, lists, or block scalars.
- Keys must be in the allowlist above.
- Values must be non-empty strings. Quote values that contain ` #`, leading or
  trailing spaces, or YAML indicators.
- No duplicate keys and no inline comments.

`OPENROUTER_API_KEY` is optional and API-billed to that account. Local installed
`@opencode/ai` source supports the environment-variable route, but credential
precedence, service environment inheritance, provider routing/billing, and a live
model request are unverified. It is not ChatGPT subscription OAuth.

## What not to put in this file

- Bitwarden account master password or any password used to protect the
  Bitwarden account itself.
- `auth.json`, `service.json`, OAuth tokens, or ChatGPT subscription credentials.
- Machine-specific paths such as `SEMBLE_MCP_DIR` or `EBAY_MCP_DIR`.

## Suggested user commands

```text
age-keygen -o <identity-file>
age-keygen -y <identity-file>
# create .sops.yaml with the public recipient
mkdir -p secrets                     # PowerShell: New-Item -ItemType Directory -Force secrets
sops secrets/opencode.sops.yaml      # verified installed edit form: sops <file>
bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-key-file <identity-file>
```

The identity must be outside the Git checkout; the launcher rejects paths inside
it. `.gitignore` covers common identity names only as best-effort defense-in-depth,
not comprehensive protection for an arbitrarily named file. Run the last command
with `--restart` only during an idle window, and treat service environment
inheritance as unverified. See `docs/secrets.md` for permissions, editor/swap
plaintext risks, backups, the passphrase-protected flow (user-tested on Windows;
Linux interactive behavior unverified), and the trust boundary.
