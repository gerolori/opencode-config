import { createHash } from "node:crypto";
import type {
  CostClass,
  ProviderId,
  RetrievalKind,
  ToolClassification,
} from "./types";

/**
 * Exact, audited tool-name mapping. Any retrieval server we know about must
 * have every tool either mapped here or rejected by the namespace fallback
 * below. Unknown tools from unrelated servers (Composio, Home Assistant, ...)
 * are not touched.
 */
const EXACT: Readonly<Record<string, ToolClassification>> = {
  // Search
  duckduckgo_search: {
    tool: "duckduckgo_search",
    kind: "search",
    provider: "duckduckgo",
    cost: "free",
    external: true,
  },
  tinyfish_search: {
    tool: "tinyfish_search",
    kind: "search",
    provider: "tinyfish",
    cost: "free_bounded",
    external: true,
  },
  exa_web_search_exa: {
    tool: "exa_web_search_exa",
    kind: "search",
    provider: "exa",
    cost: "free_tier_then_paid",
    external: true,
  },
  gh_grep_searchGitHub: {
    tool: "gh_grep_searchGitHub",
    kind: "search",
    provider: "gh_grep",
    cost: "free",
    external: true,
  },
  "context7_resolve-library-id": {
    tool: "context7_resolve-library-id",
    kind: "search",
    provider: "context7",
    cost: "free",
    external: true,
  },
  "context7_query-docs": {
    tool: "context7_query-docs",
    kind: "search",
    provider: "context7",
    cost: "free",
    external: true,
  },

  // Built-in search has an unknown/paid/unbounded backend. Deny by default.
  websearch: {
    tool: "websearch",
    kind: "search",
    provider: "builtin_websearch",
    cost: "unknown_maybe_paid",
    external: true,
    denyReason: "unknown_builtin_search_backend",
  },
  websearch_cited: {
    tool: "websearch_cited",
    kind: "search",
    provider: "builtin_websearch",
    cost: "unknown_maybe_paid",
    external: true,
    denyReason: "unknown_builtin_search_backend",
  },

  // Reads
  webfetch: {
    tool: "webfetch",
    kind: "read",
    provider: "builtin_webfetch",
    cost: "free",
    external: true,
  },
  duckduckgo_fetch_content: {
    tool: "duckduckgo_fetch_content",
    kind: "read",
    provider: "duckduckgo",
    cost: "free",
    external: true,
  },
  duckduckgo_expand_link: {
    tool: "duckduckgo_expand_link",
    kind: "read",
    provider: "duckduckgo",
    cost: "free",
    external: true,
  },
  exa_web_fetch_exa: {
    tool: "exa_web_fetch_exa",
    kind: "read",
    provider: "exa",
    cost: "free_tier_then_paid",
    external: true,
  },
  exa_get_code_context_exa: {
    tool: "exa_get_code_context_exa",
    kind: "read",
    provider: "exa",
    cost: "free_tier_then_paid",
    external: true,
  },
  exa_crawling_exa: {
    tool: "exa_crawling_exa",
    kind: "read",
    provider: "exa",
    cost: "free_tier_then_paid",
    external: true,
  },

  // Explicitly expensive / unbounded Exa products are not retrieval choices.
  exa_company_research_exa: {
    tool: "exa_company_research_exa",
    kind: "search",
    provider: "exa",
    cost: "paid",
    external: true,
    denyReason: "paid_or_unbounded_tool",
  },
  exa_linkedin_search_exa: {
    tool: "exa_linkedin_search_exa",
    kind: "search",
    provider: "exa",
    cost: "paid",
    external: true,
    denyReason: "paid_or_unbounded_tool",
  },
  exa_deep_researcher_start: {
    tool: "exa_deep_researcher_start",
    kind: "search",
    provider: "exa",
    cost: "paid",
    external: true,
    denyReason: "paid_or_unbounded_tool",
  },
  exa_deep_researcher_check: {
    tool: "exa_deep_researcher_check",
    kind: "search",
    provider: "exa",
    cost: "paid",
    external: true,
    denyReason: "paid_or_unbounded_tool",
  },

  // Local code retrieval. Never counted as external retrieval.
  semble_search: {
    tool: "semble_search",
    kind: "local",
    provider: "semble",
    cost: "free",
    external: false,
  },
  semble_find_related: {
    tool: "semble_find_related",
    kind: "local",
    provider: "semble",
    cost: "free",
    external: false,
  },
};

