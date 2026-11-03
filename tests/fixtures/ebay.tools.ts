/**
 * Offline mirror of the public eBay MCP tool surface.
 *
 * Source reviewed locally: C:/Users/hermes/mcp-servers/ebay/src/ebay_mcp/server.py
 * (three read-only Browse API tools). No network call, Python process, or
 * credential is involved. Keep this fixture in sync when the server adds or
 * removes a tool; an unknown `ebay_*` tool must stay fail-closed.
 */
export const EBAY_PUBLIC_TOOLS = [
  {
    name: "ebay_search_listings",
    kind: "search",
    cost: "free_bounded",
    external: true,
  },
  {
    name: "ebay_price_summary",
    kind: "search",
    cost: "free_bounded",
    external: true,
  },
  {
    name: "ebay_get_item",
    kind: "read",
    cost: "free_bounded",
    external: true,
  },
] as const;

/** A plausible future/write tool: must not be usable without a new audit. */
export const EBAY_UNKNOWN_TOOL = "ebay_revise_listing";
