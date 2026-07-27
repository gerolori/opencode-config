# opencode-config

## Layout

- `opencode.jsonc` — safe public config
- `opencode.private.local.example.json` — optional local-only overlay template

The copied `agents/`, `commands/`, `instructions/`, `profiles/`, and `skills/`
directories are the shared opencode tree.

## Global install for Ubuntu

Use the install script to expose this shared config through
`~/.config/opencode`, which is where opencode looks when launched from any
directory:

```bash
bash scripts/install-global.sh
```

The script is idempotent and only creates missing symlinks. It links
`~/.config/opencode/opencode.json` to this repo's `opencode.jsonc` so the
shared config keeps its JSONC comments.

If you already have files in `~/.config/opencode`, the script will leave them in
place and skip those entries.

## Ubuntu / Windows compatibility audit

Portable/shared today:

- `opencode.jsonc`
- `agents/`, `commands/`, `skills/`
- OpenAI auth via `/connect`

Optional local-only overlay:

- personal MCPs such as Home Assistant and `semble`

Optional local MCP dependencies already enabled in the public config:

- `sqz-mcp`
- `uvx --python 3.11 duckduckgo-mcp-server`

## Setup

### Ubuntu quickstart

```bash
git clone <repo-url>
cd opencode-config
bash scripts/install-global.sh
opencode
```

After that, you can run `opencode` from any directory.

In `opencode`, run `/connect` to sign into OpenAI.

If you do not want Home Assistant or `semble`, you can stop here and use the
shared config only.

If you do want a local overlay:

```bash
cp opencode.private.local.example.json opencode.private.local.json
$EDITOR opencode.private.local.json
export OPENCODE_CONFIG="$PWD/opencode.private.local.json"
opencode
```

### Windows example

```powershell
Copy-Item .\opencode.private.local.example.json .\opencode.private.local.json
```

Edit the copied file, keep it untracked, and point `OPENCODE_CONFIG` at it:

```powershell
$env:OPENCODE_CONFIG = (Resolve-Path .\opencode.private.local.json)
```

Then start `opencode` from the repo root. Use `/connect` in `opencode`
separately to authenticate OpenAI on each machine.

## Ubuntu notes / troubleshooting

If `sqz-mcp` or `uvx` are not installed yet, either install those tools or
disable the local MCP servers in your untracked overlay with JSON like this:

```json
{
  "mcp": {
    "sqz": { "enabled": false },
    "duckduckgo": { "enabled": false }
  }
}
```

## Notes

- `opencode.jsonc` is intentionally safe to share.
- The repo is safe to publish without any private overlay tracked.
- `opencode.private.json` and `opencode.private.local.json` should stay
  untracked; `.gitignore` covers them.
- `~/.config/opencode/opencode.json` is provided as a symlink to the repo's
  `opencode.jsonc` by the installer.
