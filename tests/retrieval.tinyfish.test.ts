import { describe, expect, test } from "bun:test";
import {
  TinyFishClient,
  parseTinyFishRetryAfter,
  type TinyFishProviderBridge,
} from "../lib/retrieval";

function fakeBridge(overrides: Partial<TinyFishProviderBridge> = {}): {
  bridge: TinyFishProviderBridge;
  stats: { consumed: number };
} {
  const stats = { consumed: 0 };
  const bridge: TinyFishProviderBridge = {
    availability: () => ({
      provider: "tinyfish",
      available: true,
      cost: "free_bounded",
      keyConfigured: true,
    }),
    async consumeCall() {
      stats.consumed += 1;
      return {
        allowed: true,
        remaining: { minute: 30, hour: 500, day: 12_000 },
      };
    },
    async recordFailure() {},
    async recordSuccess() {},
    ...overrides,
  };
  return { bridge, stats };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const result = (index: number) => ({
  position: index,
  site_name: "example.test",
  title: `Title ${index}`,
  snippet: `Snippet ${index}`,
  url: `https://example.test/${index}`,
});

describe("TinyFish bounded adapter", () => {
  test("returns at most five URL/title/snippet results with snippet evidence", async () => {
    const { bridge } = fakeBridge();
    let requested = "";
    let init: RequestInit | undefined;
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async (url: string | URL | Request, options?: RequestInit) => {
        requested = String(url);
        init = options;
        return jsonResponse({ results: Array.from({ length: 8 }, (_, i) => result(i + 1)) });
      }) as unknown as typeof fetch,
    });

    const outcome = await client.search({ query: "web automation tools" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.evidence_type).toBe("snippet");
    expect(outcome.results).toHaveLength(5);
    expect(outcome.results[0]).toEqual({
      url: "https://example.test/1",
      title: "Title 1",
      snippet: "Snippet 1",
    });
    expect(Object.keys(outcome.results[0]).sort()).toEqual(["snippet", "title", "url"]);
    expect(requested).toContain("https://api.search.tinyfish.ai");
    expect(requested).toContain("query=web+automation+tools");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
  });

  test("respects max_results below the provider cap", async () => {
    const { bridge } = fakeBridge();
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () =>
        jsonResponse({ results: Array.from({ length: 8 }, (_, i) => result(i + 1)) })) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "x", max_results: 2 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.results).toHaveLength(2);
  });

  test("missing key is a typed unavailable and makes no fetch/canary call", async () => {
    const { bridge, stats } = fakeBridge();
    let fetched = 0;
    const client = new TinyFishClient({
      bridge,
      env: {},
      fetchImpl: (async () => {
        fetched += 1;
        return jsonResponse({ results: [] });
      }) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("missing_api_key");
      expect(outcome.evidence_type).toBe("none");
      expect(outcome.error_category).toBeUndefined();
    }
    expect(fetched).toBe(0);
    expect(stats.consumed).toBe(0);
  });

  test("local per-minute cap prevents the HTTP call", async () => {
    const { bridge } = fakeBridge({
      async consumeCall() {
        return {
          allowed: false,
          reason: "minute",
          retryAfterMs: 5_000,
          remaining: { minute: 0, hour: 470, day: 11_970 },
        };
      },
    });
    let fetched = 0;
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () => {
        fetched += 1;
        return jsonResponse({ results: [] });
      }) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("local_rate_limit");
      expect(outcome.retry_after_ms).toBe(5_000);
      expect(outcome.error_category).toBeUndefined();
    }
    expect(fetched).toBe(0);
  });

  test("429 is typed as quota with structured Retry-After", async () => {
    const { bridge } = fakeBridge();
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () =>
        new Response("", { status: 429, headers: { "retry-after": "42" } })) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("provider_rate_limited");
      expect(outcome.error_category).toBe("quota");
      expect(outcome.retry_after_ms).toBe(42_000);
    }
  });

  test("auth and access denials are typed and not retried", async () => {
    const { bridge } = fakeBridge();
    const authClient = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
    });
    const auth = await authClient.search({ query: "x" });
    expect(auth.ok).toBe(false);
    if (!auth.ok) {
      expect(auth.code).toBe("provider_auth");
      expect(auth.error_category).toBe("auth");
    }

    const blockedClient = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () => new Response("", { status: 403 })) as unknown as typeof fetch,
    });
    const blocked = await blockedClient.search({ query: "x" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe("provider_access_denied");
      expect(blocked.error_category).toBe("access_denied");
    }
  });

  test("network timeouts are bounded and typed as transient", async () => {
    const { bridge } = fakeBridge();
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("timeout");
      expect(outcome.error_category).toBe("transient");
    }
  });

  test("oversized responses are refused before parsing", async () => {
    const { bridge } = fakeBridge();
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(10 * 1024 * 1024) },
        })) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("response_too_large");
  });

  test("invalid JSON is a typed bad response", async () => {
    const { bridge } = fakeBridge();
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("bad_response");
      expect(outcome.error_category).toBe("unknown");
    }
  });

  test("empty query is rejected before consuming a call or HTTP", async () => {
    const { bridge, stats } = fakeBridge();
    let fetched = 0;
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () => {
        fetched += 1;
        return jsonResponse({ results: [] });
      }) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "   " });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("bad_response");
    expect(fetched).toBe(0);
    expect(stats.consumed).toBe(0);
  });

  test("a stalled response body still hits the hard deadline", async () => {
    const { bridge } = fakeBridge();
    const stalled = new ReadableStream({
      start() {
        // Never enqueue, never close.
      },
      cancel() {},
    });
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      timeoutMs: 25,
      fetchImpl: (async () => new Response(stalled, { status: 200 })) as unknown as typeof fetch,
    });
    const started = Date.now();
    const outcome = await client.search({ query: "stalled" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("timeout");
      expect(outcome.error_category).toBe("transient");
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("redirects and unexpected response hosts are refused", async () => {
    const { bridge } = fakeBridge();
    const redirected = new Response(JSON.stringify({ results: [] }), { status: 200 });
    Object.defineProperty(redirected, "url", { value: "https://evil.example/search" });
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "key" },
      fetchImpl: (async () => redirected) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "redirect" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("redirect_forbidden");
  });

  test("error messages do not echo keys or query values", async () => {
    const { bridge } = fakeBridge();
    const client = new TinyFishClient({
      bridge,
      env: { TINYFISH_API_KEY: "super-secret-key" },
      fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });
    const outcome = await client.search({ query: "private-query-value" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).not.toContain("super-secret-key");
      expect(outcome.message).not.toContain("private-query-value");
    }
  });

  test("parses Retry-After header as seconds", () => {
    const headers = new Headers({ "retry-after": "30" });
    expect(parseTinyFishRetryAfter(headers, 1_000)).toBe(30_000);
  });
});
