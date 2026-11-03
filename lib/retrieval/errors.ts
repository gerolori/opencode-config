import type { ErrorCategory } from "./types";

export const COOLDOWN_MS = {
  auth: 60 * 60_000,
  quota: 5 * 60_000,
  captcha: 10 * 60_000,
  access_denied: 10 * 60_000,
  unknown: 60_000,
  transientRetry: 30_000,
} as const;

const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

export function isHardCategory(category: ErrorCategory): boolean {
  return (
    category === "auth" ||
    category === "quota" ||
    category === "captcha" ||
    category === "access_denied"
  );
}

/** Parse a structured Retry-After signal when one is actually present. */
export function parseRetryAfterMs(
  metadata: unknown,
  errorText: string,
  now: number,
): number | undefined {
  const fromMeta = retryAfterFromMetadata(metadata, now);
  if (fromMeta !== undefined) return fromMeta;
  return retryAfterFromText(errorText);
}

function retryAfterFromMetadata(metadata: unknown, now: number): number | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as Record<string, unknown>;
  const headers = m.headers;
  if (headers && typeof headers === "object") {
    const h = headers as Record<string, unknown>;
    const headerValue = h["retry-after"] ?? h["Retry-After"] ?? h["RETRY-AFTER"];
    const parsed = parseRetryValue(headerValue, now, false);
    if (parsed !== undefined) return parsed;
  }
  const direct =
    m.retryAfterMs ??
    m.retry_after_ms ??
    m.retryAfter ??
    m.retry_after ??
    m.retry_after_seconds;
  return parseRetryValue(direct, now, String(Object.keys(m).find((k) => k === "retryAfterMs" || k === "retry_after_ms") ?? "") !== "");
}

function parseRetryValue(value: unknown, now: number, forceMs: boolean): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const ms = forceMs || value >= 100_000 ? value : value * 1000;
    return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    const ms = forceMs || numeric >= 100_000 ? numeric : numeric * 1000;
    return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
  }
  const match = trimmed.match(
    /retry[-\s]?after[^0-9]{0,16}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?|m|min(?:ute)?s?)?/i,
  );
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit.startsWith("ms")
    ? 1
    : unit.startsWith("m") && !unit.startsWith("ms")
      ? 60_000
      : 1000;
  return Math.min(Math.round(amount * multiplier), MAX_RETRY_AFTER_MS);
}

function retryAfterFromText(text: string): number | undefined {
  const match = text.match(
    /retry[-\s]?after[^0-9]{0,16}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:ond)?s?|m|min(?:ute)?s?)?/i,
  );
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = unit.startsWith("ms")
    ? 1
    : unit.startsWith("m") && !unit.startsWith("ms")
      ? 60_000
      : 1000;
  return Math.min(Math.round(amount * multiplier), MAX_RETRY_AFTER_MS);
}

/**
 * Classify a failed tool outcome from a 2.x Tool.Error message or structured
 * after-hook failure metadata.
 * This function is only called for actual error parts, never for page text.
 */
export function categorizeError(
  errorText: string,
  metadata?: unknown,
  now = Date.now(),
): {
  category: ErrorCategory;
  retryAfterMs?: number;
} {
  const text = errorText ?? "";
  const retryAfterMs = parseRetryAfterMs(metadata, text, now);

  if (/\bcaptcha\b|bot[-\s]?challenge|verify (?:you are|you're) human|cloudflare challenge/i.test(text)) {
    return { category: "captcha", retryAfterMs };
  }
  if (
    /access denied|access[-\s]?denied|blocked by (?:site|policy|administrator)|robots\.txt|egress|network policy|forbidden site|site (?:is )?blocked|\b403\b/i.test(
      text,
    )
  ) {
    return { category: "access_denied", retryAfterMs };
  }
  if (
    /\b429\b|rate[-\s]?limit|too many requests|quota|credit|insufficient|payment required|\b402\b|billing|usage limit/i.test(
      text,
    )
  ) {
    return { category: "quota", retryAfterMs };
  }
  if (
    /\b401\b|unauthori[sz]ed|invalid (?:api[-\s]?)?key|api[-\s]?key|authentication|not authenticated|token (?:expired|invalid)|missing (?:api[-\s]?)?key/i.test(
      text,
    )
  ) {
    return { category: "auth", retryAfterMs };
  }
  if (
    /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|network|fetch failed|socket hang up|\b5\d\d\b|temporar|overloaded|service unavailable|connection reset/i.test(
      text,
    )
  ) {
    return { category: "transient", retryAfterMs };
  }
  return { category: "unknown", retryAfterMs };
}

export type CooldownPlan = {
  cooldownUntil?: number;
  requiresOperator: boolean;
  cooldownMs: number;
};

/**
 * Hard category cooldowns are bounded. An explicit Retry-After is honored;
 * otherwise auth/quota require an operator to clear the circuit instead of
 * inventing a monthly reset or busily retrying.
 */
export function planCooldown(
  category: ErrorCategory,
  retryAfterMs: number | undefined,
  now: number,
): CooldownPlan {
  if (category === "transient") {
    return {
      cooldownUntil: now + COOLDOWN_MS.transientRetry,
      requiresOperator: false,
      cooldownMs: COOLDOWN_MS.transientRetry,
    };
  }
  const base =
    category === "auth"
      ? COOLDOWN_MS.auth
      : category === "quota"
        ? COOLDOWN_MS.quota
        : category === "captcha"
          ? COOLDOWN_MS.captcha
          : category === "access_denied"
            ? COOLDOWN_MS.access_denied
            : COOLDOWN_MS.unknown;
  const cooldownMs =
    retryAfterMs !== undefined ? Math.min(Math.max(retryAfterMs, 0), MAX_RETRY_AFTER_MS) : base;
  // Auth without a provider-supplied expiry needs a human/operator. Quota
  // without an expiry is treated as an unknown depletion with a bounded TTL
  // (5 minutes), never as an invented monthly reset.
  const requiresOperator = category === "auth" && retryAfterMs === undefined;
  return {
    cooldownUntil: now + cooldownMs,
    requiresOperator,
    cooldownMs,
  };
}
