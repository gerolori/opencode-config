import { categorizeError, parseRetryAfterMs } from "./errors";
import type {
  ErrorCategory,
  RateLimitResult,
  TinyFishProviderBridge,
} from "./types";

export const TINYFISH_ENDPOINT = "https://api.search.tinyfish.ai";
export const TINYFISH_MAX_RESULTS = 5;
export const TINYFISH_MAX_RESPONSE_BYTES = 262_144;
export const TINYFISH_DEFAULT_TIMEOUT_MS = 8_000;
export const TINYFISH_MAX_TIMEOUT_MS = 15_000;

export type TinyFishSearchArgs = {
  query: string;
  max_results?: number;
};

export type TinyFishSnippet = {
  url: string;
  title: string;
  snippet: string;
};

export type TinyFishErrorCode =
  | "missing_api_key"
  | "provider_unavailable"
  | "local_rate_limit"
  | "persistence_degraded"
  | "provider_rate_limited"
  | "provider_auth"
  | "provider_access_denied"
  | "provider_captcha"
  | "timeout"
  | "network"
  | "http_error"
  | "redirect_forbidden"
  | "response_too_large"
  | "bad_response";

export type TinyFishOutcome =
  | {
      ok: true;
      provider: "tinyfish";
      evidence_type: "snippet";
      results: TinyFishSnippet[];
      latency_ms: number;
      remaining?: RateLimitResult["remaining"];
    }
  | {
      ok: false;
      provider: "tinyfish";
      evidence_type: "none";
      code: TinyFishErrorCode;
      message: string;
      latency_ms: number;
      error_category?: ErrorCategory;
      retry_after_ms?: number;
      remaining?: RateLimitResult["remaining"];
    };

