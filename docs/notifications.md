# Completion notifications (ntfy)

This document describes the optional, opt-in **ntfy** phone-notification plugin
for OpenCode 2.2.5. It restores a native 2.x equivalent of the disabled 1.x ntfy
plugin. It is written for the **user** to configure. The agent must not read,
print, or store a real endpoint or token.

## What it does

When enabled, the plugin listens to a small set of documented session events and
publishes a notification to **your own** ntfy endpoint when a **root** session:

- completes successfully (`session.execution.succeeded`) — the chat turn finished;
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
| root session success | `OpenCode` | `Session complete` | `default` |
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

## Optional click-through links

If `OPENCODE_WEB_URL` is set, every notification also carries an ntfy `Click`
header that opens the **exact root session** in the web UI. The link is built
only from the configured web root and the event's `sessionID`:

```text
<canonical OPENCODE_WEB_URL>/server/<base64url(UTF8(canonical OPENCODE_WEB_URL))>/session/<sessionID>
```

The plugin matches the web UI's key-relevant normalization before building the
key: it trims surrounding whitespace and strips **every** trailing slash. The
resulting canonical root is what gets encoded. For example, `http://opencode.example.test:1496`
and `http://opencode.example.test:1496///` both canonicalize to `http://opencode.example.test:1496`, whose key
is `aHR0cDovL29wZW5jb2RlLmV4YW1wbGUudGVzdDoxNDk2`.

The scheme is **not** defaulted. You must explicitly type `http://` or
`https://`; a bare host such as `opencode.example.test:1496` is rejected and disables only the
click link. Plain HTTP is therefore never selected silently.

`base64url` is the URL-safe base64 encoding of the canonical root (`UTF-8`, no
padding). The web UI uses that same key to select a server, so do not re-add a
trailing slash in the environment value.

Behavior and limits:

- Click links are **opt-in**. Without `OPENCODE_WEB_URL` there is no `Click`
  header and no other change; notifications behave exactly as before.
- An invalid `OPENCODE_WEB_URL` disables **only the click link**, not
  notifications. It never falls back to a default or event-derived host.
- The canonical web root must be an origin only: `http(s)://host[:port]`. Paths,
  queries, fragments, embedded credentials, and control characters are rejected.
- The origin must be **ASCII**. A non-ASCII host is rejected because it would
  make the `Click` header invalid and could cause the whole notification to
  fail. Supply the explicit punycode host (`xn--...`) instead; the plugin does
  not silently punycode or rewrite it.
- `sessionID` must be a single safe path segment (`A-Z`, `a-z`, `0-9`, `_`, `-`,
  at most 128 characters). An id that does not match is omitted from the click,
  never escaped or guessed.
- Only the `Click` header changes. The notification title, body, and other
  headers are unchanged, and the URL is never logged.

### Live check (user-reported)

The user reports one end-to-end live success: a completion notification arrived
and its `Click` link opened the exact session through a Tailscale MagicDNS web
root. This is a single user-reported check. Error and permission notifications,
child-session suppression, and service-environment inheritance were **not** part
of it and remain unverified live.

### Private disclosure: the link is visible to ntfy readers

A click URL necessarily reveals two things to everyone who can read the
notification: the configured OpenCode server address and the session id. That
includes:

- other subscribers to the same ntfy topic or server, and the server operator;
- the ntfy server's message history/retention (if enabled);
- notification history on the receiving phone, desktop, or sync service; and
- anyone the notification is forwarded or screenshotted to.

This is the intentional tradeoff you accept by enabling the field. A private
topic and a private/self-hosted ntfy server reduce exposure; a public or shared
topic does not. The session id is an identifier, not the session content, but it
may still be enough to locate the session in a shared UI. Do not enable click
links if that disclosure is unacceptable.

### HTTP is insecure: prefer HTTPS

Both `http:` and `https:` origins are accepted, but you must type the scheme
explicitly; the plugin never inserts `http://` for you. A user-provided
reachable **Tailscale MagicDNS** host such as `http://opencode.example.test:1496` is a common
private setup, but choosing HTTP is entirely your decision. The plugin does not
assume a hostname is on Tailscale, cannot verify the overlay's protections, and
makes no safety guarantee. **Being connected to Tailscale does not authenticate
the OpenCode server**: the overlay can carry the request, but it does not prove
which process is listening on that port or that the session UI is trusted.
Verify the host and service yourself.

Plain HTTP sends the click URL and the rest of the notification traffic in
cleartext to anyone on the path. Treat HTTP as safe only on a network you
control end to end (for example a protected WireGuard/Tailscale overlay with no
untrusted hops). **Prefer HTTPS** with a trusted certificate or a private CA.
The plugin performs **no automatic network, DNS, proxy, or certificate
changes** and does not add a proxy bypass.

## Child detection, seeding, and bounded state

- A session is treated as a **child** (subagent) session when a `session.created`
  event carries a `parentID`. Success, error, and permission events from a child
  are then suppressed.
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
  arrives, so a very early success/error event from such a child could notify once.
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

