import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyTool,
  nodeStateFs,
  RetrievalEngine,
  type SessionLookup,
  type StateFs,
} from "../lib/retrieval";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "retrieval-policy-"));
  dirs.push(dir);
  return dir;
}

type SessionMap = Record<string, { parentID?: string; agent?: string }>;

function sessionLookup(map: SessionMap): SessionLookup {
  return {
    async get(id) {
      const session = map[id];
      return session ? { id, ...session } : undefined;
    },
  };
}

type Harness = {
  engine: RetrievalEngine;
  dir: string;
  clock: { now: number };
};

async function harness(options: {
  sessions?: SessionMap;
  env?: Record<string, string | undefined>;
  clock?: { now: number };
  dir?: string;
  fs?: StateFs;
  lockWaitMs?: number;
  lockStaleMs?: number;
  nativeSearchAvailable?: boolean;
} = {}): Promise<Harness> {
  const dir = options.dir ?? (await tempDir());
  const clock = options.clock ?? { now: 1_700_000_000_000 };
  const engine = new RetrievalEngine({
    stateDir: dir,
    now: () => clock.now,
    env: options.env ?? {},
    sessionLookup: sessionLookup(options.sessions ?? {}),
    fs: options.fs,
    lockWaitMs: options.lockWaitMs,
    lockStaleMs: options.lockStaleMs,
    nativeSearchAvailable: options.nativeSearchAvailable,
  });
  await engine.init();
  return { engine, dir, clock };
}

async function before(
  engine: RetrievalEngine,
  tool: string,
  sessionID: string,
  callID: string,
  args: unknown,
) {
  return engine.before({ tool, sessionID, callID }, { args });
}

type FailedCall = {
  tool: string;
  sessionID: string;
  callID: string;
  error: string;
  metadata?: Record<string, unknown>;
};

function failedCall(
  tool: string,
  sessionID: string,
  callID: string,
  error: string,
  metadata?: Record<string, unknown>,
): FailedCall {
  return { tool, sessionID, callID, error, metadata };
}

async function recordError(engine: RetrievalEngine, failure: FailedCall) {
  await engine.after(
    {
      tool: failure.tool,
      sessionID: failure.sessionID,
      callID: failure.callID,
      args: {},
    },
    {
      title: "error",
      output: "",
      metadata: {
        ...(failure.metadata ?? {}),
        isError: true,
        error: failure.error,
      },
    },
  );
}

async function stateJson(dir: string): Promise<any> {
  return JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
}

