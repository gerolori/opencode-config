# opencode-config

Public baseline for my opencode setup.

## Layout

- `opencode.jsonc` — safe public config
- `opencode.private.local.example.json` — optional local-only overlay template

The copied `agents/`, `commands/`, `instructions/`, `profiles/`, and `skills/`
directories are the shared opencode tree.

## Clone or import

To use this repo as-is, clone it and open opencode from the repo root.

If you are importing the config into another opencode setup, copy the public
files (`opencode.jsonc`, `agents/`, `commands/`, `instructions/`, `profiles/`,
`skills/`) into that setup and keep any private overlay separate.

## Public vs private

Public baseline keeps shared model, agents, commands, and MCP servers that are
not machine-bound. OpenAI models use opencode's local account-based `/connect`
auth on each machine instead of a repo-stored API key.

Private overlay holds machine-specific or personal-only settings like:

- the Home Assistant MCP URL/token
- the local `semble` MCP command path
- anything else machine-specific

## Local-only overlay

On a personal machine, copy the example to an ignored local file:

```powershell
Copy-Item .\opencode.private.local.example.json .\opencode.private.local.json
```

Edit the copied file, keep it untracked, and point `OPENCODE_CONFIG` at it:

```powershell
$env:OPENCODE_CONFIG = (Resolve-Path .\opencode.private.local.json)
```

Then start `opencode` from the repo root. That loads the public
`opencode.jsonc` plus the explicit local overlay together. Use `/connect` in
`opencode` separately to authenticate OpenAI on each machine.

## Notes

- `opencode.jsonc` is intentionally safe to share.
- The repo is safe to publish without any private overlay tracked.
- `opencode.private.json` and `opencode.private.local.json` should stay
  untracked; `.gitignore` covers them.
