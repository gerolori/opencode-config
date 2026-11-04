# Completion notifications (ntfy)

This document describes the optional, opt-in **ntfy** phone-notification plugin
for OpenCode 2.2.5. It restores a native 2.x equivalent of the disabled 1.x ntfy
plugin. It is written for the **user** to configure. The agent must not read,
print, or store a real endpoint or token.

## What it does

When enabled, the plugin listens to a small set of documented session events and
publishes a notification to **your own** ntfy endpoint when a **root** session:

- goes idle (`session.idle`) — the chat turn completed;
- fails (`session.execution.failed`) — the turn errored; or
- raises a permission ask (`permission.asked`).

Subagent **child** sessions are suppressed so a task does not produce a burst of
notifications. Each event is deduplicated by its unique id, so a redelivered
event never notifies twice. Only one subscription is created per process.

## Privacy by default

Notification bodies are deliberately minimal and contain **no** prompt, message,
session title, file path, command, tool output, or error text. The plugin never
reads session content. It sends only:

| Trigger | Title | Message | Priority |
| --- | --- | --- | --- |
| root session idle | `OpenCode` | `Session idle` | `default` |
| root session failed | `OpenCode` | `Session error` | `high` |
| root permission ask | `OpenCode` | `Permission needed` | `high` |

The message is a fixed string in every case. The structured `error` object on
`session.execution.failed` (which can contain provider text) is **never** read,
and the `action`/`resources` on `permission.asked` are **never** read or echoed
(a permission action can be an arbitrary user- or plugin-defined string). So no
error detail, action label, or other free-form text leaves the machine.

The plugin deliberately does **not** notify on interruptions
(`session.execution.interrupted`), per-step failures (`session.step.failed`),
retries (`session.retry.scheduled`), compaction failures, or tool failures.
Those are either user-initiated or transient and would create notification noise.

## Child detection, seeding, and bounded state

- A session is treated as a **child** (subagent) session when a `session.created`
  event carries a `parentID`. Idle, error, and permission events from a child are
  then suppressed.
- The event subscription is established **before** the child seed, and events
  that arrive while the seed is pending are buffered (bounded) and then
  dispatched in order. This avoids dropping root events during the seed while
  still letting pre-existing children be suppressed. The buffer is capped at
  2048 events; if it overflows, it is flushed early and dispatch continues live,
  so a pre-existing child not yet seeded could notify once (rare).
- At startup the plugin also tries to seed known children from
  `context.session.list()`. This is a **best-effort, point-in-time snapshot**:
  - it may return only the first page (the client response carries a cursor the
    plugin does not follow), so an older child beyond that page may be unknown;
  - a session created concurrently with startup may not appear in the snapshot;
  - if the call fails or does not answer within about two seconds, seeding is
    skipped and observation-only child tracking is used.
  A child that is not yet known is treated as a root until its `session.created`
  arrives, so a very early idle/error event from such a child could notify once.
  The window is small and self-correcting as soon as the child's creation event
  is seen.
- The known-child set and the event-deduplication set are each bounded (4096
  entries, oldest-first eviction), so a long-lived process cannot grow without
  limit. After eviction a very old child id is no longer suppressed and could
  notify again (rare).

## Failure and teardown handling

- Subscribing to the event stream is a synchronous call that can fail. If it
  throws, the plugin disables itself for that start rather than failing plugin
  setup; a later start can take over.
- A **disabled re-setup** (for example after the URL is removed) aborts any prior
  subscription instead of leaving it running.
- Publishing is fire-and-forget and bounded by a short timeout. A publish
  failure never affects the session and never surfaces endpoint details.
- On cleanup, or when a newer start supersedes the current one, the event
  subscription is aborted and any in-flight publish is aborted with it.
- An `onError` callback that itself throws is contained; it cannot become an
  unhandled rejection or break the notification path.

## Endpoint rules (safe defaults)

- Only an absolute **`https://`** URL is accepted. Plain HTTP and other schemes
  are rejected, so a misconfiguration cannot downgrade the notification or leak
  the topic in cleartext.
- URLs with embedded credentials or a `#fragment` are rejected.
- A malformed value **disables** notifications; there is **no** fallback to a
  default host. The plugin never invents an endpoint.
- The configured URL is treated as sensitive because the ntfy topic is the
  capability. The plugin never logs the URL or token, and failures are reported
  generically.

Point the URL only at a service **you** control: your own ntfy server or an ntfy
topic you created. Do not paste in arbitrary third-party URLs.

## Enable with the SOPS vault (recommended)

Add two top-level fields to the vault. The endpoint itself is sensitive; the
token is optional (anonymous ntfy topics work without one).

