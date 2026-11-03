import { describe, expect, test } from "bun:test";
import {
  countsAsDiscoveryCall,
  DISCOVERY_DEFAULT_CALLS,
  DISCOVERY_MAX_EXTENSION,
  DiscoveryBudget,
} from "../lib/discovery";

describe("discovery call classification", () => {
  test("counts search, list, and local semantic calls only", () => {
    for (const tool of ["glob", "grep", "sqz_sqz_grep", "sqz_sqz_list_dir"]) {
      expect(countsAsDiscoveryCall(tool, {})).toBe(true);
    }
    expect(countsAsDiscoveryCall("semble_search", { query: "x" })).toBe(true);
    // 2.x MCP names are flattened before the classifier sees them.
    expect(countsAsDiscoveryCall("mcp__sqz__sqz_grep", { pattern: "x" })).toBe(true);
    expect(countsAsDiscoveryCall("mcp__sqz__sqz_list_dir", { path: "x" })).toBe(true);
    expect(countsAsDiscoveryCall("mcp__semble__search", { query: "x" })).toBe(true);
    expect(countsAsDiscoveryCall("sqz_sqz_read_file", { path: "README.md" })).toBe(false);
    expect(countsAsDiscoveryCall("read", { path: "README.md" })).toBe(false);
    expect(countsAsDiscoveryCall("execute", { code: "return 1" })).toBe(false);
  });

  test("counts search/list shell segments but not plain file reads", () => {
    expect(countsAsDiscoveryCall("shell", { command: "rg -n microphone ." })).toBe(true);
    expect(countsAsDiscoveryCall("shell", { command: "ls -la docs" })).toBe(true);
    expect(countsAsDiscoveryCall("shell", { command: "gci -Recurse" })).toBe(true);
    expect(countsAsDiscoveryCall("shell", { command: "findstr /s /i microphone *" })).toBe(true);
    expect(countsAsDiscoveryCall("shell", { command: "Get-ChildItem -Recurse" })).toBe(true);
    expect(countsAsDiscoveryCall("shell", { command: "cat config.yaml" })).toBe(false);
    expect(countsAsDiscoveryCall("shell", { command: "cat config.yaml | rg microphone" })).toBe(true);
    expect(countsAsDiscoveryCall("shell", { command: "gci docs\r\nfindstr microphone *.yaml" })).toBe(true);
    expect(countsAsDiscoveryCall("shell", {})).toBe(false);
    // A wrapper that the explore allowlist denies is not guessed at here.
    expect(
      countsAsDiscoveryCall("shell", {
        command: 'powershell -NoProfile -Command "gci -Recurse"',
      }),
    ).toBe(false);
  });
});

describe("discovery budget", () => {
  test("allows the default number of calls, then stops", () => {
    const budget = new DiscoveryBudget();
    for (let i = 1; i <= DISCOVERY_DEFAULT_CALLS; i += 1) {
      const decision = budget.count("explore", "grep", { pattern: `p${i}` });
      expect(decision.allowed).toBe(true);
      expect(decision.status.used).toBe(i);
    }
    const denied = budget.count("explore", "glob", { pattern: "**/*.yaml" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("discovery_budget_exhausted");
    expect(denied.status.used).toBe(DISCOVERY_DEFAULT_CALLS);
    expect(denied.status.blocked).toBe(1);
    expect(denied.status.remaining).toBe(0);
    expect(denied.status.note).toBe("local_search_list_calls_not_time");
  });

  test("does not charge reads or non-discovery tools", () => {
    const budget = new DiscoveryBudget();
    expect(budget.count("explore", "read", { path: "a" }).counted).toBe(false);
    expect(budget.count("explore", "sqz_sqz_read_file", { path: "b" }).counted).toBe(false);
    expect(budget.count("explore", "execute", { code: "x" }).counted).toBe(false);
    expect(budget.has("explore")).toBe(false);
    expect(budget.status("explore").used).toBe(0);
  });

  test("repeated identical calls each count and sessions are isolated", () => {
    const budget = new DiscoveryBudget({ defaultLimit: 2 });
    expect(budget.count("a", "grep", { pattern: "same" }).allowed).toBe(true);
    expect(budget.count("a", "grep", { pattern: "same" }).allowed).toBe(true);
    expect(budget.count("a", "grep", { pattern: "same" }).allowed).toBe(false);
    expect(budget.status("a").used).toBe(2);
    expect(budget.status("b").used).toBe(0);
    expect(budget.count("b", "grep", { pattern: "same" }).allowed).toBe(true);
  });

  test("concurrent charges are applied one leaf call at a time", async () => {
    const budget = new DiscoveryBudget({ defaultLimit: 3 });
    const decisions = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        Promise.resolve().then(() => budget.count("explore", "glob", { pattern: `p${i}` })),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect(budget.status("explore").blocked).toBe(2);
  });

  test("grants one bounded extension, default and custom", () => {
    const budget = new DiscoveryBudget({ defaultLimit: 2, defaultExtension: 2, maxExtension: 6 });
    expect(budget.count("a", "grep", {}).allowed).toBe(true);
    expect(budget.count("a", "grep", {}).allowed).toBe(true);
    expect(budget.count("a", "grep", {}).allowed).toBe(false);

    const extended = budget.extend("a");
    expect(extended.ok).toBe(true);
    expect(extended.status.limit).toBe(4);
    expect(extended.status.extended).toBe(true);
    expect(budget.count("a", "grep", {}).allowed).toBe(true);
    expect(budget.count("a", "grep", {}).allowed).toBe(true);
    expect(budget.count("a", "grep", {}).allowed).toBe(false);

    const again = budget.extend("a");
    if (again.ok) throw new Error("expected the second extension to be refused");
    expect(again.reason).toBe("already_extended");
  });

  test("clamps a larger orchestrator-approved extension", () => {
    const budget = new DiscoveryBudget({ defaultLimit: 1, defaultExtension: 3, maxExtension: 5 });
    const extended = budget.extend("complex", 999);
    expect(extended.ok).toBe(true);
    expect(extended.status.limit).toBe(1 + 5);
    expect(extended.status.extension_calls).toBe(5);
    expect(DISCOVERY_MAX_EXTENSION).toBe(32);
  });
});
