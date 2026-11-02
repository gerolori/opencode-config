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