export type TinyFishClientOptions = {
  bridge: TinyFishProviderBridge;
  env?: Record<string, string | undefined>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

/**
 * Bounded direct adapter for the official TinyFish Search API.
 *
 * This deliberately does not invoke any MCP tool, spawn a server, or touch
 * TinyFish Agent/Browser/wallet APIs. It returns snippets and URLs only.
 */
export class TinyFishClient {
  private readonly bridge: TinyFishProviderBridge;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: TinyFishClientOptions) {
    this.bridge = options.bridge;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? TINYFISH_DEFAULT_TIMEOUT_MS, 1),
      TINYFISH_MAX_TIMEOUT_MS,
    );
    this.maxResponseBytes = options.maxResponseBytes ?? TINYFISH_MAX_RESPONSE_BYTES;
  }

  get apiKeyConfigured(): boolean {
    return Boolean(this.env.TINYFISH_API_KEY?.trim());
  }

  async search(args: TinyFishSearchArgs): Promise<TinyFishOutcome> {
    const started = this.now();
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return this.fail("bad_response", "search query must not be empty", started);
    }
    const key = this.env.TINYFISH_API_KEY?.trim();
    if (!key) {
      return this.fail("missing_api_key", "TINYFISH_API_KEY is not configured", started);
    }

    const availability = this.bridge.availability();
    if (!availability.available) {
      if (availability.reason === "missing_api_key") {
        return this.fail("missing_api_key", "TINYFISH_API_KEY is not configured", started);
      }
      if (availability.reason === "provider_operator_action_required" ||
          availability.reason === "provider_circuit_open") {
        return this.fail(
          "provider_unavailable",
          "TinyFish provider circuit is open",
          started,
          undefined,
          availability.nextAvailable,
        );
      }
      if (
        availability.reason === "provider_unavailable" &&
        availability.nextAvailable &&
        availability.rateRemaining
      ) {
        return this.fail(
          "local_rate_limit",
          "local TinyFish call cap reached",
          started,
          undefined,
          undefined,
          Math.max(0, availability.nextAvailable - started),
          availability.rateRemaining,
        );
      }
      return this.fail("provider_unavailable", "TinyFish is not currently eligible", started);
    }

    const limit = await this.bridge.consumeCall();
    if (!limit.allowed) {
      if (limit.reason === "persistence") {
        return this.fail(
          "persistence_degraded",
          "local TinyFish call counters could not be persisted",
          started,
        );
      }
      return this.fail(
        "local_rate_limit",
        "local TinyFish call cap reached",
        started,
        undefined,
        undefined,
        limit.retryAfterMs,
        limit.remaining,
      );
    }

    const url = new URL(TINYFISH_ENDPOINT);
    url.searchParams.set("query", query.slice(0, 2_000));

    const controller = new AbortController();
    let deadlineFired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadlineFired = true;
        controller.abort();
        reject(new RequestDeadlineError());
      }, this.timeoutMs);
    });
    let response: Response | undefined;
    try {
      response = await Promise.race([
        this.fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            "X-API-Key": key,
            Accept: "application/json",
            "User-Agent": "opencode-retrieval-policy/1.0",
          },
          redirect: "error",
          signal: controller.signal,
        }),
        deadline,
      ]);

      if (response.redirected) {
        return this.fail(
          "redirect_forbidden",
          "TinyFish redirects are refused to protect the API key",
          started,
        );
      }
      if (response.url) {
        let host = "";
        try {
          host = new URL(response.url).hostname;
        } catch {
          host = "";
        }
        if (host && host !== "api.search.tinyfish.ai") {
          return this.fail(
            "redirect_forbidden",
            "TinyFish response came from an unexpected host",
            started,
          );
        }
      }

      if (!response.ok) {
        return this.failFromHttp(response, started);
      }

      let text: string;
      try {
        text = await Promise.race([
          readCapped(response, this.maxResponseBytes),
          deadline,
        ]);
      } catch (error) {
        if (error instanceof ResponseTooLarge) {
          return this.fail("response_too_large", "TinyFish response exceeded the byte cap", started);
        }
        throw error;
      }
      return this.parseSuccess(text, args, started, limit.remaining);
    } catch (error) {
      if (error instanceof ResponseTooLarge) {
        return this.fail("response_too_large", "TinyFish response exceeded the byte cap", started);
      }
      if (error instanceof Error && /redirect/i.test(error.message)) {
        return this.fail(
          "redirect_forbidden",
          "TinyFish redirects are refused to protect the API key",
          started,
        );
      }
      const aborted =
        deadlineFired ||
        controller.signal.aborted ||
        error instanceof RequestDeadlineError ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"));
      if (response?.body) {
        try {
          void response.body.cancel().catch(() => undefined);
        } catch {
          // ignore stalled-stream cancel failure
        }
      }
      return this.fail(
        aborted ? "timeout" : "network",
        aborted ? "TinyFish request timed out" : "TinyFish network request failed",
        started,
        "transient",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseSuccess(
    text: string,
    args: TinyFishSearchArgs,
    started: number,
    remaining: RateLimitResult["remaining"] | undefined,
  ): TinyFishOutcome {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.fail("bad_response", "TinyFish returned invalid JSON", started, "unknown");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).results)) {
      return this.fail("bad_response", "TinyFish response has no results array", started, "unknown");
    }

    const max = Math.max(
      1,
      Math.min(
        TINYFISH_MAX_RESULTS,
        Number.isFinite(args.max_results) ? Math.floor(args.max_results as number) : TINYFISH_MAX_RESULTS,
      ),
    );
    const results: TinyFishSnippet[] = [];
    for (const raw of (parsed as any).results) {
      if (results.length >= max) break;
      if (!raw || typeof raw !== "object") continue;
      const urlValue = typeof raw.url === "string" ? raw.url : "";
      if (!urlValue) continue;
      results.push({
        url: urlValue,
        title: typeof raw.title === "string" ? raw.title : "",
        snippet: typeof raw.snippet === "string" ? raw.snippet : "",
      });
    }

    return {
      ok: true,
      provider: "tinyfish",
      evidence_type: "snippet",
      results,
      latency_ms: Math.max(0, this.now() - started),
      remaining,
    };
  }

  private failFromHttp(response: Response, started: number): TinyFishOutcome {
    const headers = headersToRecord(response.headers);
    const status = response.status;
    const synthetic = `HTTP ${status}`;
    const { category, retryAfterMs } = categorizeError(synthetic, { headers }, this.now());
    let code: TinyFishErrorCode = "http_error";
    let resolved: ErrorCategory = category;
    if (status === 429) {
      code = "provider_rate_limited";
      resolved = "quota";
    } else if (status === 401) {
      code = "provider_auth";
      resolved = "auth";
    } else if (status === 403) {
      code = "provider_access_denied";
      resolved = "access_denied";
    } else if (status === 408) {
      code = "timeout";
      resolved = "transient";
    } else if (status >= 500) {
      code = "http_error";
      resolved = "transient";
    } else if (/captcha/i.test(response.statusText)) {
      code = "provider_captcha";
      resolved = "captcha";
    }
    return this.fail(
      code,
      `TinyFish returned HTTP ${status}`,
      started,
      resolved,
      undefined,
      retryAfterMs,
    );
  }

  private fail(
    code: TinyFishErrorCode,
    message: string,
    started: number,
    errorCategory?: ErrorCategory,
    cooldownUntil?: number,
    retryAfterMs?: number,
    remaining?: RateLimitResult["remaining"],
  ): TinyFishOutcome {
    void cooldownUntil;
    return {
      ok: false,
      provider: "tinyfish",
      evidence_type: "none",
      code,
      message,
      latency_ms: Math.max(0, this.now() - started),
      error_category: errorCategory,
      retry_after_ms: retryAfterMs,
      remaining,
    };
  }
}

class ResponseTooLarge extends Error {}
class RequestDeadlineError extends Error {
  constructor() {
    super("request deadline exceeded");
    this.name = "RequestDeadlineError";
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > maxBytes) throw new ResponseTooLarge();

  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ResponseTooLarge();
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel failure
      }
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function parseTinyFishRetryAfter(headers: Headers, now: number): number | undefined {
  return parseRetryAfterMs({ headers: headersToRecord(headers) }, "", now);
}
