# OpenCode 2.0 upgrade handoff

Status: **work in progress**. The 2.0 upgrade has not been performed. Do not treat
this checkpoint as production-ready or as compatible with 2.0.

Last reported runtime and SDK: **1.19.5**. This is prior evidence, not a fresh
verification of this checkpoint.

## Implemented

- Single-level agents
- Worker-only tracker
- Low-effort workers
- Retrieval policy and TinyFish adapter
- Exit-safe SQZ output compression
- Lazy memory protocol
- Portable host initialization

## Evidence and review state

- Last reported result: **182 passing tests, one POSIX-only skip, no failures**.
  This is prior evidence, not a fresh test run for this checkpoint.
- The latest policy fixes have **not** received their final independent re-review.

## Configuration notes

- Main configured model: `openrouter/gpt-6-luna`, with explicit API ID
  `openai/gpt-6-luna`.
- Workers use explicit DeepSeek API IDs.
- The `retrieval_control` action `reset_provider`, durable per-query provider
  limits, and durable retry counters may still need documentation updates.
- Documentation may still describe the old main model reference, mandatory host
  overrides, or pending Semble/SQZ portability work even though those code
  changes are implemented.

## 2.0 preparation quarantine

Prepared from checkpoint `23663dbd4988bc40e27d56a353af38292600e1ca`. The runtime is
still 1.19.5; the upgrade has not been run.

- `opencode.jsonc` now has `"plugin": []`.
- The tracked `plugins/` directory was moved to `plugins.1x-disabled/` without
  editing either file. It is a temporary source archive only and must not be
  registered as a plugin path.
- Disabled local plugins: `plugins/retrieval-policy.ts`, `plugins/sqz.ts`.
- Original configured package specifiers:
  - `@tarquinen/opencode-dcp@3.1.9`
  - `@franlol/opencode-md-table-formatter@0.0.3`
  - `cc-safety-net@0.8.2`
  - `@tarquinen/opencode-smart-title@0.1.7`
  - `@bastiangx/opencode-unmoji@0.3.12`
  - `opencode-ntfy.sh@1.1.0`

This is a transitional, plugin-free configuration. It has **not** been validated
on OpenCode 2.0.

### Restoration if the upgrade is cancelled

1. Restore the config:
   `git checkout 23663dbd4988bc40e27d56a353af38292600e1ca -- opencode.jsonc`
   (or manually restore the exact specifiers above).
2. Restore discovery: `git mv plugins.1x-disabled plugins`.
3. Re-run the 1.x checks. If the preparation commit is HEAD, a single
   `git revert <preparation-commit>` is the cleanest reversible step.

### Transitional test/import failures

Tests, scripts, or imports that reference `plugins/` may fail while the directory
is quarantined. Do not rewrite them to load the incompatible 1.x plugins. Leave
them failing until migration or restoration; this is expected in the transitional
state.

## Unfinished checks after the upgrade

- Verify the actual runtime version and configuration migration.
- Verify SDK compatibility.
- Verify local plugin discovery.
- Verify permission behavior.
- Run a fresh test campaign; the prior 182-test result is not a re-verification.
- Verify actual outgoing provider requests. These have not been verified.
- Complete the interactive/manual ChatGPT login and Exa/TinyFish key checks.

## Process note

The user corrected the supervisor's unreadable delegation prompts. Future prompts
should use normal language and structured sections. This is a task handoff note,
not an automatically approved permanent memory rule.
