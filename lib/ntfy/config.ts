/**
 * NTFY notification configuration.
 *
 * Notifications are opt-in: the plugin does nothing unless `NTFY_URL` is set in
 * the background service environment (normally loaded from the SOPS vault). The
 * endpoint is treated as sensitive because, for ntfy, the topic in the URL is a
 * capability: anyone who knows the URL can publish to it. This module never
 * logs, returns in an error, or otherwise echoes the configured URL or token.
 *
 * A malformed or insecure URL disables notifications outright. It never falls
 * back to a default host, so a misconfiguration cannot send data to an
 * unintended service. Token handling is likewise fail-closed: a token that is
 * present but unusable disables the config instead of downgrading to an
 * unauthenticated publish. A token that is simply absent is allowed, for an
 * intentionally public topic.
 */

export const NTFY_URL_ENV = "NTFY_URL";
export const NTFY_TOKEN_ENV = "NTFY_TOKEN";

export interface NtfyConfig {
  /** The validated absolute HTTPS publish URL, including the topic path. */
  readonly url: string;
  /** Optional bearer token for a protected ntfy instance. */
  readonly token?: string;
}

export type NtfyConfigResult =
  | { readonly enabled: true; readonly config: NtfyConfig }
  | {
      readonly enabled: false;
      readonly reason: "not-configured" | "invalid-url" | "invalid-token";
    };

/**
 * Any C0 control character or DEL. This deliberately includes TAB (`\u0009`),
 * LF (`\u000A`), and CR (`\u000D`): an endpoint or bearer token containing line
 * breaks or tabs is invalid and could be a header-injection vector. This rule is
 * scoped to ntfy config validation only; the SOPS vault parser's scalar rules
 * are unchanged.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Validate an ntfy publish endpoint.
 *
 * Only an absolute `https:` URL with a host, no embedded credentials, and no
 * fragment is accepted. Plain HTTP is rejected so a misconfiguration cannot
 * downgrade the notification or expose the topic in cleartext. `undefined` is
 * returned for anything invalid; the value is never included in an error.
 */
export function parseNtfyUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "" || CONTROL_CHARS.test(value)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:") return undefined;
  if (parsed.hostname === "") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.hash !== "") return undefined;

  return parsed.toString();
}

/**
 * Resolve the notification configuration from the service environment.
 *
 * `not-configured` is the normal disabled state (no URL). `invalid-url` and
 * `invalid-token` also disable, so a bad value is inert rather than silently
 * ignored or downgraded.
 */
export function resolveNtfyConfig(
  env: Record<string, string | undefined>,
): NtfyConfigResult {
  const rawUrl = env[NTFY_URL_ENV];
  if (rawUrl === undefined || rawUrl.trim() === "") {
    return { enabled: false, reason: "not-configured" };
  }

  const url = parseNtfyUrl(rawUrl);
  if (url === undefined) {
    return { enabled: false, reason: "invalid-url" };
  }

  // Token handling is fail-closed. A present token is rejected rather than
  // trimmed: it is a secret, so the value sent must be exactly what was
  // configured. Empty, whitespace-only, leading/trailing whitespace, or any
  // control character disables notifications instead of sending an
  // unauthenticated request to what may be a private topic. A genuinely missing
  // key (undefined) is still allowed for an intentionally public topic.
  const rawToken = env[NTFY_TOKEN_ENV];
  let token: string | undefined;
  if (rawToken !== undefined) {
    if (
      rawToken === "" ||
      rawToken !== rawToken.trim() ||
      CONTROL_CHARS.test(rawToken)
    ) {
      return { enabled: false, reason: "invalid-token" };
    }
    token = rawToken;
  }

  return { enabled: true, config: { url, token } };
}