These rules apply to `NTFY_URL`, the publish endpoint. `OPENCODE_WEB_URL` has
its own origin-only rules and additionally allows `http:` (see the click-link
section above).

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
token is optional (anonymous ntfy topics work without one). Add a third,
optional field to enable click-through links.

```yaml
NTFY_URL: "https://ntfy.example.com/<your-private-topic>"
NTFY_TOKEN: "optional-bearer-token"
# Optional: web root used for click-through links. Private/local; see the
# disclosure and HTTP warning above. Omit it to keep notifications link-free.
OPENCODE_WEB_URL: "https://opencode.example.com"
```

`<your-private-topic>` is a placeholder. `OPENCODE_WEB_URL` is also a
placeholder; use the exact origin you open the web UI with (for example
`http://opencode.example.test:1496` on a protected Tailscale overlay). Never paste a real value
into chat, an issue, a command argument, or a committed file.

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

   The accepted-fields list should now include `NTFY_URL` and, if you set them,
   `NTFY_TOKEN` and `OPENCODE_WEB_URL`. `NTFY_TOKEN` is optional: its absence is
   expected for a public topic and is not an error. `OPENCODE_WEB_URL` is
   optional too: its absence simply leaves notifications without a click link.

3. Apply the environment with an idle service restart (same identity flag):

   ```text
   bun run scripts/secret-launch.ts --vault secrets/opencode.sops.yaml --age-encrypted-identity <identity-file>.age --restart
   ```

   Run this only while sessions are idle. Environment changes require a service
   restart; a config-only `opencode reload` does not refresh the environment.

### Disable

Remove `NTFY_URL` (and optionally `NTFY_TOKEN`) from the vault and restart the
service, or leave them out entirely. With no `NTFY_URL`, the plugin performs no
subscription and no network calls. Remove `OPENCODE_WEB_URL` to keep
notifications but drop click links; an invalid value for it also disables only
the link.

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
- Only `NTFY_URL`, `NTFY_TOKEN`, and `OPENCODE_WEB_URL` are recognized. Legacy
  keys with other names are ignored; re-enter the endpoint and token under these
  names. `OPENCODE_WEB_URL` is new and is not part of the 1.x settings.
- The ntfy publish endpoint must be HTTPS. A legacy `http://` value will not
  work. (`OPENCODE_WEB_URL` may be HTTP only for a reachable private overlay;
  see the warning above.)
- The plugin does not import any 1.x options (message templates, icons, or other
  fields); only the fixed, privacy-preserving bodies above are sent.

## The 2.2.5 completion event

The installed 2.2.5 SDK still declares both `session.idle` and
`session.execution.succeeded`, but they are not equivalent:

- `session.execution.succeeded` is the terminal success event. Its exact
  envelope is `{ id, created, metadata?, type: "session.execution.succeeded",
  durable: { aggregateID, seq, version }, location?, data: { sessionID } }`.
  The installed 2.2.5 CLI runtime uses it to mark a session idle/completed and
  emits it when a turn succeeds.
- `session.idle` remains in the schema as a legacy status event, but the
  installed 2.2.5 runtime does not publish it. Subscribing to it therefore
  misses completions.

The plugin subscribes only to `session.execution.succeeded` for completion, not
to `session.idle` and not to `session.status`. If a future runtime emits both
terminal events for one turn, the legacy idle event is ignored, so there is no
dual subscription and no duplicate completion alert. Event-id deduplication
still protects against redelivery of the same event.

## Honest limitations (needs a live check)

The plugin is built against the installed 2.2.5 type declarations and runtime
strings and is covered by hermetic tests (fake event stream, fake fetch). The
following are **not** proven offline and need a live, idle restart check:

- That `session.execution.succeeded` fires exactly once per completed turn and at
  the expected time in a running service (as opposed to a different event or
  cadence).
- That `session.execution.failed` fires for every failed root turn (and only for
  failures worth a phone alert), rather than another step- or retry-level event.
- Whether `session.execution.succeeded` and `session.execution.failed` can both
  fire for the same turn. The installed SDK documents that the
  `experimental.idle` hook "does not run after interruption, failure, or
  control-only work", which is supporting evidence for mutual exclusivity, but
  that is a hook contract rather than a proof about the event stream itself.
- How a child session's success is delivered while its parent is still working,
  and whether the `session.created` `parentID` always arrives before a child's
  first success event.
- That the background service actually inherits `NTFY_URL`/`NTFY_TOKEN` after
  `--restart` (the same unverified inheritance noted in `docs/secrets.md`).
- The user reports that a completion notification reached the phone and that its
  ntfy `Click` header opened the exact session in the deployed web UI through a
  Tailscale MagicDNS root. That is a user report, not an independently repeated
  test here.
- Error and permission notifications were not part of that user-reported live
  check, so their delivery and click behavior remain unverified live. Child
  suppression and service-environment inheritance are likewise unverified live.

Treat the completion-plus-click path as user-reported live success; treat the
error and permission paths as tested scaffolding until separately checked.
