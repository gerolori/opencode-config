/**
 * NTFY completion-notification plugin (OpenCode 2.2.5).
 *
 * This file lives in the auto-discovered `plugins/` directory and must not be
 * listed again in opencode.jsonc. It is disabled unless `NTFY_URL` is present in
 * the background service environment (normally loaded from the SOPS vault via
 * `scripts/secret-launch.ts`). See `docs/notifications.md`.
 *
 * Safety at a glance:
 * - opt-in: no configuration means no subscription and no network calls;
 * - the endpoint must be an absolute HTTPS URL; plain HTTP and malformed values
 *   disable notifications instead of falling back to a default host;
 * - child (subagent) sessions are suppressed and each event id is deduplicated
 *   so a completed turn, an error, or a permission ask cannot storm the phone;
 * - notification bodies carry no prompt, message, title, path, command, or error
 *   text;
 * - publishing is fire-and-forget and failures are swallowed (nonfatal);
 * - the endpoint and token are never logged.
 */

import { Plugin } from "@opencode/plugin";
import { startNtfyNotifications, type NtfyPluginContext } from "../lib/ntfy/plugin";

export default Plugin.define({
  id: "notification-ntfy",
  async setup(context) {
    return startNtfyNotifications(context as unknown as NtfyPluginContext);
  },
});