const COST: Readonly<Record<ProviderId, CostClass>> = {
  duckduckgo: "free",
  tinyfish: "free_bounded",
  exa: "free_tier_then_paid",
  gh_grep: "free",
  context7: "free",
  builtin_webfetch: "free",
  builtin_websearch: "unknown_maybe_paid",
  semble: "free",
  unknown: "unknown_maybe_paid",
};

/** Normalize flattened MCP names such as `mcp__exa__web_search_exa`. */
export function normalizeToolName(tool: string): string {
  const trimmed = tool.trim();
  if (!trimmed.startsWith("mcp__")) return trimmed;
  const parts = trimmed.split("__").filter(Boolean);
  // parts = ["mcp", "<server>", "<tool...>"]
  if (parts.length >= 3) return [parts[1], ...parts.slice(2)].join("_");
  return trimmed;
}

export function providerCost(provider: ProviderId): CostClass {
  return COST[provider] ?? "unknown_maybe_paid";
}

export function classifyTool(rawTool: string): ToolClassification | null {
  const tool = normalizeToolName(rawTool);
  const exact = EXACT[tool];
  if (exact) return exact;

  // Known retrieval namespaces are fail-closed: a new tool from one of these
  // servers must not silently bypass budgets/circuits.
  const ns = tool.split("_")[0]?.toLowerCase();
  if (ns === "exa") {
    return {
      tool,
      kind: "search",
      provider: "exa",
      cost: "unknown_maybe_paid",
      external: true,
      denyReason: "unclassified_retrieval_tool",
    };
  }
  if (ns === "duckduckgo") {
    return {
      tool,
      kind: "search",
      provider: "duckduckgo",
      cost: "unknown_maybe_paid",
      external: true,
      denyReason: "unclassified_retrieval_tool",
    };
  }
  if (ns === "gh" && tool.toLowerCase().startsWith("gh_grep_")) {
    return {
      tool,
      kind: "search",
      provider: "gh_grep",
      cost: "unknown_maybe_paid",
      external: true,
      denyReason: "unclassified_retrieval_tool",
    };
  }
  if (ns === "context7") {
    return {
      tool,
      kind: "search",
      provider: "context7",
      cost: "unknown_maybe_paid",
      external: true,
      denyReason: "unclassified_retrieval_tool",
    };
  }
  if (ns === "tinyfish") {
    return {
      tool,
      kind: "search",
      provider: "tinyfish",
      cost: "unknown_maybe_paid",
      external: true,
      denyReason: "unclassified_retrieval_tool",
    };
  }
  if (ns === "semble") {
    return {
      tool,
      kind: "local",
      provider: "semble",
      cost: "unknown_maybe_paid",
      external: false,
      denyReason: "unclassified_retrieval_tool",
    };
  }

  // Other common web-retrieval MCPs are fail-closed too. This intentionally
  // does not match app-action tools such as Composio's `*_search_tools` or
  // Home Assistant actions; those namespaces are left untouched.
  const lower = tool.toLowerCase();
  if (
    /(^|_)(web_?search|websearch|internet_search)(_|$)/.test(lower) ||
    /^(tavily|serper|serpapi|search1api|firecrawl|kagi|perplexity|jina|bing|yandex|baidu|mojeek|startpage|qwant)_/.test(lower) ||
    /^brave_/.test(lower)
  ) {
    return {
      tool,
      kind: "search",
      provider: "unknown",
      cost: "unknown_maybe_paid",
      external: true,
      denyReason: "unclassified_retrieval_tool",
    };
  }
  if (/(^|_)(web_?fetch|webfetch|url_fetch|fetch_url)(_|$)/.test(lower)) {
    return {
      tool,
      kind: "read",
      provider: "unknown",
      cost: "unknown_maybe_paid",
      external: true,
      denyReason: "unclassified_retrieval_tool",
    };
  }

  return null;
}

/** A normalized key for per-query provider limits. Never persisted. */
export function normalizeQuery(kind: RetrievalKind, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const candidate =
    kind === "read"
      ? firstString(
          a.url,
          a.link,
          a.href,
          a.query,
          Array.isArray(a.urls) ? a.urls[0] : undefined,
        )
      : firstString(a.query, a.q, a.search, a.libraryName, a.prompt);
  if (!candidate) return undefined;
  return normalizeValue(candidate);
}

export function normalizeValue(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[?!.,;:]+$/g, "")
    .slice(0, 2048);
}