```yaml
NTFY_URL: "https://ntfy.example.com/<your-private-topic>"
NTFY_TOKEN: "optional-bearer-token"
```

`<your-private-topic>` is a placeholder. Use your own server or topic; never
paste a real value into chat, an issue, a command argument, or a committed file.

**Token handling is fail-closed.** Omitting `NTFY_TOKEN` entirely is allowed for
an intentionally public topic. But if `NTFY_TOKEN` is *present* and unusable —
whitespace-only, with leading/trailing whitespace, or containing any control
character (CR, LF, TAB, and similar) — notifications are **disabled**, not sent
unauthenticated. The plugin never trims a secret to make it "work" and never
silently drops a bad token to publish to what may be a private topic. Fix the
vault value (or remove the field for a public topic) and restart.

Note the two layers: the SOPS vault parser itself rejects a truly **empty**
value (`NTFY_TOKEN:` with no value, or `NTFY_TOKEN: ""`), so an empty token
cannot reach the plugin through the vault. A whitespace-only or control-character
token *is* accepted by the vault parser and is then rejected by the plugin
(fail-closed). An empty value in the ambient service environment is also
rejected by the plugin.

Steps (user-run; see `docs/secrets.md` for the full flow):

1. Edit the vault locally with the launcher's editor. If you use the
   password-protected identity (the user-tested path), pass it as
   `--age-encrypted-identity`; a raw `sops <file>` or `--age-key-file
   <identity-file>` will fail when only the passphrase-protected `.age` file
   exists.

   ```text
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-encrypted-identity <identity-file>.age --edit
   ```

   The editor receives plaintext through SOPS and may create temp/swap files;
   follow the mitigations in `docs/secrets.md`. If you use the plaintext local
   age key instead, replace the flag with `--age-key-file <identity-file>`.

2. Dry run to confirm the fields are accepted (names only, no values printed).
   Use the same identity flag you will use later:

   ```text
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-encrypted-identity <identity-file>.age
   ```

   The accepted-fields list should now include `NTFY_URL` and, if you set one,
   `NTFY_TOKEN`. `NTFY_TOKEN` is optional: its absence is expected for a public
   topic and is not an error.

3. Apply the environment with an idle service restart (same identity flag):

   ```text
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-encrypted-identity <identity-file>.age --restart
   ```

   Run this only while sessions are idle. Environment changes require a service
   restart; a config-only `opencode reload` does not refresh the environment.

### Disable

Remove `NTFY_URL` (and optionally `NTFY_TOKEN`) from the vault and restart the
service, or leave them out entirely. With no `NTFY_URL`, the plugin performs no
subscription and no network calls.

## Migrating from the legacy private config

The previous 1.x setup used an ignored, private `notification-ntfy.json` file.
That file is **not** read by the 2.x plugin and is intentionally ignored by Git.
Recommended migration:

1. Open `notification-ntfy.json` **locally** yourself. Do **not** paste its
   contents, URL, or token into chat, an issue, or a command line.
2. Manually re-enter the endpoint as `NTFY_URL` and the token (if any) as
   `NTFY_TOKEN` in the SOPS vault, following the steps above.
3. Restart the service during an idle window and confirm a notification arrives.

Incompatibilities with the legacy private settings:

- The 1.x JSON file is not consulted at all.
- Only `NTFY_URL` and `NTFY_TOKEN` are recognized. Legacy keys with other names
  are ignored; re-enter the endpoint and token under these names.
- The endpoint must be HTTPS. A legacy `http://` value will not work.
- The plugin does not import any 1.x options (message templates, icons, or other
  fields); only the fixed, privacy-preserving bodies above are sent.

## Honest limitations (needs a live check)

The plugin is built against the installed 2.2.5 type declarations and is covered
by hermetic tests (fake event stream, fake fetch). The following are **not**
proven offline and need a live, idle restart check:

- That `session.idle` fires exactly once per completed turn and at the expected
  time in a running service (as opposed to a different event or cadence).
- That `session.execution.failed` fires for every failed root turn (and only for
  failures worth a phone alert), rather than another step- or retry-level event.
- Whether `session.idle` and `session.execution.failed` can both fire for the
  same turn. The installed SDK documents that the `experimental.idle` hook "does
  not run after interruption, failure, or control-only work", which is
  supporting evidence for mutual exclusivity, but that is a hook contract rather
  than a proof about the event stream itself.
- How a child session's idle is delivered while its parent is still working, and
  whether the `session.created` `parentID` always arrives before a child's first
  idle event.
- That the background service actually inherits `NTFY_URL`/`NTFY_TOKEN` after
  `--restart` (the same unverified inheritance noted in `docs/secrets.md`).
- That a live publish reaches your phone (this task performed no network call).

Until a live check passes, treat the plugin as tested scaffolding.
