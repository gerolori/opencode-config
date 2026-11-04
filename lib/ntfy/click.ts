/**
 * Optional ntfy click-through links.
 *
 * When `OPENCODE_WEB_URL` is configured, each notification carries an ntfy
 * `Click` header pointing at the exact web session. The 2.2.5 CLI/UI route is:
 *
 *   <web-root>/server/<base64url(UTF8(UI-canonical server URL))>/session/<sessionID>
 *
 * The key must be computed from the same canonical string the web UI uses:
 * trimmed and with all trailing slashes removed. The scheme is never defaulted;
 * the user must explicitly supply `http://` or `https://`.
 *
 * This module is pure. It never logs, reads the network, or derives a host from
 * an event. It only ever uses the single configured web root.
 */

export const OPENCODE_WEB_URL_ENV = "OPENCODE_WEB_URL";

/**
 * The web root must be an origin only. A path, query, fragment, or embedded
 * credentials could redirect the click somewhere unexpected, so they are
 * rejected. Both `http:` and `https:` are accepted: a protected overlay such as
 * Tailscale may intentionally use plain HTTP on a private MagicDNS host.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Header values must be printable ASCII. A non-ASCII host in the `Click` header
 * can make the whole publish fail (and lose the notification), so such origins
 * are rejected. The user can supply the explicit punycode (`xn--...`) form.
 */
const HEADER_SAFE = /^[\x21-\x7E]+$/;

/**
 * Session ids are used as a single URL path segment. Restrict them to an
 * unambiguous, traversal-free, percent-encoding-free alphabet. This is a safe
 * subset of the identifiers the runtime actually emits.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Match the web UI's key-relevant normalization: trim surrounding whitespace
 * and strip every trailing slash. Unlike the UI's input helper, this function
 * does **not** default a missing scheme: the user must explicitly configure
 * `http://` or `https://`, so plain HTTP is never selected silently.
 */
function normalizeServerUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  if (!/^https?:\/\//.test(trimmed)) return undefined;
  return trimmed.replace(/\/+$/, "");
}

export interface NtfyClickConfig {
  /** The UI-canonical web root (trimmed, trailing slashes stripped). */
  readonly webUrl: string;
  /** `base64url(UTF8(webUrl))`, the value the UI uses to select a server. */
  readonly serverKey: string;
}

export function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/**
 * Validate a configured web root and return its UI-canonical form.
 * `undefined` disables click links only; it never disables notifications or
 * invents a host.
 */
export function parseOpenCodeWebUrl(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (CONTROL_CHARS.test(raw)) return undefined;

  const value = normalizeServerUrl(raw);
  if (value === undefined) return undefined;
  if (!HEADER_SAFE.test(value)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.hostname === "") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  // Origin root only: `new URL("http://host")` reports "/", so both are roots.
  if (parsed.pathname !== "" && parsed.pathname !== "/") return undefined;

  return value;
}

/** Encode the exact server URL as the base64url server key the UI expects. */
export function encodeServerKey(serverUrl: string): string {
  return Buffer.from(serverUrl, "utf8").toString("base64url");
}

export function resolveNtfyClickConfig(raw: string | undefined): NtfyClickConfig | undefined {
  const webUrl = parseOpenCodeWebUrl(raw);
  if (webUrl === undefined) return undefined;
  return { webUrl, serverKey: encodeServerKey(webUrl) };
}

/**
 * Build the click URL for one session. Returns `undefined` for an unsafe
 * session id. `config.webUrl` is already UI-canonical, so no slash rewriting is
 * needed here.
 */
export function buildSessionClickUrl(
  config: NtfyClickConfig,
  sessionID: string,
): string | undefined {
  if (!isSafeSessionId(sessionID)) return undefined;
  return `${config.webUrl}/server/${config.serverKey}/session/${sessionID}`;
}