describe("retrieval budget policy", () => {
  test("allows 3 searches and 3 reads, then stops early", async () => {
    const { engine } = await harness();
    engine.noteAgent("root", "fetch");

    for (let i = 1; i <= 3; i += 1) {
      const decision = await before(engine, "duckduckgo_search", "root", `s${i}`, {
        query: `search-${i}`,
      });
      expect(decision.allowed).toBe(true);
    }
    const searchDenied = await before(engine, "duckduckgo_search", "root", "s4", {
      query: "search-4",
    });
    expect(searchDenied.allowed).toBe(false);
    expect(searchDenied.reason).toBe("budget_exhausted");

    for (let i = 1; i <= 3; i += 1) {
      const decision = await before(engine, "webfetch", "root", `r${i}`, {
        url: `https://example.test/read-${i}`,
      });
      expect(decision.allowed).toBe(true);
    }
    const readDenied = await before(engine, "webfetch", "root", "r4", {
      url: "https://example.test/read-4",
    });
    expect(readDenied.allowed).toBe(false);
    expect(readDenied.reason).toBe("budget_exhausted");

    const status = await engine.status({}, { sessionID: "root", agent: "fetch" });
    expect(status.ok).toBe(true);
    expect(status.report?.remaining).toEqual({ search: 0, read: 0 });
    expect(status.report?.used.blockedSearch).toBe(1);
    expect(status.report?.used.blockedRead).toBe(1);
    expect(status.report?.blocked_attempts_consume_budget).toBe(true);
  });

  test("blocked attempts consume the budget and are counted", async () => {
    const { engine } = await harness();
    engine.noteAgent("root", "code");

    const denied = await before(engine, "duckduckgo_search", "root", "c1", {
      query: "nope",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("agent_denied");

    const status = await engine.status({}, { sessionID: "root", agent: "code" });
    expect(status.report?.used.search).toBe(1);
    expect(status.report?.used.blockedSearch).toBe(1);
    expect(status.report?.remaining.search).toBe(2);
  });

  test("limits a normalized query to two distinct providers", async () => {
    const { engine } = await harness({
      env: { EXA_API_KEY: "exa-key", TINYFISH_API_KEY: "tiny-key" },
    });
    engine.noteAgent("root", "fetch");

    expect((await before(engine, "duckduckgo_search", "root", "p1", { query: "Same   Query!" })).allowed).toBe(true);
    expect((await before(engine, "websearch", "root", "p2", { query: "same query" })).allowed).toBe(true);
    const third = await before(engine, "exa_web_search_exa", "root", "p3", { query: "SAME QUERY" });
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("provider_limit");
    expect(third.allowedNextProviders).toEqual([]);
  });

  test("allows exactly one transient retry", async () => {
    const { engine } = await harness();
    engine.noteAgent("root", "fetch");

    expect((await before(engine, "duckduckgo_search", "root", "t1", { query: "retry me" })).allowed).toBe(true);
    await recordError(engine, failedCall("duckduckgo_search", "root", "t1", "ETIMEDOUT"));
    expect((await before(engine, "duckduckgo_search", "root", "t2", { query: "retry me" })).allowed).toBe(true);
    await recordError(engine, failedCall("duckduckgo_search", "root", "t2", "ETIMEDOUT"));
    const third = await before(engine, "duckduckgo_search", "root", "t3", { query: "retry me" });
    expect(third.allowed).toBe(false);
    expect(["provider_circuit_open", "transient_retry_exhausted"]).toContain(third.reason);
  });

  test("deduplicates outcomes and never trusts generic page text", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("root", "fetch");

    await before(engine, "duckduckgo_search", "root", "d1", { query: "dedupe" });
    await recordError(engine, failedCall("duckduckgo_search", "root", "d1", "ETIMEDOUT"));
    await recordError(engine, failedCall("duckduckgo_search", "root", "d1", "ETIMEDOUT"));
    const state = await stateJson(dir);
    expect(state.providers.duckduckgo.failures).toBe(1);

    await before(engine, "duckduckgo_search", "root", "d2", { query: "dedupe" });
    await engine.after(
      { tool: "duckduckgo_search", sessionID: "root", callID: "d2", args: { query: "dedupe" } },
      { title: "ok", output: "page text containing error", metadata: {} },
    );
    const successState = await stateJson(dir);
    expect(successState.providers.duckduckgo.failures).toBe(1);
    expect(successState.providers.duckduckgo.successes).toBe(1);

    // A duplicate error after-hook for an already-completed call is ignored.
    await recordError(engine, failedCall("duckduckgo_search", "root", "d2", "boom"));
    const afterState = await stateJson(dir);
    expect(afterState.providers.duckduckgo.failures).toBe(1);
    expect(afterState.providers.duckduckgo.successes).toBe(1);
  });
});

describe("provider circuits", () => {
  test("enforces the local TinyFish 30/minute call cap", async () => {
    const { engine } = await harness({ env: { TINYFISH_API_KEY: "key" } });
    const results = [];
    for (let i = 0; i < 31; i += 1) results.push(await engine.consumeNativeSearchCall());
    expect(results.slice(0, 30).every((result) => result.allowed)).toBe(true);
    expect(results[30].allowed).toBe(false);
    expect(results[30].reason).toBe("minute");
    expect(results[30].remaining.minute).toBe(0);
  });

  test("honors hour and day TinyFish caps loaded from persisted state", async () => {
    const clock = { now: 1_700_000_000_000 };
    const make = async (hourCount: number, dayCount: number) => {
      const dir = await tempDir();
      const minuteStart = Math.floor(clock.now / 60_000) * 60_000;
      const hourStart = Math.floor(clock.now / 3_600_000) * 3_600_000;
      const dayStart = Math.floor(clock.now / 86_400_000) * 86_400_000;
      await writeFile(
        path.join(dir, "state.json"),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: clock.now,
          providers: {
            tinyfish: {
              attempts: 0,
              successes: 0,
              failures: 0,
              consecutiveFailures: 0,
              rate: {
                minute: { windowStart: minuteStart, count: 0 },
                hour: { windowStart: hourStart, count: hourCount },
                day: { windowStart: dayStart, count: dayCount },
              },
            },
          },
          sessions: {},
          blockedResources: {},
          health: {},
          usage: {},
        }),
        "utf8",
      );
      const { engine } = await harness({
        dir,
        clock,
        env: { TINYFISH_API_KEY: "key" },
      });
      return engine.consumeNativeSearchCall();
    };

    expect((await make(500, 0)).reason).toBe("hour");
    expect((await make(0, 12_000)).reason).toBe("day");
  });

  test("auth failures require operator action across fresh plugin instances", async () => {
    const clock = { now: 1_700_000_000_000 };
    const dir = await tempDir();
    const first = await harness({ dir, clock });
    first.engine.noteAgent("root", "fetch");
    await before(first.engine, "duckduckgo_search", "root", "a1", { query: "auth" });
    await recordError(first.engine,
      failedCall("duckduckgo_search", "root", "a1", "401 Unauthorized: invalid API key"),
    );

    const second = await harness({ dir, clock });
    second.engine.noteAgent("root", "fetch");
    const denied = await before(second.engine, "duckduckgo_search", "root", "a2", { query: "auth 2" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("provider_operator_action_required");

    clock.now += 2 * 60 * 60_000;
    const stillDenied = await before(second.engine, "duckduckgo_search", "root", "a3", {
      query: "auth 3",
    });
    expect(stillDenied.allowed).toBe(false);
    expect(stillDenied.reason).toBe("provider_operator_action_required");
  });

  test("configured TinyFish auth failure does not become anonymous after expiry", async () => {
    const clock = { now: 1_700_000_000_000 };
    const dir = await tempDir();
    const { engine } = await harness({
      dir,
      clock,
      env: { TINYFISH_API_KEY: "configured" },
    });
    engine.noteAgent("root", "fetch");
    await before(engine, "websearch", "root", "ta1", { query: "auth" });
    await recordError(
      engine,
      failedCall("websearch", "root", "ta1", "401 Unauthorized: invalid API key", {
        retry_after_ms: 60_000,
      }),
    );
    clock.now += 61_000;
    const denied = await before(engine, "websearch", "root", "ta2", { query: "next" });
    expect(denied.reason).toBe("provider_operator_action_required");
  });

  test("quota failures honor Retry-After and expire on clock advance", async () => {
    const clock = { now: 1_700_000_000_000 };
    const dir = await tempDir();
    const first = await harness({ dir, clock });
    first.engine.noteAgent("root", "fetch");
    await before(first.engine, "duckduckgo_search", "root", "q1", { query: "quota" });
    await recordError(first.engine,
      failedCall("duckduckgo_search", "root", "q1", "429 Too Many Requests", {
        retryAfterMs: 60_000,
      }),
    );

    const second = await harness({ dir, clock });
    second.engine.noteAgent("root", "fetch");
    const denied = await before(second.engine, "duckduckgo_search", "root", "q2", { query: "quota 2" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("provider_circuit_open");

    clock.now += 61_000;
    const allowed = await before(second.engine, "duckduckgo_search", "root", "q3", {
      query: "quota 3",
    });
    expect(allowed.allowed).toBe(true);
  });

  test("unknown quota depletion uses a bounded expiring cooldown", async () => {
    const clock = { now: 1_700_000_000_000 };
    const dir = await tempDir();
    const first = await harness({ dir, clock });
    first.engine.noteAgent("root", "fetch");
    await before(first.engine, "gh_grep_searchGitHub", "root", "u1", { query: "quota" });
    await recordError(first.engine,
      failedCall("gh_grep_searchGitHub", "root", "u1", "429 Too Many Requests"),
    );

    const second = await harness({ dir, clock });
    second.engine.noteAgent("root", "fetch");
    const denied = await before(second.engine, "gh_grep_searchGitHub", "root", "u2", {
      query: "quota 2",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("provider_circuit_open");

    clock.now += 5 * 60_000 + 1;
    const allowed = await before(second.engine, "gh_grep_searchGitHub", "root", "u3", {
      query: "quota 3",
    });
    expect(allowed.allowed).toBe(true);
  });

  test("a site access block cannot be bypassed with a different extractor", async () => {
    const clock = { now: 1_700_000_000_000 };
    const dir = await tempDir();
    const first = await harness({ dir, clock });
    first.engine.noteAgent("root", "fetch");
    const url = "https://blocked.example.test/private-page";
    await before(first.engine, "webfetch", "root", "b1", { url });
    await recordError(first.engine,
      failedCall("webfetch", "root", "b1", "403 access denied by site policy"),
    );

    const second = await harness({ dir, clock });
    second.engine.noteAgent("root", "fetch");
    const bypass = await before(second.engine, "duckduckgo_fetch_content", "root", "b2", { url });
    expect(bypass.allowed).toBe(false);
    expect(bypass.reason).toBe("resource_blocked");

    clock.now += 10 * 60_000 + 1;
    const afterCooldown = await before(second.engine, "duckduckgo_fetch_content", "root", "b3", {
      url,
    });
    expect(afterCooldown.allowed).toBe(true);
  });
});

describe("spawn and extension guards", () => {
  const sessions: SessionMap = {
    root: {},
    child: { parentID: "root" },
    grandchild: { parentID: "child" },
    other: { parentID: "elsewhere" },
    worker: {},
  };

  test("rejects task from a child session and from workers", async () => {
    const { engine } = await harness({ sessions });
    engine.noteAgent("root", "build");
    engine.noteAgent("child", "fetch");
    engine.noteAgent("worker", "fetch");

    expect((await before(engine, "subagent", "root", "k1", {})).allowed).toBe(true);
    const nested = await before(engine, "subagent", "child", "k2", {});
    expect(nested.allowed).toBe(false);
    expect(nested.reason).toBe("nested_task");

    const worker = await before(engine, "subagent", "worker", "k3", {});
    expect(worker.allowed).toBe(false);
    expect(worker.reason).toBe("worker_task_denied");

    const unknown = await before(engine, "subagent", "ghost", "k4", {});
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toBe("agent_unknown");
  });

  test("extends a child budget exactly once from build/plan", async () => {
    const { engine } = await harness({ sessions });
    engine.noteAgent("root", "build");
    engine.noteAgent("child", "fetch");

    const first = await engine.extend({ session_id: "child" }, { sessionID: "root", agent: "build" });
    expect(first.ok).toBe(true);
    expect(first.report?.limits).toEqual({ search: 6, read: 6 });
    expect(first.report?.remaining).toEqual({ search: 6, read: 6 });

    const second = await engine.extend({ session_id: "child" }, { sessionID: "root", agent: "build" });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_extended");

    for (let i = 1; i <= 6; i += 1) {
      const decision = await before(engine, "duckduckgo_search", "child", `e${i}`, {
        query: `extended-${i}`,
      });
      expect(decision.allowed).toBe(true);
    }
    const seventh = await before(engine, "duckduckgo_search", "child", "e7", { query: "extended-7" });
    expect(seventh.allowed).toBe(false);
    expect(seventh.reason).toBe("budget_exhausted");
  });

  test("rejects worker, forged, self, and non-child extension attempts", async () => {
    const { engine } = await harness({ sessions });
    engine.noteAgent("root", "build");
    engine.noteAgent("child", "fetch");
    engine.noteAgent("grandchild", "fetch");

    const worker = await engine.extend(
      { session_id: "grandchild" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(worker.reason).toBe("extend_not_authorized");

    const forged = await engine.extend(
      { session_id: "other" },
      { sessionID: "root", agent: "build" },
    );
    expect(forged.reason).toBe("target_not_child");

    const selfClaimParent = await engine.extend(
      { session_id: "root" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(selfClaimParent.reason).toBe("extend_not_authorized");

    const childStatus = await engine.status(
      { session_id: "other" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(childStatus.ok).toBe(false);
    expect(childStatus.reason).toBe("forged_session_target");
  });

  test("a fresh child starts with the default budget without initialization", async () => {
    const { engine } = await harness({ sessions });
    engine.noteAgent("child", "fetch");
    for (let i = 1; i <= 3; i += 1) {
      const decision = await before(engine, "duckduckgo_search", "child", `f${i}`, {
        query: `fresh-${i}`,
      });
      expect(decision.allowed).toBe(true);
    }
    const fourth = await before(engine, "duckduckgo_search", "child", "f4", { query: "fresh-4" });
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe("budget_exhausted");
  });
});

describe("audited classification and non-retrieval safety", () => {
  test("maps every audited retrieval tool name", () => {
    const expected: Record<string, { kind: string; provider: string; cost: string }> = {
      duckduckgo_search: { kind: "search", provider: "duckduckgo", cost: "free" },
      websearch: { kind: "search", provider: "tinyfish", cost: "free_bounded" },
      exa_web_search_exa: { kind: "search", provider: "exa", cost: "free_tier_then_paid" },
      gh_grep_searchGitHub: { kind: "search", provider: "gh_grep", cost: "free" },
      "context7_resolve-library-id": { kind: "search", provider: "context7", cost: "free" },
      "context7_query-docs": { kind: "search", provider: "context7", cost: "free" },
      context7_resolve_library_id: { kind: "search", provider: "context7", cost: "free" },
      context7_query_docs: { kind: "search", provider: "context7", cost: "free" },
      websearch_cited: { kind: "search", provider: "builtin_websearch", cost: "unknown_maybe_paid" },
      webfetch: { kind: "read", provider: "builtin_webfetch", cost: "free" },
      duckduckgo_fetch_content: { kind: "read", provider: "duckduckgo", cost: "free" },
      duckduckgo_expand_link: { kind: "read", provider: "duckduckgo", cost: "free" },
      exa_web_fetch_exa: { kind: "read", provider: "exa", cost: "free_tier_then_paid" },
      exa_get_code_context_exa: { kind: "read", provider: "exa", cost: "free_tier_then_paid" },
      semble_search: { kind: "local", provider: "semble", cost: "free" },
      semble_find_related: { kind: "local", provider: "semble", cost: "free" },
    };
    for (const [tool, shape] of Object.entries(expected)) {
      const c = classifyTool(tool);
      expect(c).not.toBeNull();
      expect(c?.kind).toBe(shape.kind as never);
      expect(c?.provider).toBe(shape.provider as never);
      expect(c?.cost).toBe(shape.cost as never);
    }
    expect(classifyTool("mcp__exa__web_search_exa")?.provider).toBe("exa");
    expect(classifyTool("exa_new_unclassified_tool")?.denyReason).toBe("unclassified_retrieval_tool");
    expect(classifyTool("exa_deep_researcher_start")?.denyReason).toBe("paid_or_unbounded_tool");
    expect(classifyTool("tavily_search")?.denyReason).toBe("unclassified_retrieval_tool");
    expect(classifyTool("mcp__acme__web_search")?.denyReason).toBe("unclassified_retrieval_tool");
    expect(classifyTool("composio_search_tools")).toBeNull();
    expect(classifyTool("home_assistant_HassTurnOn")).toBeNull();
  });

  test("binds native websearch to tinyfish and rejects provider overrides", async () => {
    const { engine } = await harness({ env: { TINYFISH_API_KEY: "key" } });
    engine.noteAgent("root", "fetch");

    const native = await before(engine, "websearch", "root", "w1", { query: "x" });
    expect(native.allowed).toBe(true);
    const status = await engine.status({}, { sessionID: "root", agent: "fetch" });
    const tinyfish = status.report?.providers.find((provider) => provider.provider === "tinyfish");
    expect(tinyfish?.rate_remaining?.minute).toBe(29);

    const override = await before(engine, "websearch", "root", "w2", {
      query: "x",
      providerID: "exa",
    });
    expect(override.allowed).toBe(false);
    expect(override.reason).toBe("native_search_provider_override");

    const cited = await before(engine, "websearch_cited", "root", "w3", { query: "x" });
    expect(cited.allowed).toBe(false);
    expect(cited.reason).toBe("unknown_builtin_search_backend");
  });

  test("fails closed when the native tinyfish provider is unavailable", async () => {
    const { engine } = await harness({
      env: { TINYFISH_API_KEY: "key" },
      nativeSearchAvailable: false,
    });
    engine.noteAgent("root", "fetch");
    const denied = await before(engine, "websearch", "root", "n1", { query: "x" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("native_search_provider_unavailable");
  });

  test("allows local Semble but rejects network git repos", async () => {
    const { engine } = await harness();
    engine.noteAgent("explore", "explore");
    engine.noteAgent("build", "build");

    expect(
      (await before(engine, "semble_search", "explore", "l1", {
        query: "find",
        repo: "C:\\Users\\hermes\\src",
      })).allowed,
    ).toBe(true);
    const remote = await before(engine, "semble_search", "explore", "l2", {
      query: "find",
      repo: "https://github.com/example/repo",
    });
    expect(remote.allowed).toBe(false);
    expect(remote.reason).toBe("remote_repo_forbidden");
    const ssh = await before(engine, "semble_search", "explore", "l3", {
      query: "find",
      repo: "git@github.com:example/repo.git",
    });
    expect(ssh.reason).toBe("remote_repo_forbidden");
    const wrongAgent = await before(engine, "semble_search", "build", "l4", {
      query: "find",
      repo: "./src",
    });
    expect(wrongAgent.reason).toBe("agent_denied");
  });

  test("does not interfere with Composio, Home Assistant, or ordinary tools", async () => {
    const { engine } = await harness();
    for (const tool of [
      "COMPOSIO_SEARCH_TOOLS",
      "composio_execute_tool",
      "home_assistant_HassTurnOn",
      "home_assistant_HassLightSet",
      "bash",
      "read",
      "edit",
    ]) {
      expect((await before(engine, tool, "root", `n-${tool}`, { query: "anything" })).allowed).toBe(
        true,
      );
    }
  });

  test("status never exposes secret environment values", async () => {
    const { engine } = await harness({
      env: { EXA_API_KEY: "exa-super-secret", TINYFISH_API_KEY: "tiny-super-secret" },
    });
    const status = await engine.status({}, { sessionID: "root", agent: "fetch" });
    const text = JSON.stringify(status.report);
    expect(text).not.toContain("exa-super-secret");
    expect(text).not.toContain("tiny-super-secret");
    expect(status.report?.providers.find((p) => p.provider === "exa")?.key_configured).toBe(true);
    expect(status.report?.providers.find((p) => p.provider === "tinyfish")?.key_configured).toBe(
      true,
    );
    expect(status.report?.note).toBe("counts_are_local_attempts_not_vendor_billing");
  });
});

describe("metadata-only persistence", () => {
  test("JSONL contains no queries, URLs, arguments, or raw session ids", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("sess-secret-123", "fetch");
    await before(engine, "duckduckgo_search", "sess-secret-123", "j1", {
      query: "TOPSECRET_QUERY_123",
    });
    await engine.after(
      { tool: "duckduckgo_search", sessionID: "sess-secret-123", callID: "j1", args: {} },
      { title: "ok", output: "TOPSECRET PAGE CONTENT", metadata: {} },
    );
    await before(engine, "webfetch", "sess-secret-123", "j2", {
      url: "https://private.example.test/path?token=abc",
    });

    const events = await readFile(path.join(dir, "events.jsonl"), "utf8");
    expect(events).not.toContain("TOPSECRET_QUERY_123");
    expect(events).not.toContain("TOPSECRET PAGE CONTENT");
    expect(events).not.toContain("https://private.example.test");
    expect(events).not.toContain("sess-secret-123");
    expect(events).toContain("duckduckgo_search");
    expect(events).toContain("local_attempt_counts_not_vendor_billing");
  });

  test("quarantines corrupt state and fails closed for a bounded window", async () => {
    const clock = { now: 1_700_000_000_000 };
    const dir = await tempDir();
    await writeFile(path.join(dir, "state.json"), "{ definitely not json", "utf8");

    const first = await harness({ dir, clock });
    first.engine.noteAgent("root", "fetch");
    const denied = await before(first.engine, "duckduckgo_search", "root", "c1", { query: "x" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("persistence_degraded");

    const files = await readdir(dir);
    expect(files.some((file) => file.startsWith("state.corrupt."))).toBe(true);

    clock.now += 5 * 60_000 + 1;
    const recovered = await before(first.engine, "duckduckgo_search", "root", "c2", { query: "y" });
    expect(recovered.allowed).toBe(true);
  });

  test("write failure is fail-closed until persistence recovers", async () => {
    let failWrites = true;
    const fs: StateFs = {
      ...nodeStateFs,
      writeFile: async (file, data) => {
        if (failWrites) throw new Error("disk full");
        return nodeStateFs.writeFile(file, data);
      },
      appendFile: async (file, data) => {
        if (failWrites) throw new Error("disk full");
        return nodeStateFs.appendFile(file, data);
      },
    };
    const { engine } = await harness({ fs });
    engine.noteAgent("root", "fetch");

    const denied = await before(engine, "duckduckgo_search", "root", "p1", { query: "x" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("persistence_degraded");
    const status = await engine.status({}, { sessionID: "root", agent: "fetch" });
    expect(status.report?.health.persistence_failed).toBe(true);

    failWrites = false;
    const recoveredStatus = await engine.status({}, { sessionID: "root", agent: "fetch" });
    expect(recoveredStatus.report?.health.persistence_failed).toBe(false);
    const allowed = await before(engine, "duckduckgo_search", "root", "p2", { query: "y" });
    expect(allowed.allowed).toBe(true);
  });

  test("after-outcome persistence failure stays fail-closed and keeps the outcome", async () => {
    let failState = false;
    const fs: StateFs = {
      ...nodeStateFs,
      writeFile: async (file, data) => {
        if (failState && file.endsWith(".tmp")) throw new Error("disk full");
        return nodeStateFs.writeFile(file, data);
      },
    };
    const { engine, dir } = await harness({ fs });
    engine.noteAgent("root", "fetch");

    expect(
      (await before(engine, "duckduckgo_search", "root", "pf1", { query: "auth" })).allowed,
    ).toBe(true);

    failState = true;
    await recordError(
      engine,
      failedCall("duckduckgo_search", "root", "pf1", "401 Unauthorized: invalid API key"),
    );
    failState = false;

    const denied = await before(engine, "duckduckgo_search", "root", "pf2", {
      query: "next",
    });
    expect(denied.reason).toBe("provider_operator_action_required");

    const status = await engine.status({}, { sessionID: "root", agent: "fetch" });
    expect(status.report?.health.persistence_failed).toBe(false);
    const state = await stateJson(dir);
    expect(state.providers.duckduckgo.requiresOperator).toBe(true);
  });
});

describe("failure attribution and after-hook safety", () => {
  test("a denied pre-hook call cannot poison a provider circuit", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("main", "build");

    const denied = await before(engine, "duckduckgo_search", "main", "n1", { query: "x" });
    expect(denied.reason).toBe("agent_denied");
    await recordError(engine,
      failedCall("duckduckgo_search", "main", "n1", "401 Unauthorized: invalid key"),
    );

    const state = await stateJson(dir);
    expect(state.providers.duckduckgo?.failures ?? 0).toBe(0);
    expect(state.providers.duckduckgo?.requiresOperator ?? false).toBe(false);

    engine.noteAgent("main", "fetch");
    const allowed = await before(engine, "duckduckgo_search", "main", "n2", { query: "y" });
    expect(allowed.allowed).toBe(true);
  });

  test("budget and provider-limit denials cannot poison provider circuits", async () => {
    const { engine, dir } = await harness({
      env: { EXA_API_KEY: "exa-key", TINYFISH_API_KEY: "tiny-key" },
    });
    engine.noteAgent("s", "fetch");
    engine.noteAgent("s2", "fetch");
    await before(engine, "duckduckgo_search", "s", "b1", { query: "same" });
    await before(engine, "websearch", "s", "b2", { query: "same" });
    const limited = await before(engine, "exa_web_search_exa", "s", "b3", { query: "same" });
    expect(limited.reason).toBe("provider_limit");
    await recordError(engine,
      failedCall("exa_web_search_exa", "s", "b3", "401 Unauthorized: invalid key"),
    );
    const afterLimit = await stateJson(dir);
    expect(afterLimit.providers.exa?.failures ?? 0).toBe(0);
    expect(afterLimit.providers.exa?.requiresOperator ?? false).toBe(false);

    const budgetDenied = await before(engine, "duckduckgo_search", "s", "b4", {
      query: "different",
    });
    expect(budgetDenied.reason).toBe("budget_exhausted");
    await recordError(engine,
      failedCall("duckduckgo_search", "s", "b4", "429 Too Many Requests"),
    );
    const afterBudget = await stateJson(dir);
    expect(afterBudget.providers.duckduckgo?.failures ?? 0).toBe(0);

    expect(
      (await before(engine, "exa_web_search_exa", "s2", "b5", { query: "fresh" })).allowed,
    ).toBe(true);
  });

  test("read 403 blocks the resource only; unrelated URLs and provider work", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("s", "fetch");
    const blockedUrl = "https://blocked.example/a";
    const otherUrl = "https://healthy.example/b";

    expect((await before(engine, "webfetch", "s", "r1", { url: blockedUrl })).allowed).toBe(true);
    await recordError(engine,
      failedCall("webfetch", "s", "r1", "403 access denied by site policy"),
    );
    const state = await stateJson(dir);
    expect(state.providers.builtin_webfetch?.cooldownUntil).toBeUndefined();
    expect(state.providers.builtin_webfetch?.requiresOperator ?? false).toBe(false);

    expect((await before(engine, "webfetch", "s", "r2", { url: otherUrl })).allowed).toBe(true);
    const blocked = await before(engine, "webfetch", "s", "r3", { url: blockedUrl });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("resource_blocked");
  });

  test("read site auth/quota is resource-scoped and does not poison provider", async () => {
    const auth = await harness();
    auth.engine.noteAgent("s", "fetch");
    const blockedAuth = "https://site-auth.example/a";
    const healthyAuth = "https://site-auth.example/b";
    await before(auth.engine, "webfetch", "s", "sa1", { url: blockedAuth });
    await recordError(auth.engine, failedCall("webfetch", "s", "sa1", "401 Unauthorized"));
    let state = await stateJson(auth.dir);
    expect(state.providers.builtin_webfetch?.requiresOperator ?? false).toBe(false);
    expect(state.providers.builtin_webfetch?.cooldownUntil).toBeUndefined();
    expect(state.providers.builtin_webfetch?.failures ?? 0).toBe(0);
    expect((await before(auth.engine, "webfetch", "s", "sa2", { url: healthyAuth })).allowed).toBe(
      true,
    );
    const authBlocked = await before(auth.engine, "webfetch", "s", "sa3", { url: blockedAuth });
    expect(authBlocked.reason).toBe("resource_blocked");
    auth.engine.noteAgent("other", "fetch");
    const authFallback = await before(
      auth.engine,
      "duckduckgo_fetch_content",
      "other",
      "sa4",
      { url: blockedAuth },
    );
    expect(authFallback.reason).toBe("resource_blocked");

    const quota = await harness();
    quota.engine.noteAgent("s", "fetch");
    const blockedQuota = "https://site-quota.example/a";
    const healthyQuota = "https://site-quota.example/b";
    await before(quota.engine, "webfetch", "s", "sq1", { url: blockedQuota });
    await recordError(quota.engine, failedCall("webfetch", "s", "sq1", "429 Too Many Requests"));
    state = await stateJson(quota.dir);
    expect(state.providers.builtin_webfetch?.requiresOperator ?? false).toBe(false);
    expect(state.providers.builtin_webfetch?.cooldownUntil).toBeUndefined();
    expect((await before(quota.engine, "webfetch", "s", "sq2", { url: healthyQuota })).allowed).toBe(
      true,
    );
    const quotaBlocked = await before(quota.engine, "webfetch", "s", "sq3", { url: blockedQuota });
    expect(quotaBlocked.reason).toBe("resource_blocked");

    const ambiguous = await harness();
    ambiguous.engine.noteAgent("s", "fetch");
    const blockedAmbiguous = "https://ambiguous.example/a";
    const healthyAmbiguous = "https://ambiguous.example/b";
    await before(ambiguous.engine, "webfetch", "s", "sam1", { url: blockedAmbiguous });
    await recordError(ambiguous.engine, failedCall("webfetch", "s", "sam1", "tool failed"));
    state = await stateJson(ambiguous.dir);
    expect(state.providers.builtin_webfetch?.cooldownUntil).toBeUndefined();
    expect(state.providers.builtin_webfetch?.failures ?? 0).toBe(0);
    expect(
      (await before(ambiguous.engine, "webfetch", "s", "sam2", { url: healthyAmbiguous })).allowed,
    ).toBe(true);
    const ambiguousBlocked = await before(ambiguous.engine, "webfetch", "s", "sam3", {
      url: blockedAmbiguous,
    });
    expect(ambiguousBlocked.reason).toBe("resource_blocked");
  });

  test("read provider auth (401) still cools the provider", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("s", "fetch");
    await before(engine, "webfetch", "s", "p1", { url: "https://auth.example/a" });
    await recordError(engine,
      failedCall("webfetch", "s", "p1", "401 Unauthorized: invalid API key"),
    );
    const state = await stateJson(dir);
    expect(state.providers.builtin_webfetch.requiresOperator).toBe(true);

    const denied = await before(engine, "webfetch", "s", "p2", {
      url: "https://auth.example/b",
    });
    expect(denied.reason).toBe("provider_operator_action_required");
  });

  test("after with no authorized pending call cannot count success or clear auth", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("s", "fetch");
    await before(engine, "duckduckgo_search", "s", "a1", { query: "auth" });
    await recordError(engine,
      failedCall("duckduckgo_search", "s", "a1", "401 Unauthorized: invalid key"),
    );

    await engine.after(
      { tool: "duckduckgo_search", sessionID: "s", callID: "a2", args: {} },
      { title: "completed", output: "", metadata: {} },
    );
    const state = await stateJson(dir);
    expect(state.providers.duckduckgo.successes).toBe(0);
    expect(state.providers.duckduckgo.requiresOperator).toBe(true);

    const denied = await before(engine, "duckduckgo_search", "s", "a3", { query: "next" });
    expect(denied.reason).toBe("provider_operator_action_required");
  });

  test("after classifies error metadata instead of success", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("s", "fetch");
    await before(engine, "duckduckgo_search", "s", "e1", { query: "quota" });
    await engine.after(
      { tool: "duckduckgo_search", sessionID: "s", callID: "e1", args: {} },
      {
        title: "failed",
        output: "",
        metadata: {
          status: "error",
          isError: true,
          error: "429 Too Many Requests",
          retry_after_ms: 60_000,
        },
      },
    );
    const state = await stateJson(dir);
    expect(state.providers.duckduckgo.successes).toBe(0);
    expect(state.providers.duckduckgo.failures).toBe(1);
    expect(state.providers.duckduckgo.cooldownUntil).toBeGreaterThan(0);

    const denied = await before(engine, "duckduckgo_search", "s", "e2", { query: "next" });
    expect(denied.reason).toBe("provider_circuit_open");
  });

  test("after treats nonzero exit metadata as failure", async () => {
    const { engine, dir } = await harness();
    engine.noteAgent("s", "fetch");
    await before(engine, "gh_grep_searchGitHub", "s", "x1", { query: "exit" });
    await engine.after(
      { tool: "gh_grep_searchGitHub", sessionID: "s", callID: "x1", args: {} },
      { title: "failed", output: "", metadata: { exitCode: 1 } },
    );
    const state = await stateJson(dir);
    expect(state.providers.gh_grep.successes).toBe(0);
    expect(state.providers.gh_grep.failures).toBe(1);
    expect(state.providers.gh_grep.cooldownUntil).toBeGreaterThan(0);
  });
});

describe("batch reads and opaque resources", () => {
  test("counts each URL and rejects over-budget batches instead of truncating", async () => {
    const { engine } = await harness({ env: { EXA_API_KEY: "key" } });
    engine.noteAgent("s", "fetch");
    engine.noteAgent("fresh", "fetch");

    const three = await before(engine, "exa_web_fetch_exa", "s", "b1", {
      urls: ["https://a.test/1", "https://a.test/2", "https://a.test/3"],
    });
    expect(three.allowed).toBe(true);
    let status = await engine.status({}, { sessionID: "s", agent: "fetch" });
    expect(status.report?.used.read).toBe(3);
    expect(status.report?.remaining.read).toBe(0);

    const overBudget = await before(engine, "exa_web_fetch_exa", "s", "b2", {
      urls: ["https://a.test/4"],
    });
    expect(overBudget.reason).toBe("budget_exhausted");
    expect(overBudget.allowedNextProviders).toEqual([]);

    const overBatch = await before(engine, "exa_web_fetch_exa", "fresh", "b3", {
      urls: ["https://a.test/1", "https://a.test/2", "https://a.test/3", "https://a.test/4"],
    });
    expect(overBatch.reason).toBe("batch_too_large");
    expect(overBatch.allowedNextProviders).toEqual([]);
    const batchStatus = await engine.status({}, { sessionID: "fresh", agent: "fetch" });
    expect(batchStatus.report?.used.read).toBe(1);
    expect(batchStatus.report?.used.blockedRead).toBe(1);

    const opaque = await before(engine, "duckduckgo_expand_link", "fresh", "b4", {
      token: "opaque-token",
    });
    expect(opaque.reason).toBe("opaque_resource_unverifiable");
    const opaqueStatus = await engine.status({}, { sessionID: "fresh", agent: "fetch" });
    expect(opaqueStatus.report?.used.read).toBe(2);
    expect(opaqueStatus.report?.used.blockedRead).toBe(2);
  });

  test("checks blocked resources per URL across extractors, but only for that URL", async () => {
    const { engine } = await harness({ env: { EXA_API_KEY: "key" } });
    engine.noteAgent("s", "fetch");
    const blockedUrl = "https://blocked.test/page";
    const otherUrl = "https://healthy.test/page";

    await before(engine, "exa_web_fetch_exa", "s", "x1", { url: blockedUrl });
    await recordError(engine,
      failedCall("exa_web_fetch_exa", "s", "x1", "403 access denied by site policy"),
    );

    const viaOtherExtractor = await before(engine, "webfetch", "s", "x2", { url: blockedUrl });
    expect(viaOtherExtractor.reason).toBe("resource_blocked");
    expect(viaOtherExtractor.allowedNextProviders).toEqual([]);

    const differentUrl = await before(engine, "webfetch", "s", "x3", { url: otherUrl });
    expect(differentUrl.allowed).toBe(true);
  });

  test("enforces two-provider limits per URL", async () => {
    const { engine } = await harness({ env: { EXA_API_KEY: "key" } });
    engine.noteAgent("s", "fetch");
    const url = "https://same.test/page";

    expect((await before(engine, "exa_web_fetch_exa", "s", "p1", { url })).allowed).toBe(true);
    expect((await before(engine, "webfetch", "s", "p2", { url })).allowed).toBe(true);
    const third = await before(engine, "duckduckgo_fetch_content", "s", "p3", { url });
    expect(third.reason).toBe("provider_limit");
    expect(third.allowedNextProviders).toEqual([]);
  });

  test("rejects UNC and file network Semble repos", async () => {
    const { engine } = await harness();
    engine.noteAgent("explore", "explore");
    for (const [index, repo] of [
      "\\\\server\\share\\repo",
      "//server/share/repo",
      "file://server/share/repo",
    ].entries()) {
      const denied = await before(engine, "semble_search", "explore", `u${index}`, {
        query: "find",
        repo,
      });
      expect(denied.reason).toBe("remote_repo_forbidden");
    }
    const localFileUrl = await before(engine, "semble_search", "explore", "u9", {
      query: "find",
      repo: "file:///C:/Users/hermes/src",
    });
    expect(localFileUrl.allowed).toBe(true);
  });
});

describe("namespaced retry identity", () => {
  test("uses the normalized tool name for one bounded retry", async () => {
    const { engine } = await harness({ env: { EXA_API_KEY: "key" } });
    engine.noteAgent("s", "fetch");
    const tool = "mcp__exa__web_search_exa";

    expect((await before(engine, tool, "s", "m1", { query: "same" })).allowed).toBe(true);
    await recordError(engine, failedCall(tool, "s", "m1", "ETIMEDOUT"));
    expect((await before(engine, tool, "s", "m2", { query: "same" })).allowed).toBe(true);
    await recordError(engine, failedCall(tool, "s", "m2", "ETIMEDOUT"));
    const third = await before(engine, tool, "s", "m3", { query: "same" });
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("provider_circuit_open");
  });

  test("success clears a namespaced retry allowance", async () => {
    const { engine } = await harness({ env: { EXA_API_KEY: "key" } });
    engine.noteAgent("s", "fetch");
    const tool = "mcp__exa__web_search_exa";

    await before(engine, tool, "s", "n1", { query: "same" });
    await recordError(engine, failedCall(tool, "s", "n1", "ETIMEDOUT"));
    expect((await before(engine, tool, "s", "n2", { query: "same" })).allowed).toBe(true);
    await engine.after(
      { tool, sessionID: "s", callID: "n2", args: { query: "same" } },
      { title: "ok", output: "", metadata: {} },
    );
    expect((await before(engine, tool, "s", "n3", { query: "same" })).allowed).toBe(true);
  });
});

describe("operator provider reset", () => {
  test("root build/plan can clear auth state without touching budgets or rate caps", async () => {
    const sessions: SessionMap = {
      root: {},
      child: { parentID: "root" },
      childBuild: { parentID: "root" },
    };
    const { engine, dir } = await harness({
      sessions,
      env: { EXA_API_KEY: "key", TINYFISH_API_KEY: "key" },
    });
    engine.noteAgent("root", "build");
    engine.noteAgent("child", "fetch");
    engine.noteAgent("childBuild", "build");

    await before(engine, "exa_web_search_exa", "child", "z1", { query: "auth" });
    await recordError(engine,
      failedCall("exa_web_search_exa", "child", "z1", "401 Unauthorized: invalid key"),
    );
    const beforeReset = await engine.status({}, { sessionID: "child", agent: "fetch" });
    expect(beforeReset.report?.remaining.search).toBe(2);

    const reset = await engine.resetProvider(
      { provider: "exa" },
      { sessionID: "root", agent: "build" },
    );
    expect(reset.ok).toBe(true);
    expect(reset.provider).toBe("exa");
    expect(reset.reset).toContain("operator_required");

    const afterReset = await engine.status({}, { sessionID: "child", agent: "fetch" });
    expect(afterReset.report?.remaining.search).toBe(2);
    expect(
      (await before(engine, "exa_web_search_exa", "child", "z2", { query: "next" })).allowed,
    ).toBe(true);

    const workerReset = await engine.resetProvider(
      { provider: "exa" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(workerReset.reason).toBe("reset_not_authorized");

    const childBuildReset = await engine.resetProvider(
      { provider: "exa" },
      { sessionID: "childBuild", agent: "build" },
    );
    expect(childBuildReset.reason).toBe("reset_not_authorized");

    // TinyFish local rate counters survive an auth reset.
    await before(engine, "websearch", "child", "t1", { query: "tiny" });
    await recordError(engine,
      failedCall("websearch", "child", "t1", "401 Unauthorized: invalid key"),
    );
    const tinyReset = await engine.resetProvider(
      { provider: "tinyfish" },
      { sessionID: "root", agent: "build" },
    );
    expect(tinyReset.ok).toBe(true);
    const state = await stateJson(dir);
    expect(state.providers.tinyfish.rate.minute.count).toBe(1);
  });

  test("reset rejects unknown providers", async () => {
    const { engine } = await harness();
    engine.noteAgent("root", "build");
    engine.noteSession({ id: "root" });
    const result = await engine.resetProvider(
      { provider: "not-a-provider" },
      { sessionID: "root", agent: "build" },
    );
    expect(result.reason).toBe("provider_not_found");
  });
});

describe("cross-process transactions", () => {
  test("concurrent engines cannot lose budget increments", async () => {
    const dir = await tempDir();
    const first = await harness({ dir });
    const second = await harness({ dir });
    first.engine.noteAgent("shared", "fetch");
    second.engine.noteAgent("shared", "fetch");

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first.engine : second.engine).before(
          { tool: "duckduckgo_search", sessionID: "shared", callID: `c${index}` },
          { args: { query: `unique-${index}` } },
        ),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    const denied = results.filter((result) => !result.allowed);
    expect(denied).toHaveLength(9);
    expect(denied.every((result) => result.reason === "budget_exhausted")).toBe(true);
    expect(denied.every((result) => (result.allowedNextProviders ?? []).length === 0)).toBe(true);

    const status = await first.engine.status({}, { sessionID: "shared", agent: "fetch" });
    expect(status.report?.used.search).toBe(12);
  });

  test("concurrent engines share TinyFish rate caps", async () => {
    const dir = await tempDir();
    const first = await harness({ dir, env: { TINYFISH_API_KEY: "key" } });
    const second = await harness({ dir, env: { TINYFISH_API_KEY: "key" } });

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? first.engine : second.engine).consumeNativeSearchCall(),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(30);
    expect(results.filter((result) => !result.allowed && result.reason === "minute")).toHaveLength(10);
  });

  test("a fresh engine observes a cooldown written by another instance", async () => {
    const dir = await tempDir();
    const first = await harness({ dir });
    const second = await harness({ dir });
    first.engine.noteAgent("shared", "fetch");
    second.engine.noteAgent("shared", "fetch");

    await before(first.engine, "duckduckgo_search", "shared", "q1", { query: "auth" });
    await recordError(first.engine,
      failedCall("duckduckgo_search", "shared", "q1", "401 Unauthorized: invalid key"),
    );
    const denied = await before(second.engine, "duckduckgo_search", "shared", "q2", {
      query: "next",
    });
    expect(denied.reason).toBe("provider_operator_action_required");
  });

  test("bounded lock wait fails closed and stale locks are recovered", async () => {
    const dir = await tempDir();
    const lockDir = path.join(dir, ".state.lock.d");
    const owner = path.join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      owner,
      JSON.stringify({ nonce: "held", pid: 999, createdAt: Date.now() }),
      "utf8",
    );

    const blocked = await harness({ dir, lockWaitMs: 60, lockStaleMs: 60_000 });
    blocked.engine.noteAgent("s", "fetch");
    const denied = await before(blocked.engine, "duckduckgo_search", "s", "l1", { query: "x" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("persistence_degraded");

    await rm(lockDir, { recursive: true, force: true });
    expect((await before(blocked.engine, "duckduckgo_search", "s", "l2", { query: "y" })).allowed).toBe(
      true,
    );

    await mkdir(lockDir, { recursive: true });
    await writeFile(
      owner,
      JSON.stringify({ nonce: "stale", pid: 2_147_483_647, createdAt: Date.now() - 60_000 }),
      "utf8",
    );
    const recovered = await harness({ dir, lockWaitMs: 500, lockStaleMs: 5_000 });
    recovered.engine.noteAgent("s2", "fetch");
    expect(
      (await before(recovered.engine, "duckduckgo_search", "s2", "l3", { query: "z" })).allowed,
    ).toBe(true);
  });

  test("does not steal an old lock owned by a live process", async () => {
    const dir = await tempDir();
    const lockDir = path.join(dir, ".state.lock.d");
    const owner = path.join(lockDir, "owner.json");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      owner,
      JSON.stringify({ nonce: "live-owner", pid: process.pid, createdAt: Date.now() - 60_000 }),
      "utf8",
    );

    const blocked = await harness({ dir, lockWaitMs: 80, lockStaleMs: 1_000 });
    blocked.engine.noteAgent("s", "fetch");
    const denied = await before(blocked.engine, "duckduckgo_search", "s", "live1", {
      query: "x",
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("persistence_degraded");

    const stillOwned = JSON.parse(await readFile(owner, "utf8"));
    expect(stillOwned.nonce).toBe("live-owner");
  });
});

describe("durable per-assignment governance", () => {
  test("per-query provider limits survive a fresh engine instance", async () => {
    const dir = await tempDir();
    const env = { EXA_API_KEY: "exa-key", TINYFISH_API_KEY: "tiny-key" };
    const first = await harness({ dir, env });
    first.engine.noteAgent("shared", "fetch");
    const query = "durable-provider-query";

    expect((await before(first.engine, "duckduckgo_search", "shared", "d1", { query })).allowed).toBe(
      true,
    );
    expect((await before(first.engine, "websearch", "shared", "d2", { query })).allowed).toBe(
      true,
    );

    const second = await harness({ dir, env });
    second.engine.noteAgent("shared", "fetch");
    const third = await before(second.engine, "exa_web_search_exa", "shared", "d3", { query });
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe("provider_limit");

    const stateText = await readFile(path.join(dir, "state.json"), "utf8");
    expect(stateText).not.toContain(query);
  });

  test("transient retry exhaustion survives a fresh engine instance", async () => {
    const clock = { now: 1_700_000_000_000 };
    const dir = await tempDir();
    const query = "durable-retry-query";

    const first = await harness({ dir, clock });
    first.engine.noteAgent("shared", "fetch");
    await before(first.engine, "duckduckgo_search", "shared", "r1", { query });
    await recordError(first.engine, failedCall("duckduckgo_search", "shared", "r1", "ETIMEDOUT"));

    const second = await harness({ dir, clock });
    second.engine.noteAgent("shared", "fetch");
    expect((await before(second.engine, "duckduckgo_search", "shared", "r2", { query })).allowed).toBe(
      true,
    );
    await recordError(second.engine, failedCall("duckduckgo_search", "shared", "r2", "ETIMEDOUT"));

    clock.now += 31_000;
    const third = await harness({ dir, clock });
    third.engine.noteAgent("shared", "fetch");
    const denied = await before(third.engine, "duckduckgo_search", "shared", "r3", { query });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("transient_retry_exhausted");

    const stateText = await readFile(path.join(dir, "state.json"), "utf8");
    expect(stateText).not.toContain(query);
  });

  test("success clears durable retry state and does not block new queries", async () => {
    const dir = await tempDir();
    const query = "durable-success-query";
    const sessions: SessionMap = {
      root: {},
      child: { parentID: "root" },
    };
    const first = await harness({ dir, sessions });
    first.engine.noteAgent("root", "build");
    first.engine.noteAgent("child", "fetch");
    await first.engine.extend({ session_id: "child" }, { sessionID: "root", agent: "build" });
    await before(first.engine, "duckduckgo_search", "child", "s1", { query });
    await recordError(first.engine, failedCall("duckduckgo_search", "child", "s1", "ETIMEDOUT"));

    const second = await harness({ dir, sessions });
    second.engine.noteAgent("child", "fetch");
    expect((await before(second.engine, "duckduckgo_search", "child", "s2", { query })).allowed).toBe(
      true,
    );
    await second.engine.after(
      { tool: "duckduckgo_search", sessionID: "child", callID: "s2", args: { query } },
      { title: "ok", output: "", metadata: {} },
    );

    const third = await harness({ dir, sessions });
    third.engine.noteAgent("child", "fetch");
    expect((await before(third.engine, "duckduckgo_search", "child", "s3", { query })).allowed).toBe(
      true,
    );
    expect(
      (await before(third.engine, "duckduckgo_search", "child", "s4", { query: "new-query" })).allowed,
    ).toBe(true);
  });
});
