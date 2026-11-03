# Secret delivery (SOPS + age)

This document describes the optional, portable secret path for the OpenCode
background service. It is written for the **user** to run. The agent must not
create, read, edit, or print the real vault, the real age identity, or any
credential value.

## What this is

- One shared SOPS-encrypted YAML vault for all machines.
- An age identity (private key) on each machine decrypts the vault.
- `scripts/secret-launch.ts` decrypts the vault in memory, accepts only a strict
  allowlist of service variables, and optionally restarts the OpenCode service
  with that environment.

It is not a per-machine or per-agent permission system. **Any machine that can
decrypt the vault can read every value in it.** Disabling an MCP in
`opencode.jsonc` hides that server from an agent; it does **not** revoke vault
access. To revoke access, remove that machine's age recipient and re-encrypt the
vault (and rotate the affected credentials).

## Choose a path

- **A. Supported default — local age identity file.** Decryption depends on an
  OS-protected key file, not a password prompt. Tested offline; it does not meet
  a requirement for a password at run time.
- **B. Passphrase-protected identity, user-tested on Windows.** The user enters a
  passphrase into `age`, which returns the identity in memory to the launcher; no
  temp identity file. The user reports that a restored Bitwarden backup of the
  `.age` identity and its passphrase successfully decrypted the real vault on
  Windows. This task did not read the real vault or identity. Linux interactive
  prompt behavior is **unverified**, and service restart inheritance is
  **unverified**.

Both paths share the same vault format, allowlist, launcher, and service
environment limits. The Windows passphrase path is user-tested for decryption
itself, but do not generalize that result to Linux or to service environment
inheritance.

## Trust boundary

| Concern | Rule |
| --- | --- |
| Vault | Encrypted YAML, committed only at `secrets/opencode.sops.yaml`. |
| Private age identity | Outside Git and outside the Nix store, with owner-only permissions. The launcher rejects an identity path inside the checkout. This is a useful containment check, not a comprehensive proof that the key was never copied elsewhere or never named so as to evade an ignore rule. |
| Launcher plaintext | Memory only. No temp identity file, no shell history, no CLI argument. |
| `sops <file>` editor | **Not memory-only.** SOPS decrypts to a temp file for the editor, and editors may create swap/backup/recovery files. See the mitigations below. |
| Agent | Does not read, write, generate, or print vault/identity/credentials. |
| Service child | Receives the allowlisted values in its environment; same-user processes can read that environment. All other ambient caller environment variables are inherited deliberately, so unrelated credentials in the launching shell can also reach the service. Restart inheritance is unverified. |
| Bitwarden | Stores a backup of the identity and/or a dedicated random passphrase item. Never the Bitwarden account master password. |