export type ReadPlan = {
  /** Normalized URLs, when the arguments identify concrete resources. */
  urls: string[];
  /** Provider-limit keys. Concrete URLs, or a query pseudo-key. */
  keys: string[];
  /** Opaque tokens cannot be checked against blocked resources. */
  opaque: boolean;
  /** Number of reads requested by the call (before any truncation). */
  requested: number;
};

export const MAX_READS_PER_CALL = 3;

/**
 * Extract every known read argument shape. Batch reads count as one read per
 * URL. Tokens that map to server-side cached URLs are opaque: the policy
 * cannot know which URL they expand to, so it refuses them unless the caller
 * supplies a concrete URL as well.
 */
export function extractReadPlan(args: unknown): ReadPlan {
  if (!args || typeof args !== "object") {
    return { urls: [], keys: [], opaque: true, requested: 1 };
  }
  const a = args as Record<string, unknown>;
  const rawUrls: string[] = [];
  let malformedBatch = false;
  if (Array.isArray(a.urls)) {
    for (const value of a.urls) {
      if (typeof value === "string" && value.trim()) rawUrls.push(value);
      else malformedBatch = true;
    }
  }
  if (malformedBatch) {
    return {
      urls: [],
      keys: [],
      opaque: true,
      requested: Math.max(1, Array.isArray(a.urls) ? a.urls.length : 1),
    };
  }
  if (rawUrls.length === 0) {
    const single = firstString(a.url, a.link, a.href);
    if (single) rawUrls.push(single);
  }
  if (rawUrls.length > 0) {
    const urls = rawUrls.map(normalizeValue);
    return { urls, keys: urls, opaque: false, requested: urls.length };
  }

  const token = firstString(a.token, a.expand_token, a.link_token);
  if (token) {
    return { urls: [], keys: [], opaque: true, requested: 1 };
  }

  const query = firstString(a.query, a.q);
  if (query) {
    return {
      urls: [],
      keys: [`q:${normalizeValue(query)}`],
      opaque: false,
      requested: 1,
    };
  }

  // Unknown read shape: fail closed rather than guessing.
  return { urls: [], keys: [], opaque: true, requested: 1 };
}


function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function sessionStorageKey(sessionID: string): string {
  return hashKey(`session:${sessionID}`);
}

/**
 * Reject network git/HTTP references while allowing local directories and
 * Windows drive paths. Used for Semble's `repo` argument.
 */
export function isRemoteRepoRef(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  // Local Windows extended-length paths are still local.
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(v)) return false;
  // UNC and POSIX network paths: \\server\share, //server/share.
  if (/^[\\/]{2}/.test(v)) return true;
  if (/^file:\/\//i.test(v)) {
    const host = v.slice("file://".length).split(/[\\/]/, 1)[0];
    if (host.length > 0 && host.toLowerCase() !== "localhost") return true;
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return true;
  if (/^git@[^:\s]+:/i.test(v)) return true;
  if (/^(github|gitlab|bitbucket)\.com[/:]/i.test(v)) return true;
  if (/^[^\s/\\]+@[^\s/\\]+:/.test(v)) return true;
  if (/^(ssh|git):/i.test(v)) return true;
  return false;
}

export type CandidateOptions = {
  kind: RetrievalKind;
  attempted: ReadonlySet<ProviderId>;
  available: (provider: ProviderId) => boolean;
  preferExa?: boolean;
};

const SEARCH_ORDER: ProviderId[] = [
  "duckduckgo",
  "tinyfish",
  "gh_grep",
  "context7",
  "exa",
];
const SEMANTIC_ORDER: ProviderId[] = [
  "exa",
  "duckduckgo",
  "tinyfish",
  "gh_grep",
  "context7",
];
const READ_ORDER: ProviderId[] = [
  "builtin_webfetch",
  "duckduckgo",
  "exa",
];

/**
 * Return at most two next choices. This is intentionally finite so a failed
 * provider cannot expand into a tour of every free service.
 */
export function candidateProviders(opts: CandidateOptions): ProviderId[] {
  const order =
    opts.kind === "read"
      ? READ_ORDER
      : opts.preferExa
        ? SEMANTIC_ORDER
        : SEARCH_ORDER;
  const out: ProviderId[] = [];
  for (const provider of order) {
    if (out.length >= 2) break;
    if (opts.attempted.has(provider)) continue;
    if (!opts.available(provider)) continue;
    out.push(provider);
  }
  return out;
}