`*.sops.yaml` and `*.sops.yml` are ignored except
`secrets/opencode.sops.yaml`. The `.gitignore` also covers common private-key
extensions (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ppk`,
`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`), age-specific identity names,
`.sops.yaml`, decrypted/plain dumps, and common editor swap/backup artifacts.
This is **best-effort defense-in-depth, not comprehensive**: an identity with an
unusual name or location can still be staged, and an explicit `git add -f` can
override an ignore. Keep the real identity outside the repository and verify
`git status` before committing.

**MCP editor persistence is not runtime-proven.** Static inspection of the
installed 2.2.5 CLI shows `set`/`update` mutating in-memory MCP editor state and
triggering a reload; no tracked-config write was observed in that path. This task
did not run a live isolation test against the real service. Do not treat
"resolved secrets are memory-only" as a proven guarantee. If that guarantee is
required, validate it with fake sentinel values in an isolated instance before
enabling resolved header injection.

## Supported default: local age identity with OS permissions

This is the tested/supportable path, but it does **not** implement a password
prompt. The identity file is plaintext on disk, so protect it with OS permissions
and keep a backup in Bitwarden. If the user specifically requires a password at
run time, use the passphrase-protected identity path below instead; it is
user-tested on Windows, while Linux interactive behavior is still unverified.

### 1. Install tools

```text
sops --version
age --version
```

Use distro/package-manager or vendor binaries. Do not use a Nix store path for
the identity.

### 2. Create the identity (user-run, once)

```text
age-keygen -o <path-to-identity-file>
age-keygen -y <path-to-identity-file>
```

The second command prints the **public** recipient (`age1...`). The private
identity stays in the file. Do not paste the private key into a chat, issue, or
command argument.

Store a backup of the identity file in a Bitwarden **secure note** and protect
that Bitwarden account with a strong master password and 2FA. The Bitwarden
master password is not an age key and cannot decrypt the vault by itself.

### 3. Protect the identity file

Put the identity outside the Git checkout. The launcher rejects an identity
whose resolved path is inside this repository, and `.gitignore` covers common
identity names as a best-effort second layer. That ignore coverage is **not
comprehensive** and does not protect an unusually named file or a copied key.
This containment applies to both the plaintext identity file and the
passphrase-protected `.age` file.

Windows (PowerShell, current user only):

```powershell
icacls "<path-to-identity-file>" /inheritance:r
icacls "<path-to-identity-file>" /grant:r "$($env:USERNAME):(R)"
```

If the account name contains a domain (`DOMAIN\user`), use the exact account
string returned by `whoami`:

```powershell
icacls "<path-to-identity-file>" /grant:r "$((whoami).Trim()):(R)"
```

Linux/macOS:

```bash
chmod 600 <path-to-identity-file>
chown "$(id -u):$(id -g)" <path-to-identity-file>
```

`chmod 600` must be applied after the file exists; `age-keygen -o` may warn that
a newly created file is world-readable until you do this.

### 4. Create `.sops.yaml` (user-run; do not commit if you prefer)

The sample is in `docs/templates/sops-vault.example.md`. Create a real
`.sops.yaml` at the repository root with the public recipient. Keep it out of Git
if you do not want to publish the recipient list; `.sops.yaml` is ignored here.

Use the separator-agnostic rule from the sample:

```yaml
creation_rules:
  - path_regex: '(^|[\\/])secrets[\\/].*\.sops\.ya?ml$'
    age: age1...
```

Two SOPS behaviors make the obvious `^secrets/.*\.sops\.ya?ml$` rule fail on
Windows even though it works on Linux:

- `path_regex` is matched against the vault path **relative to the directory
  containing `.sops.yaml`**, normalized to the OS separator. Windows uses `\`,
  so `^secrets/` never matches and SOPS exits 1 with `error loading config: no
  matching creation rules found`. `[\\/]` accepts either separator.
- `.sops.yaml` is discovered by walking **up from the current working
  directory**, not from the vault's directory. Run `sops` and the launcher from
  the repository root or a subdirectory. From an unrelated directory, SOPS says
  `config file not found and no keys provided through command line options`
  even when the vault path is absolute.

`scripts/secret-launch.ts` passes no `--config`, so it inherits the same working
directory and discovery behavior. `no matching creation rules` is a path/config
error, not a missing or wrong age identity: no credential was read. ANSI or
UTF-16LE `.sops.yaml` files are accepted by installed `sops 3.7.3`; encoding is
not the cause of that error. `Set-Content -Encoding utf8` is still the portable
choice.

### 5. Create or edit the vault (user-run)

Verified for installed `sops 3.7.3`: edit an existing or new document by passing
the file directly (`sops <file>`):

```powershell
New-Item -ItemType Directory -Force secrets
sops secrets/opencode.sops.yaml
```

```bash
mkdir -p secrets
sops secrets/opencode.sops.yaml
```

SOPS opens the decrypted document in `$EDITOR`. Type values there; do not use
`sops --set KEY=value` or any form that puts a secret in shell history or a
process argument. Save and exit; SOPS writes only ciphertext.

**Plaintext risk at edit time:** `sops <file>` is not memory-only. It writes a
temporary decrypted file for the editor, and the editor may create swap, backup,
or recovery files. Mitigate by:

- using a local, minimal editor with swap/backup disabled;
- editing outside cloud-synced folders;
- closing the editor cleanly and checking its recovery directory afterward;
- not leaving the machine or session unattended while editing;
- avoiding editors that retain unlimited undo history or cloud backups.

On Windows, SOPS strips backslashes from `$EDITOR`, so use forward slashes and
an editor that opens the file path you pass:

```powershell
$env:EDITOR = "C:/Windows/System32/notepad.exe"
```

The launcher can set the identity environment and open the editor without
printing the identity:

```powershell
bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-key-file <identity-file> --edit
```

For the password path, use `--age-encrypted-identity <identity-file>.age --edit`
after the encrypted file has been verified. The editor still receives plaintext
through SOPS and may create temp/swap files.

Accepted fields:

```text
EXA_API_KEY
TINYFISH_API_KEY            optional
EBAY_CLIENT_ID
EBAY_CLIENT_SECRET
EBAY_ENV                    optional
HA_MCP_URL
HA_BEARER_TOKEN
COMPOSIO_CONSUMER_API_KEY   optional
OPENROUTER_API_KEY          optional
```

Top-level `KEY: "value"` pairs only. Nested mappings, lists, block scalars,
duplicate keys, unknown keys, empty values, and inline comments are rejected.
Use full-line comments or quote the value.

### 6. Per-machine dry run

```text
bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-key-file <path-to-identity-file>
```

The dry run prints only the **names** of accepted fields. It does not print
values, SOPS stderr, or service status. If it fails, fix the vault/identity; do
not ask the agent to inspect either file. For the passphrase-protected path,
replace `--age-key-file <path>` with `--age-encrypted-identity <path>.age`; the
same command then prompts interactively. This is user-tested on Windows; Linux
TTY behavior remains unverified.

### 7. Restart the service during an idle window

```text
bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-key-file <path-to-identity-file> --restart
```

`opencode reload` does **not** refresh the background service environment. The
2.2.5 CLI exposes `opencode service restart`, but **end-to-end inheritance of this
child environment by the background service is unverified in this tree**. Do not
treat the restart as proven; confirm with an idle local smoke test before relying
on it. The vault is authoritative for the documented allowlist: an allowlisted
key absent from the vault is removed from the child environment rather than
inherited from the shell. All **other** ambient variables from the launching
shell are preserved deliberately so PATH, locale, and host settings keep
working. That means unrelated credentials or host overrides in the caller's
environment can also reach the service child; this is a documented residual
risk. Avoid launching from a shell that contains secrets outside the vault.
The launcher warns before restarting; it never runs `service status` or prints
credentials. The restart child uses ignored stdout/stderr and a 60-second bound.

On Windows, if the `opencode` shim cannot be spawned, pass the real executable
explicitly. The launcher accepts only a basename of `opencode`, `opencode.exe`,
or `opencode.cmd` (case-insensitive on Windows), including an explicit path. This
is a name check, **not integrity verification**: a malicious binary or an
earlier PATH entry named `opencode` would pass. Use a trusted absolute path from
the official install and keep untrusted directories out of PATH:

```text
bun run scripts/secret-launch.ts ... --restart --opencode "C:/Users/<you>/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
```

### 8. Update later

```text
sops secrets/opencode.sops.yaml
```

Re-run the dry run and the idle restart. Re-encrypt and rotate if a machine or
identity is lost.

## Passphrase-protected identity (Windows user-tested)

Installed `sops 3.7.3` does **not** support `SOPS_AGE_KEY_CMD` (the string is
absent from the installed binary); the verified edit form is `sops <file>`. The
password-gated flow uses the launcher's in-memory `age` → `SOPS_AGE_KEY` bridge.
Follow this order; do **not** delete the plaintext identity until the encrypted
copy has been proven to decrypt.

1. **Create the identity, record the public recipient, and create `.sops.yaml`
   and `secrets/` before `--edit`.**

   ```text
   age-keygen -o <identity-file>
   age-keygen -y <identity-file>
   ```

   Record the printed `age1...` recipient in `.sops.yaml` and create the vault
   directory. The sample is in `docs/templates/sops-vault.example.md`.

   ```powershell
   New-Item -ItemType Directory -Force secrets
   # Create .sops.yaml at the repository root with the public recipient.
   ```

   ```bash
   mkdir -p secrets
   # Create .sops.yaml at the repository root with the public recipient.
   ```

   Keep the plaintext identity outside the Git checkout for now. Both
   `secrets/` and `.sops.yaml` must exist before the `--edit` command below.

2. **Create the vault using that identity.** The first edit must have working
   identity material; either use the launcher (recommended) or set
   `SOPS_AGE_KEY_FILE` for that one command:

   ```powershell
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-key-file <identity-file> --edit
   ```

   Verify the vault decrypts with the plaintext identity before continuing:

   ```text
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-key-file <identity-file>
   ```

3. **Create the passphrase-encrypted identity.**

   ```text
   age -p -o <identity-file>.age <identity-file>
   ```

   `age` prompts twice. Use a **new random OpenCode password**; store it as its
   own Bitwarden item. Never reuse the Bitwarden account master password and
   never put the passphrase in an argument, environment variable, script, or
   chat.

4. **Prove the encrypted identity works before deleting anything.** Run the
   launcher dry run with the encrypted identity; it prompts and captures the
   identity in memory:

   ```text
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-encrypted-identity <identity-file>.age
   ```

   Do not run `age -d <identity-file>.age` directly in a terminal: that prints
   the identity to stdout. The launcher is the safe wrapper.

5. **Back up and test recovery.** Store the `.age` file and the passphrase item
   separately in Bitwarden. Copy the `.age` file to a second path and repeat the
   dry run there. Only after that succeeds should you remove the plaintext
   identity file (or move it offline). If the encrypted copy and passphrase
   cannot be recovered, the vault is unrecoverable.

6. **Future edits** use the encrypted identity and the editor:

   ```text
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-encrypted-identity <identity-file>.age --edit
   ```

   The launcher never prints the identity, but the editor receives plaintext
   through SOPS and may create temp/swap/recovery files.

Status: **Windows path user-tested; Linux interactive behavior unverified.**
The user reports that the real vault decrypted on Windows using the
passphrase-protected identity and a restored Bitwarden backup. This review did
not read the real vault, identity, or passphrase. Evidence from disposable,
non-sensitive fixtures and the installed tooling:

- `SOPS_AGE_KEY` inline identity decryption works with `sops 3.7.3`.
- The launcher's `age` → inline `SOPS_AGE_KEY` and edit paths are unit-tested
  with fake subprocesses.
- A non-interactive `age -p` attempt hangs waiting for a terminal, so the agent
  did not and cannot enter a passphrase.

What is **not** verified:

- That `age -d` prompts correctly from the launcher's inherited terminal on
  **Linux**, or that it does not hang under a non-interactive runner there. The
  Windows passphrase prompt has been user-tested.
- That the background service receives the environment after restart, and that
  restarting preserves all intended ambient-variable behavior.
- That a real `opencode service restart` inherits the loaded environment.

If the Linux prompt does not appear or hangs, use the supported local-identity
default, or stop and choose a different design. The launcher does not cap the
interactive passphrase prompt with a timeout; cancel with Ctrl+C. Non-interactive
SOPS decryption and the service restart are bounded (30s and 60s respectively).

## What does not belong in the vault

- `auth.json`, `service.json`, or any OAuth store. Never copy these between hosts.
- ChatGPT subscription credentials. Use local interactive OAuth:
  `opencode auth login`.
- OpenAI API keys unless you deliberately want metered API billing separately.
- Machine paths such as `SEMBLE_MCP_DIR` or `EBAY_MCP_DIR`. Keep those as
  per-host settings.

## Accounts and billing

- Exa, TinyFish, eBay, Home Assistant, and Composio credentials belong to their
  respective accounts. This setup does not create accounts or make payments.
- A paid Exa key uses that account's billing; the free-plan description is not a
  guarantee for a supplied paid key.
- ChatGPT subscription access uses local interactive OAuth and is not a vault
  value. An OpenAI API key would be metered separately and is not required.
- `OPENROUTER_API_KEY` is optional. The installed `@opencode/ai` provider source
  (`dist/providers/openrouter.js`) builds bearer auth with
  `AuthOptions.bearer(input, "OPENROUTER_API_KEY")`, so an environment-variable
  route is supported by the local provider source. This documentation does not
  claim that the environment key overrides stored `opencode auth` credentials,
  that a restarted background service inherits it, that OpenRouter routing or
  billing uses it, or that a live model request succeeds with it. OpenRouter API
  usage is metered and billed to that account. It is separate from ChatGPT
  subscription OAuth and neither replaces nor upgrades that access.
- Rotate a credential at the vendor and in the vault together if it leaks.

Composio Connect accepts a consumer key via the `x-consumer-api-key` header. When
`COMPOSIO_CONSUMER_API_KEY` is present, host initialization adds that header and
sets `oauth: false` **only** for the managed default entry. OAuth is disabled for
that entry while the key remains configured. Removing the key restores the
managed default OAuth entry only if no explicit host override changes that
behavior; a custom URL, extra headers, a populated OAuth configuration, or an
explicitly disabled entry is preserved as a deliberate host override and may
prevent automatic OAuth restoration.

Do not assume the consumer key reuses an existing Composio connection: its
user/project scope and whether it sees existing connections are **unverified**.
The current tree has not runtime-verified whether MCP editor changes can persist
outside the in-memory effective configuration; source inspection of the bundled
2.2.5 CLI shows `set`/`update` mutating the in-memory MCP editor state and
triggering a reload, but this is not a proof that no other persistence path
exists. Local OAuth remains a supported fallback. Never log transformed headers.

## Verification status

Verified offline in this tree:

- `sops 3.7.3` and `age 1.3.1` are present.
- `bun run typecheck` passes.
- `bun test` passes, including allowlist/parse/invalid-input, quoted and
  multiline escapes, shell-metacharacter handling, subprocess argv, real
  subprocess stdout-cap/stderr-discard/suppressed-output/timeout tests, generic
  decrypt failure, environment forwarding, the fixed restart command, executable
  basename validation (allowed/default/explicit Windows path and rejected
  arbitrary binary without echoing its name), identity path boundaries (`..foo`
  and Git-unavailable cases), strict age-identity parsing, edit mode,
  unknown-argument redaction, and Composio key-vs-OAuth host initialization.
- Installed 2.2.5 CLI source inspection: the bundled MCP editor `set`/`update`
  path mutates an in-memory `Map` and triggers a runtime reload; no write to a
  tracked config file was observed in that path. This is static inspection of a
  minified binary, not a runtime persistence proof; see the Composio uncertainty
  note above.
- `bun run scripts/secret-launch.ts --help` works.
- A dry run against a missing vault produced only `sops decryption failed`; no
  sops stderr or path value was printed.
- Disposable fixture: `sops 3.7.3` encrypted and decrypted a sentinel YAML file
  with a temporary age recipient; inline `SOPS_AGE_KEY` decrypted it, and a
  two-identity `SOPS_AGE_KEY` value also decrypted it.
- Disposable fixture on Windows: `path_regex` matching is relative to the
  `.sops.yaml` directory and uses `\`; `^secrets/...` failed with
  `error loading config: no matching creation rules found`, while
  `(^|[\\/])secrets[\\/].*\.sops\.ya?ml$` encrypted and decrypted from the repo
  root, a subdirectory, and with an absolute vault path. UTF-8 (BOM/no BOM),
  UTF-16LE, and ANSI configs all parsed. `tests/sops-path-regex.test.ts` locks
  in the matching behavior.
- Verified installed edit form: `sops <file>`. A fake-editor test on Windows hit
  a file-sharing error, so the interactive editor flow itself is not claimed
  verified.
- User-reported, not agent-verified: on Windows, a passphrase-protected age
  identity plus a restored Bitwarden backup of that identity successfully
  decrypted the real vault. This review did not read the vault, identity, or
  passphrase.

**Not verified here**:

- Linux interactive passphrase/TTY behavior through the launcher. The Windows
  prompt has been user-tested; `age -p` requires a terminal and a non-interactive
  attempt hung.
- `SOPS_AGE_KEY_CMD` is unavailable in installed `sops 3.7.3`; it was removed.
- That a real `opencode service restart` inherits this environment. The restart
  path itself was not executed and no service was restarted. Confirm with an
  idle local smoke test before relying on it.
- Whether MCP editor `set`/`update` can persist resolved secrets outside the
  in-memory effective configuration in every runtime path. Source inspection
  suggests in-memory only, but it is not runtime-proven.
- Composio consumer-key scope or access to existing connections.
- Windows/Linux ACL behavior on your specific filesystem.
- Comprehensive protection from `.gitignore` for arbitrarily named identities;
  the rules are best-effort defense-in-depth.

## Security limits

- The launcher removes decrypted values from its own process environment after
  launch, but JavaScript strings cannot be reliably zeroed. The child process
  and same-user OS processes can observe the environment.
- The passphrase-protected identity path passes the age identity to the SOPS
  child as `SOPS_AGE_KEY`. It avoids a temp identity file, but the identity is
  still visible in that child's environment. The passphrase itself is never
  stored or passed by the launcher.
- A vault-wide read is all-or-nothing per machine. There is no field-level
  access control.
- Identity containment resolves symlinks with `realpath` when possible and falls
  back to the absolute path if resolution fails. It enforces this module's
  package root even without Git, but an exotic filesystem that defeats path
  resolution remains a residual risk; keep identities outside the checkout.
- The service executable is checked by basename only. A malicious binary named
  `opencode`, or an earlier malicious entry on PATH, is not detected. Use a
  trusted absolute path and a trusted PATH.
- SOPS ciphertext is only as safe as the age identity and the machine it lives
  on. Back up the identity; do not email it or paste it into an agent session.
- This workflow does not sign up for accounts, make payments, or rotate vendor
  credentials for you.
