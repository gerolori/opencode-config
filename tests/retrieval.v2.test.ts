import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Tool } from "@opencode/schema/tool";
import { InvocationIdentity } from "../lib/retrieval";
import retrievalPolicy from "../plugins/retrieval-policy";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type SessionInfo = { id: string; parentID?: string; agent?: string };
type Hook = (event: any) => Promise<void> | void;

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "retrieval-v2-"));
  dirs.push(dir);
  return dir;
}

async function harness(options: {
  sessions?: Record<string, SessionInfo>;
  providers?: string[];
  defaultProvider?: string | false;
  editorMode?: "adapter" | "missing-default" | "throw";
  mcpMode?: "ok" | "throw";
  withEventStream?: boolean;
  stateDir?: string;
  env?: Record<string, string | undefined>;
} = {}) {
  const dir = options.stateDir ?? (await tempDir());
  // Hermetic by default: never let host detection walk the real home directory
  // or read the real process environment.
  const env: Record<string, string | undefined> = {
    SEMBLE_MCP_DIR: "C:/__opencode_test_nonexistent__/semble",
    EBAY_MCP_DIR: "C:/__opencode_test_nonexistent__/ebay",
    ...(options.env ?? {}),
  };
  const sessions =
    options.sessions ??
    ({
      root: { id: "root", agent: "build" },
      child: { id: "child", parentID: "root", agent: "fetch" },
      explore: { id: "explore", parentID: "root", agent: "explore" },
      grandchild: { id: "grandchild", parentID: "child", agent: "fetch" },
      other: { id: "other", parentID: "elsewhere", agent: "fetch" },
    } satisfies Record<string, SessionInfo>);
  const hooks: Record<string, Hook[]> = {};
  const permissionHooks: Record<string, Hook[]> = {};
  const tools: any[] = [];
  let mcpTransformCalls = 0;
  const nativeProviders = new Map<string, { id: string; name: string }>();
  for (const id of options.providers ?? ["tinyfish"]) {
    nativeProviders.set(id, { id, name: id });
  }
  let nativeDefault: string | false | undefined = options.defaultProvider;
  let editorKeys: string[] = [];
  const queuedEvents: any[] = [];
  let pendingEvent:
    | ((result: IteratorResult<any>) => void)
    | undefined;
  const eventIterator = {
    next(): Promise<IteratorResult<any>> {
      const next = queuedEvents.shift();
      if (next !== undefined) return Promise.resolve({ value: next, done: false });
      return new Promise((resolve) => {
        pendingEvent = resolve;
      });
    },
    return(): Promise<IteratorResult<any>> {
      if (pendingEvent) {
        const resolve = pendingEvent;
        pendingEvent = undefined;
        resolve({ value: undefined, done: true });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const emitPermissionEvent = async (value: any) => {
    if (pendingEvent) {
      const resolve = pendingEvent;
      pendingEvent = undefined;
      resolve({ value, done: false });
    } else {
      queuedEvents.push(value);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const mcpServers = new Map<string, any>();
  const context: any = {
    options: { stateDir: dir, env },
    ...(options.withEventStream ? { event: { subscribe: () => eventIterator } } : {}),
    websearch: {
      async providers() {
        return { data: [...nativeProviders.values()] };
      },
      async transform(callback: (editor: any) => void) {
        if (options.editorMode === "throw") throw new Error("broken websearch editor");
        // Mirrors @opencode/plugin/dist/promise/adapter.js:426-435: the public
        // promise adapter exposes ONLY add and default.
        const editor: any = {
          add: (provider: { id: string; name: string }) =>
            nativeProviders.set(provider.id, provider),
          default: {
            get: () => nativeDefault,
            set: (selection: string | false) => {
              nativeDefault = selection;
            },
          },
        };
        if (options.editorMode === "missing-default") delete editor.default;
        editorKeys = Object.keys(editor);
        callback(editor);
        return { dispose: async () => {} };
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        const info = sessions[sessionID];
        if (!info) throw new Error(`missing session ${sessionID}`);
        return info;
      },
    },
    mcp: {
      async transform(callback: (editor: any) => void) {
        mcpTransformCalls += 1;
        if (options.mcpMode === "throw") throw new Error("broken mcp editor");
        // Complete MCPEditor surface used by registerHostConfig: a missing
        // get/set would otherwise throw into the optional-setup catch and be
        // silently ignored by the test.
        callback({
          list: () => [...mcpServers.entries()],
          get: (name: string) => mcpServers.get(name),
          set: (name: string, server: any) => {
            mcpServers.set(name, server);
          },
          update: (name: string, update: (server: any) => void) => {
            const server = mcpServers.get(name);
            if (server) update(server);
          },
        });
        return { dispose: async () => {} };
      },
    },
    permission: {
      async hook(name: string, callback: Hook) {
        (permissionHooks[name] ??= []).push(callback);
        return { dispose: async () => {} };
      },
    },
    tool: {
      async hook(name: string, callback: Hook) {
        (hooks[name] ??= []).push(callback);
        return { dispose: async () => {} };
      },
      async transform(callback: (editor: any) => void) {
        callback({ add: (tool: any) => tools.push(tool) });
        return { dispose: async () => {} };
      },
    },
  };
  const cleanup = await retrievalPolicy.setup(context);
  if (cleanup) cleanups.push(cleanup);
  return {
    dir,
    hooks,
    permissionHooks,
    tools,
    context,
    sessions,
    emitPermissionEvent,
    mcpTransformCalls: () => mcpTransformCalls,
    mcpServerNames: () => [...mcpServers.keys()].sort(),
    websearchState: () => ({
      providers: [...nativeProviders.keys()],
      default: nativeDefault,
    }),
    editorKeys: () => editorKeys,
  };
}

function event(
  tool: string,
  sessionID: string,
  id: string,
  input: unknown,
  agent: string,
) {
  return {
    tool,
    sessionID,
    agent,
    messageID: "msg_1",
    id,
    input,
  };
}

async function callBefore(hooks: Record<string, Hook[]>, eventValue: any) {
  const callback = hooks["execute.before"]?.[0];
  if (!callback) throw new Error("missing execute.before");
  await callback(eventValue);
}

async function callAfter(hooks: Record<string, Hook[]>, eventValue: any) {
  const callback = hooks["execute.after"]?.[0];
  if (!callback) throw new Error("missing execute.after");
  await callback(eventValue);
}

async function control(
  tools: any[],
  input: Record<string, unknown>,
  context: { sessionID: string; agent: string },
) {
  const tool = tools.find((entry) => entry.name === "retrieval_control");
  if (!tool) throw new Error("missing retrieval_control");
  const result = await tool.execute(input, {
    sessionID: context.sessionID,
    agent: context.agent,
    messageID: "msg_1",
    id: "call_control",
    signal: new AbortController().signal,
    async progress() {},
  });
  return JSON.parse(result.content);
}

// Mirrors 2.2.5 WebSearch.selection/defaultProvider:
// false disables; random picks an available provider; a provider ID is only
// usable when it remains in the native catalog.
function resolveNativeProvider(state: {
  providers: string[];
  default: string | false | undefined;
  storedKv?: string | false;
}): string | false {
  const selection = state.default;
  if (selection === false) return false;
  if (selection === "random") return state.providers[0] ?? false;
  if (selection && state.providers.includes(selection)) return selection;
  // 2.2.5 selection only consults stored KV when editor.selection is absent.
  const stored = state.storedKv;
  if (stored === false) return false;
  if (stored === "random") return state.providers[0] ?? false;
  if (stored && state.providers.includes(stored)) return stored;
  return false;
}

async function expectToolDenial(action: () => Promise<void>): Promise<Tool.Error> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Tool.Error);
    return error as Tool.Error;
  }
  throw new Error("expected Tool.Error");
}

describe("invocation identity", () => {
  test("handles shared outer IDs sequentially, concurrently, and out of order", () => {
    const identity = new InvocationIdentity();
    const inputA = { query: "secret-alpha" };
    const inputB = { query: "secret-beta" };

    const a1 = identity.begin("child", "outer", "duckduckgo_search", inputA);
    const b1 = identity.begin("child", "outer", "duckduckgo_search", inputB);
    expect(a1).not.toBe(b1);
    expect(a1).not.toContain("secret-alpha");
    expect(identity.complete("child", "outer", "duckduckgo_search", inputB)).toBe(b1);
    expect(identity.complete("child", "outer", "duckduckgo_search", inputA)).toBe(a1);

    const sequential1 = identity.begin("child", "outer", "duckduckgo_search", inputA);
    expect(identity.complete("child", "outer", "duckduckgo_search", inputA)).toBe(
      sequential1,
    );
    const sequential2 = identity.begin("child", "outer", "duckduckgo_search", inputA);
    expect(sequential2).not.toBe(sequential1);
    expect(identity.complete("child", "outer", "duckduckgo_search", inputA)).toBe(
      sequential2,
    );
  });

  test("queues repeated identical calls and supports abandonment", () => {
    const identity = new InvocationIdentity();
    const input = { query: "same" };
    const first = identity.begin("child", "outer", "duckduckgo_search", input);
    const second = identity.begin("child", "outer", "duckduckgo_search", input);
    expect(second).not.toBe(first);
    expect(identity.complete("child", "outer", "duckduckgo_search", input)).toBe(
      first,
    );
    expect(identity.complete("child", "outer", "duckduckgo_search", input)).toBe(
      second,
    );
    expect(identity.complete("child", "outer", "duckduckgo_search", input)).toBe(
      undefined,
    );

    const abandoned = identity.begin("child", "outer", "x", {});
    identity.abandon(abandoned);
    expect(identity.complete("child", "outer", "x", {})).toBeUndefined();
  });

  test("abandons all pending calls for an outer invocation", () => {
    const identity = new InvocationIdentity();
    const a = identity.begin("child", "outer-clean", "duckduckgo_search", { query: "a" });
    const b = identity.begin("child", "outer-clean", "duckduckgo_search", { query: "b" });
    const c = identity.begin("child", "outer-clean", "duckduckgo_search", { query: "a" });
    const other = identity.begin("child", "outer-other", "duckduckgo_search", { query: "a" });

    const abandoned = identity.abandonOuter("child", "outer-clean");
    expect(abandoned.sort()).toEqual([a, b, c].sort());
    expect(identity.complete("child", "outer-clean", "duckduckgo_search", { query: "a" })).toBeUndefined();
    expect(identity.complete("child", "outer-clean", "duckduckgo_search", { query: "b" })).toBeUndefined();
    expect(identity.complete("child", "outer-other", "duckduckgo_search", { query: "a" })).toBe(other);

    const fresh = identity.begin("child", "outer-clean", "duckduckgo_search", { query: "a" });
    expect(identity.complete("child", "outer-clean", "duckduckgo_search", { query: "a" })).toBe(fresh);
  });
});

describe("retrieval-policy 2.x staging plugin", () => {
  test("installed promise adapter exposes only add/default for websearch", async () => {
    const source = await readFile(
      path.join(import.meta.dir, "..", "node_modules", "@opencode", "plugin", "dist", "promise", "adapter.js"),
      "utf8",
    );
    const start = source.indexOf("websearch: {");
    const end = source.indexOf("worktree: {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).toContain("add:");
    expect(block).toContain("default: editor.default");
    expect(block).not.toContain("list:");
    expect(block).not.toContain("remove:");
  });

  test("real fromPromise adapter hides list/remove from the websearch editor", async () => {
    const [{ fromPromise }, { Effect }] = await Promise.all([
      import("@opencode/plugin/promise/adapter"),
      import("effect"),
    ]);
    let keys: string[] = [];
    const hostEditor = {
      add() {},
      list: () => [],
      remove() {},
      default: {
        get: () => undefined,
        set() {},
      },
    };
    const websearch = {
      providers: () => Effect.succeed({ data: [{ id: "tinyfish", name: "TinyFish" }] }),
      query: () => Effect.succeed({ providerID: "tinyfish", results: [] }),
      reload: () => Effect.succeed(undefined),
      transform: (callback: (editor: any) => void) =>
        Effect.sync(() => {
          callback(hostEditor);
          return { dispose: async () => {} };
        }),
    };
    const anyProxy: any = new Proxy(
      function () {
        return anyProxy;
      },
      {
        get(_target, property) {
          return property === "then" ? undefined : anyProxy;
        },
        apply() {
          return anyProxy;
        },
      },
    );
    const host = new Proxy(
      { websearch },
      {
        get(target, property) {
          return property in target ? (target as any)[property] : anyProxy;
        },
      },
    );
    const probe = fromPromise({
      id: "probe",
      async setup(context: any) {
        await context.websearch.transform((editor: any) => {
          keys = Object.keys(editor);
          editor.default.set("tinyfish");
        });
      },
    } as any);
    await Effect.runPromise(Effect.scoped((probe as any).effect(host)));
    expect(keys.sort()).toEqual(["add", "default"]);
  });

  test("registers promise hooks and ignores the outer Code Mode execute", async () => {
    const h = await harness();
    expect(h.hooks["execute.before"]?.length).toBe(1);
    expect(h.hooks["execute.after"]?.length).toBe(1);
    expect(h.tools.map((tool) => tool.name)).toContain("retrieval_control");
    expect(h.mcpTransformCalls()).toBe(1);
    // The complete editor mock and hermetic env mean host initialization did
    // not throw into the plugin's optional-setup guard.
    expect(h.mcpServerNames()).toEqual([]);
    expect(h.editorKeys()).toEqual(["add", "default"]);

    await callBefore(
      h.hooks,
      event("execute", "child", "outer-1", { code: "return 1" }, "fetch"),
    );
    await callAfter(h.hooks, {
      ...event("execute", "child", "outer-1", { code: "return 1" }, "fetch"),
      status: "completed",
      result: { content: "1" },
    });

    const status = await control(h.tools, { action: "status" }, {
      sessionID: "child",
      agent: "fetch",
    });
    expect(status.ok).toBe(true);
    expect(status.report.used.search).toBe(0);
    expect(status.report.used.read).toBe(0);
  });

  test("incomplete websearch editors fail closed while core policy stays installed", async () => {
    for (const editorMode of ["missing-default", "throw"] as const) {
      const h = await harness({ providers: ["tinyfish"], editorMode });
      expect(h.hooks["execute.before"]?.length).toBe(1);
      expect(h.hooks["execute.after"]?.length).toBe(1);
      expect(h.permissionHooks.evaluate?.length).toBe(1);
      expect(h.tools.map((tool) => tool.name)).toContain("retrieval_control");

      const denied = await expectToolDenial(() =>
        callBefore(
          h.hooks,
          event("websearch", "child", "broken-1", { query: "x" }, "fetch"),
        ),
      );
      expect(denied.message).toContain("native_search_provider_unavailable");

      const mcp = event(
        "duckduckgo_search",
        "other",
        "mcp-1",
        { query: "still governed" },
        "fetch",
      );
      await callBefore(h.hooks, mcp);
      await callAfter(h.hooks, {
        ...mcp,
        status: "completed",
        result: { content: "ok", metadata: {} },
      });
      const status = await control(h.tools, { action: "status" }, {
        sessionID: "other",
        agent: "fetch",
      });
      expect(status.report.used.search).toBe(1);
    }
  });

  test("reports host-config setup failure without disabling core policy", async () => {
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      messages.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const h = await harness({ mcpMode: "throw" });
      expect(h.hooks["execute.before"]?.length).toBe(1);
      expect(h.hooks["execute.after"]?.length).toBe(1);
      expect(h.tools.map((tool) => tool.name)).toContain("retrieval_control");
      expect(messages.join("\n")).toContain("host config setup failed");
    } finally {
      console.error = originalError;
    }
  });

  test("denies raw Code Mode fetch for every agent and budgets normal webfetch", async () => {
    const h = await harness();
    let httpCalls = 0;
    const previousFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      httpCalls += 1;
      return new Response("{}", { status: 200 });
    };
    try {
      const outer = event(
        "execute",
        "child",
        "outer-raw",
        { code: "fetch('https://raw.example')" },
        "fetch",
      );
      await callBefore(h.hooks, outer);
      const evaluate = h.permissionHooks.evaluate?.[0];
      expect(typeof evaluate).toBe("function");

      const raw: any = {
        sessionID: "child",
        agent: "fetch",
        action: "webfetch",
        resources: ["https://raw.example"],
        metadata: {},
        source: { type: "tool", messageID: "msg_1", id: "outer-raw" },
      };
      await evaluate(raw);
      expect(raw.effect).toBe("deny");

      const buildOuter = event(
        "execute",
        "root",
        "outer-build-raw",
        { code: "fetch('https://raw.example')" },
        "build",
      );
      await callBefore(h.hooks, buildOuter);
      const rawBuild: any = {
        sessionID: "root",
        agent: "build",
        action: "webfetch",
        resources: ["https://raw.example"],
        metadata: {},
        source: { type: "tool", messageID: "msg_1", id: "outer-build-raw" },
      };
      await evaluate(rawBuild);
      expect(rawBuild.effect).toBe("deny");

      const unmatched: any = {
        sessionID: "child",
        agent: "fetch",
        action: "webfetch",
        resources: ["https://ghost.example"],
        metadata: {},
        source: { type: "tool", messageID: "msg_1", id: "ghost-fetch" },
      };
      await evaluate(unmatched);
      expect(unmatched.effect).toBe("deny");
      expect(httpCalls).toBe(0);

      await callAfter(h.hooks, {
        ...outer,
        status: "completed",
        result: { content: "{}" },
      });
      await callAfter(h.hooks, {
        ...buildOuter,
        status: "completed",
        result: { content: "{}" },
      });

      const webfetch = event(
        "webfetch",
        "child",
        "wf-normal",
        { url: "https://normal.example" },
        "fetch",
      );
      await callBefore(h.hooks, webfetch);
      const normal: any = {
        sessionID: "child",
        agent: "fetch",
        action: "webfetch",
        resources: ["https://normal.example"],
        metadata: {},
        source: { type: "tool", messageID: "msg_1", id: "wf-normal" },
      };
      await evaluate(normal);
      expect(normal.effect).not.toBe("deny");
      await callAfter(h.hooks, {
        ...webfetch,
        status: "completed",
        result: { content: "ok", metadata: {} },
      });
      const stale: any = { ...normal };
      await evaluate(stale);
      expect(stale.effect).toBe("deny");

      const status = await control(h.tools, { action: "status" }, {
        sessionID: "child",
        agent: "fetch",
      });
      expect(status.report.used.read).toBe(1);
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
  });

  test("per-leaf caps stop a mocked multi-call Code Mode script", async () => {
    const h = await harness();
    await callBefore(
      h.hooks,
      event("execute", "child", "outer-2", { code: "many calls" }, "fetch"),
    );

    for (let index = 0; index < 3; index += 1) {
      const leaf = event(
        "duckduckgo_search",
        "child",
        "outer-2",
        { query: `query-${index}` },
        "fetch",
      );
      await callBefore(h.hooks, leaf);
      await callAfter(h.hooks, {
        ...leaf,
        status: "completed",
        result: { content: "ok", metadata: {} },
      });
    }

    const denied = await expectToolDenial(() =>
      callBefore(
        h.hooks,
        event("duckduckgo_search", "child", "outer-2", { query: "query-4" }, "fetch"),
      ),
    );
    expect(denied.message).toContain("budget_exhausted");

    const status = await control(h.tools, { action: "status" }, {
      sessionID: "child",
      agent: "fetch",
    });
    expect(status.report.used.search).toBe(4);
    expect(status.report.remaining.search).toBe(0);
  });

  test("accounts repeated identical and out-of-order leaves sharing an id", async () => {
    const h = await harness();
    const extended = await control(
      h.tools,
      { action: "extend", session_id: "child" },
      { sessionID: "root", agent: "build" },
    );
    expect(extended.ok).toBe(true);

    await callBefore(
      h.hooks,
      event("execute", "child", "outer-3", { code: "many" }, "fetch"),
    );

    const identical = { query: "identical" };
    for (let index = 0; index < 2; index += 1) {
      await callBefore(
        h.hooks,
        event("duckduckgo_search", "child", "outer-3", identical, "fetch"),
      );
    }
    for (let index = 0; index < 2; index += 1) {
      await callAfter(h.hooks, {
        ...event("duckduckgo_search", "child", "outer-3", identical, "fetch"),
        status: "completed",
        result: { content: "ok", metadata: {} },
      });
    }

    const first = { query: "first-input" };
    const second = { query: "second-input" };
    await callBefore(
      h.hooks,
      event("duckduckgo_search", "child", "outer-3", first, "fetch"),
    );
    await callBefore(
      h.hooks,
      event("duckduckgo_search", "child", "outer-3", second, "fetch"),
    );
    await callAfter(h.hooks, {
      ...event("duckduckgo_search", "child", "outer-3", second, "fetch"),
      status: "completed",
      result: { content: "ok", metadata: {} },
    });
    await callAfter(h.hooks, {
      ...event("duckduckgo_search", "child", "outer-3", first, "fetch"),
      status: "completed",
      result: { content: "ok", metadata: {} },
    });

    const status = await control(h.tools, { action: "status" }, {
      sessionID: "child",
      agent: "fetch",
    });
    expect(status.report.used.search).toBe(4);
  });

  test("cleans pending identity when an outer ends without leaf-after", async () => {
    const h = await harness();
    const input = { query: "cleanup" };
    const outer = event("execute", "child", "outer-cleanup", { code: "work" }, "fetch");
    await callBefore(h.hooks, outer);

    const leaf = event("duckduckgo_search", "child", "outer-cleanup", input, "fetch");
    await callBefore(h.hooks, leaf);
    // Simulate an interrupted/finished outer with no matching leaf-after.
    await callAfter(h.hooks, {
      ...outer,
      status: "error",
      error: new Tool.Error({ message: "interrupted" }),
    });

    // A late leaf-after must not consume or attribute the abandoned call.
    await callAfter(h.hooks, {
      ...leaf,
      status: "completed",
      result: { content: "ok", metadata: {} },
    });
    let state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo?.successes ?? 0).toBe(0);
    expect(state.providers.duckduckgo?.failures ?? 0).toBe(0);

    // A fresh identical invocation still works with its own identity.
    await callBefore(h.hooks, leaf);
    await callAfter(h.hooks, {
      ...leaf,
      status: "completed",
      result: { content: "ok", metadata: {} },
    });
    state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo.successes).toBe(1);

    const status = await control(h.tools, { action: "status" }, {
      sessionID: "child",
      agent: "fetch",
    });
    expect(status.report.used.search).toBe(2);
  });

  test("permission-origin failures after authorized before are local", async () => {
    const h = await harness();
    const leaf = event("duckduckgo_search", "child", "perm-1", { query: "x" }, "fetch");
    await callBefore(h.hooks, leaf);
    const evaluate = h.permissionHooks.evaluate?.[0];
    expect(typeof evaluate).toBe("function");
    await evaluate({
      sessionID: "child",
      agent: "fetch",
      action: "duckduckgo_search",
      resources: ["x"],
      metadata: {},
      source: { type: "tool", messageID: "msg_1", id: "perm-1" },
      effect: "deny",
    });
    await callAfter(h.hooks, {
      ...leaf,
      status: "error",
      error: new Tool.Error({ message: "blocked" }),
    });

    let state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo?.failures ?? 0).toBe(0);
    expect(state.providers.duckduckgo?.cooldownUntil).toBeUndefined();
    await callBefore(
      h.hooks,
      event("duckduckgo_search", "child", "perm-2", { query: "next" }, "fetch"),
    );
    const afterPermission = await control(h.tools, { action: "status" }, {
      sessionID: "child",
      agent: "fetch",
    });
    expect(afterPermission.report.used.search).toBe(2);

    const tagged = await harness();
    const taggedLeaf = event(
      "duckduckgo_search",
      "child",
      "perm-tag",
      { query: "tagged" },
      "fetch",
    );
    await callBefore(tagged.hooks, taggedLeaf);
    await callAfter(tagged.hooks, {
      ...taggedLeaf,
      status: "error",
      error: new Tool.Error({ message: "Permission denied: duckduckgo_search" }),
    });
    state = JSON.parse(await readFile(path.join(tagged.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo?.failures ?? 0).toBe(0);
    expect(state.providers.duckduckgo?.cooldownUntil).toBeUndefined();

    const readCase = await harness();
    const readLeaf = event(
      "webfetch",
      "child",
      "perm-read",
      { url: "https://permission.example/a" },
      "fetch",
    );
    await callBefore(readCase.hooks, readLeaf);
    await callAfter(readCase.hooks, {
      ...readLeaf,
      status: "error",
      error: new Tool.Error({ message: "Permission denied: webfetch" }),
    });
    state = JSON.parse(await readFile(path.join(readCase.dir, "state.json"), "utf8"));
    expect(state.providers.builtin_webfetch?.cooldownUntil).toBeUndefined();
    // No resource block: the same URL is allowed again after a permission denial.
    await callBefore(readCase.hooks, {
      ...readLeaf,
      id: "perm-read-2",
    });
  });

  test("user-rejected permission ask stays local after authorized before", async () => {
    const h = await harness({ withEventStream: true });
    const leaf = event("duckduckgo_search", "child", "perm-ask", { query: "x" }, "fetch");
    await callBefore(h.hooks, leaf);
    const evaluate = h.permissionHooks.evaluate?.[0];
    expect(typeof evaluate).toBe("function");
    await evaluate({
      sessionID: "child",
      agent: "fetch",
      action: "duckduckgo_search",
      resources: ["x"],
      metadata: { input: { query: "x" } },
      source: { type: "tool", messageID: "msg_1", id: "perm-ask" },
      effect: "ask",
    });
    await h.emitPermissionEvent({
      type: "permission.asked",
      data: {
        id: "req-1",
        sessionID: "child",
        action: "duckduckgo_search",
        resources: ["x"],
        metadata: { input: { query: "x" } },
        source: { type: "tool", messageID: "msg_1", id: "perm-ask" },
      },
    });
    await h.emitPermissionEvent({
      type: "permission.replied",
      data: { sessionID: "child", requestID: "req-1", reply: "reject" },
    });
    await callAfter(h.hooks, {
      ...leaf,
      status: "error",
      error: new Tool.Error({ message: "401 Unauthorized: invalid API key" }),
    });

    const state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo?.failures ?? 0).toBe(0);
    expect(state.providers.duckduckgo?.requiresOperator ?? false).toBe(false);
    await callBefore(
      h.hooks,
      event("duckduckgo_search", "child", "perm-ask-next", { query: "next" }, "fetch"),
    );
  });

  test("permission reject without execute.after cleans pending identities", async () => {
    const h = await harness({ withEventStream: true });
    const leaf = event("duckduckgo_search", "child", "perm-noafter", { query: "x" }, "fetch");
    await callBefore(h.hooks, leaf);
    const evaluate = h.permissionHooks.evaluate?.[0];
    await evaluate({
      sessionID: "child",
      agent: "fetch",
      action: "duckduckgo_search",
      resources: ["x"],
      metadata: { input: { query: "x" } },
      source: { type: "tool", messageID: "msg_1", id: "perm-noafter" },
      effect: "ask",
    });
    await h.emitPermissionEvent({
      type: "permission.asked",
      data: {
        id: "req-noafter",
        sessionID: "child",
        action: "duckduckgo_search",
        resources: ["x"],
        metadata: { input: { query: "x" } },
        source: { type: "tool", messageID: "msg_1", id: "perm-noafter" },
      },
    });
    // Plain rejection is a defect, so execute.after is not guaranteed.
    await h.emitPermissionEvent({
      type: "permission.replied",
      data: { sessionID: "child", requestID: "req-noafter", reply: "reject" },
    });

    // A late after for the abandoned call must not consume/attribute it.
    await callAfter(h.hooks, {
      ...leaf,
      status: "completed",
      result: { content: "ok", metadata: {} },
    });
    let state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo?.successes ?? 0).toBe(0);
    expect(state.providers.duckduckgo?.failures ?? 0).toBe(0);

    // A new identical invocation is attributed to its own token.
    await callBefore(h.hooks, leaf);
    await callAfter(h.hooks, {
      ...leaf,
      status: "completed",
      result: { content: "ok", metadata: {} },
    });
    state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo.successes).toBe(1);
    const status = await control(h.tools, { action: "status" }, {
      sessionID: "child",
      agent: "fetch",
    });
    expect(status.report.used.search).toBe(2);

    // Direct webfetch has no outer execute to clean it; the reject path itself
    // must drop the active source so raw fetch is not authorized afterward.
    const webUrl = "https://permission.example/no-after";
    const web = event(
      "webfetch",
      "child",
      "perm-web-noafter",
      { url: webUrl },
      "fetch",
    );
    await callBefore(h.hooks, web);
    await evaluate({
      sessionID: "child",
      agent: "fetch",
      action: "webfetch",
      resources: [webUrl],
      metadata: { url: webUrl },
      source: { type: "tool", messageID: "msg_1", id: "perm-web-noafter" },
      effect: "ask",
    });
    await h.emitPermissionEvent({
      type: "permission.asked",
      data: {
        id: "req-web-noafter",
        sessionID: "child",
        action: "webfetch",
        resources: [webUrl],
        metadata: { url: webUrl },
        source: { type: "tool", messageID: "msg_1", id: "perm-web-noafter" },
      },
    });
    await h.emitPermissionEvent({
      type: "permission.replied",
      data: { sessionID: "child", requestID: "req-web-noafter", reply: "reject" },
    });
    const raw: any = {
      sessionID: "child",
      agent: "fetch",
      action: "webfetch",
      resources: [webUrl],
      metadata: {},
      source: { type: "tool", messageID: "msg_1", id: "perm-web-noafter" },
      effect: "ask",
    };
    await evaluate(raw);
    expect(raw.effect).toBe("deny");

    // A new identical direct webfetch is authorized and attributed.
    await callBefore(h.hooks, web);
    await callAfter(h.hooks, {
      ...web,
      status: "completed",
      result: { content: "ok", metadata: {} },
    });
    state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.builtin_webfetch?.successes ?? 0).toBe(1);
  });

  test("rejecting one shared-id leaf preserves sibling outcome accounting", async () => {
    const h = await harness({ withEventStream: true });
    const outer = event("execute", "child", "outer-shared", { code: "work" }, "fetch");
    await callBefore(h.hooks, outer);

    const rejected = event(
      "duckduckgo_search",
      "child",
      "outer-shared",
      { query: "rejected-input" },
      "fetch",
    );
    const sibling = event(
      "duckduckgo_search",
      "child",
      "outer-shared",
      { query: "sibling-input" },
      "fetch",
    );
    await callBefore(h.hooks, rejected);
    await callBefore(h.hooks, sibling);

    const evaluate = h.permissionHooks.evaluate?.[0];
    await evaluate({
      sessionID: "child",
      agent: "fetch",
      action: "duckduckgo_search",
      resources: ["rejected-input"],
      metadata: { input: { query: "rejected-input" } },
      source: { type: "tool", messageID: "msg_1", id: "outer-shared" },
      effect: "ask",
    });
    await h.emitPermissionEvent({
      type: "permission.asked",
      data: {
        id: "req-shared-reject",
        sessionID: "child",
        action: "duckduckgo_search",
        resources: ["rejected-input"],
        metadata: { input: { query: "rejected-input" } },
        source: { type: "tool", messageID: "msg_1", id: "outer-shared" },
      },
    });
    await h.emitPermissionEvent({
      type: "permission.replied",
      data: { sessionID: "child", requestID: "req-shared-reject", reply: "reject" },
    });

    // The rejected leaf has no after; the sibling still completes and its
    // quota failure must open the provider circuit.
    await callAfter(h.hooks, {
      ...sibling,
      status: "error",
      error: new Tool.Error({ message: "429 Too Many Requests" }),
    });
    const state = JSON.parse(await readFile(path.join(h.dir, "state.json"), "utf8"));
    expect(state.providers.duckduckgo?.successes ?? 0).toBe(0);
    expect(state.providers.duckduckgo?.failures).toBe(1);
    expect(state.providers.duckduckgo?.cooldownUntil).toBeGreaterThan(Date.now());

    const denied = await expectToolDenial(() =>
      callBefore(
        h.hooks,
        event("duckduckgo_search", "child", "outer-shared", { query: "next" }, "fetch"),
      ),
    );
    expect(denied.message).toContain("provider_circuit_open");
  });

  test("status:error after outcomes open circuits through the 2.x hook", async () => {
    const h = await harness();
    const leaf = event(
      "duckduckgo_search",
      "child",
      "err-1",
      { query: "quota" },
      "fetch",
    );
    await callBefore(h.hooks, leaf);
    await callAfter(h.hooks, {
      ...leaf,
      status: "error",
      error: new Tool.Error({ message: "429 Too Many Requests" }),
    });

    const denied = await expectToolDenial(() =>
      callBefore(
        h.hooks,
        event("duckduckgo_search", "child", "err-2", { query: "next" }, "fetch"),
      ),
    );
    expect(denied.message).toContain("provider_circuit_open");
  });

  test("before denials use Tool.Error and worker/child control actions are denied", async () => {
    const h = await harness();
    const denied = await expectToolDenial(() =>
      callBefore(
        h.hooks,
        event("duckduckgo_search", "root", "main-1", { query: "x" }, "build"),
      ),
    );
    expect(denied.message).toContain("agent_denied");

    const workerExtend = await control(
      h.tools,
      { action: "extend", session_id: "grandchild" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(workerExtend.ok).toBe(false);
    expect(workerExtend.reason).toBe("extend_not_authorized");

    const rootExtend = await control(
      h.tools,
      { action: "extend", session_id: "child" },
      { sessionID: "root", agent: "build" },
    );
    expect(rootExtend.ok).toBe(true);
    expect(rootExtend.report.limits).toEqual({ search: 6, read: 6 });

    const secondExtend = await control(
      h.tools,
      { action: "extend", session_id: "child" },
      { sessionID: "root", agent: "build" },
    );
    expect(secondExtend.reason).toBe("already_extended");

    const forgedExtend = await control(
      h.tools,
      { action: "extend", session_id: "other" },
      { sessionID: "root", agent: "build" },
    );
    expect(forgedExtend.reason).toBe("target_not_child");

    const workerReset = await control(
      h.tools,
      { action: "reset_provider", provider: "exa" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(workerReset.reason).toBe("reset_not_authorized");
  });

  test("explore discovery budget stops repeated scans and is parent-extendable", async () => {
    const h = await harness();

    // A single Code Mode outer call is not itself a discovery call.
    await callBefore(
      h.hooks,
      event("execute", "explore", "outer-explore", { code: "return 1" }, "explore"),
    );
    for (let i = 1; i <= 8; i += 1) {
      await callBefore(
        h.hooks,
        event("grep", "explore", `search-${i}`, { pattern: `p${i}` }, "explore"),
      );
    }
    // Reading a known file is evidence collection, not a new search root.
    await callBefore(
      h.hooks,
      event("read", "explore", "read-1", { path: "README.md" }, "explore"),
    );
    const denied = await expectToolDenial(() =>
      callBefore(
        h.hooks,
        event("glob", "explore", "search-9", { pattern: "**/*" }, "explore"),
      ),
    );
    expect(denied.message).toContain("discovery_budget_exhausted");

    const status = await control(
      h.tools,
      { action: "status", session_id: "explore" },
      { sessionID: "root", agent: "build" },
    );
    expect(status.ok).toBe(true);
    expect(status.report.discovery).toMatchObject({
      limit: 8,
      used: 8,
      remaining: 0,
      blocked: 1,
      extended: false,
      note: "local_search_list_calls_not_time",
    });

    const workerExtend = await control(
      h.tools,
      { action: "extend_explore", session_id: "explore" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(workerExtend.ok).toBe(false);
    expect(workerExtend.reason).toBe("extend_not_authorized");

    const forgedExtend = await control(
      h.tools,
      { action: "extend_explore", session_id: "other" },
      { sessionID: "root", agent: "build" },
    );
    expect(forgedExtend.reason).toBe("target_not_child");

    const wrongWorkerExtend = await control(
      h.tools,
      { action: "extend_explore", session_id: "child" },
      { sessionID: "root", agent: "build" },
    );
    expect(wrongWorkerExtend.reason).toBe("target_not_explore");

    const extended = await control(
      h.tools,
      { action: "extend_explore", session_id: "explore", extra_calls: 4 },
      { sessionID: "root", agent: "build" },
    );
    expect(extended.ok).toBe(true);
    expect(extended.report.discovery.limit).toBe(12);

    for (let i = 9; i <= 12; i += 1) {
      await callBefore(
        h.hooks,
        event("grep", "explore", `search-${i}`, { pattern: `p${i}` }, "explore"),
      );
    }
    const deniedAgain = await expectToolDenial(() =>
      callBefore(
        h.hooks,
        event("grep", "explore", "search-13", { pattern: "p13" }, "explore"),
      ),
    );
    expect(deniedAgain.message).toContain("discovery_budget_exhausted");

    const secondExtend = await control(
      h.tools,
      { action: "extend_explore", session_id: "explore" },
      { sessionID: "root", agent: "build" },
    );
    expect(secondExtend.reason).toBe("already_extended");
  });

  test("namespaced local tools charge explore but never other agents", async () => {
    const h = await harness();

    // Fetch may run many non-retrieval local tool calls in this harness; they
    // are not a discovery assignment and must not create a counter.
    for (let i = 1; i <= 9; i += 1) {
      await callBefore(
        h.hooks,
        event(
          "mcp__sqz__sqz_grep",
          "child",
          `fetch-local-${i}`,
          { pattern: `p${i}` },
          "fetch",
        ),
      );
    }
    const fetchStatus = await control(
      h.tools,
      { action: "status" },
      { sessionID: "child", agent: "fetch" },
    );
    expect(fetchStatus.ok).toBe(true);
    expect(fetchStatus.report.discovery).toBeUndefined();

    await callBefore(
      h.hooks,
      event("mcp__semble__search", "explore", "semble-1", { query: "microphone" }, "explore"),
    );
    const exploreStatus = await control(
      h.tools,
      { action: "status", session_id: "explore" },
      { sessionID: "root", agent: "build" },
    );
    expect(exploreStatus.report.discovery).toMatchObject({
      limit: 8,
      used: 1,
      remaining: 7,
    });
  });

  test("restricts native websearch before execution and preserves Exa MCP", async () => {
    const env = { TINYFISH_API_KEY: "test-key", EXA_API_KEY: "exa-key" };
    const h = await harness({
      providers: ["exa", "tavily", "tinyfish"],
      defaultProvider: "exa",
      env,
    });
      const state = h.websearchState();
      expect(state.providers).toEqual(["exa", "tavily", "tinyfish"]);
      expect(state.default).toBe("tinyfish");
      expect(resolveNativeProvider(state)).toBe("tinyfish");
      expect(resolveNativeProvider({ ...state, storedKv: "exa" })).toBe("tinyfish");
      expect(resolveNativeProvider({ ...state, storedKv: "random" })).toBe("tinyfish");

      const native = event("websearch", "child", "native-1", { query: "x" }, "fetch");
      await callBefore(h.hooks, native);
      await callAfter(h.hooks, {
        ...native,
        status: "completed",
        result: { content: "ok", metadata: { provider: "tinyfish" } },
      });

      const status = await control(h.tools, { action: "status" }, {
        sessionID: "child",
        agent: "fetch",
      });
      const tinyfish = status.report.providers.find(
        (provider: any) => provider.provider === "tinyfish",
      );
      expect(tinyfish.rate_remaining.minute).toBe(29);

      // Separate Exa MCP semantic search remains governed by its own key/budget.
      await callBefore(
        h.hooks,
        event("exa_web_search_exa", "child", "exa-1", { query: "semantic" }, "fetch"),
      );

      const override = await expectToolDenial(() =>
        callBefore(
          h.hooks,
          event(
            "websearch",
            "child",
            "native-2",
            { query: "x", providerID: "exa" },
            "fetch",
          ),
        ),
      );
      expect(override.message).toContain("native_search_provider_override");

      const unavailable = await harness({
        providers: ["exa", "tavily"],
        defaultProvider: "exa",
        env,
      });
      const unavailableState = unavailable.websearchState();
      expect(unavailableState.providers).toEqual(["exa", "tavily"]);
      expect(unavailableState.default).toBe(false);
      expect(resolveNativeProvider(unavailableState)).toBe(false);
      expect(resolveNativeProvider({ ...unavailableState, storedKv: "exa" })).toBe(false);
      expect(resolveNativeProvider({ ...unavailableState, storedKv: "random" })).toBe(false);

      const denied = await expectToolDenial(() =>
        callBefore(
          unavailable.hooks,
          event("websearch", "child", "native-3", { query: "x" }, "fetch"),
        ),
      );
      expect(denied.message).toContain("native_search_provider_unavailable");

      const randomFallback = await harness({
        providers: ["exa", "tavily"],
        defaultProvider: "random",
        env,
      });
      const randomState = randomFallback.websearchState();
      expect(randomState.providers).toEqual(["exa", "tavily"]);
      expect(randomState.default).toBe(false);
      expect(resolveNativeProvider(randomState)).toBe(false);
      expect(resolveNativeProvider({ ...randomState, storedKv: "random" })).toBe(false);

    // Restricting the native catalog must not disable the Exa MCP tool.
    await callBefore(
      unavailable.hooks,
      event("exa_web_search_exa", "child", "exa-2", { query: "semantic" }, "fetch"),
    );
  });

  test("permits keyless native tinyfish under the same caps", async () => {
    const h = await harness({ providers: ["tinyfish"] });
      const native = event("websearch", "child", "keyless-1", { query: "x" }, "fetch");
      await callBefore(h.hooks, native);
      await callAfter(h.hooks, {
        ...native,
        status: "completed",
        result: { content: "ok", metadata: { provider: "tinyfish" } },
      });

      const status = await control(h.tools, { action: "status" }, {
        sessionID: "child",
        agent: "fetch",
      });
      const tinyfish = status.report.providers.find(
        (provider: any) => provider.provider === "tinyfish",
      );
    expect(tinyfish.available).toBe(true);
    expect(tinyfish.key_configured).toBe(false);
    expect(tinyfish.rate_remaining.minute).toBe(29);
  });

  test("does not retry native search anonymously after configured auth fails", async () => {
    const h = await harness({
      providers: ["tinyfish"],
      env: { TINYFISH_API_KEY: "configured-key" },
    });
      const native = event("websearch", "child", "auth-1", { query: "x" }, "fetch");
      await callBefore(h.hooks, native);
      await callAfter(h.hooks, {
        ...native,
        status: "error",
        error: new Tool.Error({
          message: "401 Unauthorized: invalid API key",
          metadata: { retry_after_ms: 60_000 },
        }),
      });

      const denied = await expectToolDenial(() =>
        callBefore(
          h.hooks,
          event("websearch", "child", "auth-2", { query: "next" }, "fetch"),
        ),
      );
    expect(denied.message).toContain("provider_operator_action_required");
  });

  test("rejects a native websearch error from a wrong provider as policy violation", async () => {
    const env = { TINYFISH_API_KEY: "test-key" };
    const shapes: Array<{ metadata?: Record<string, unknown>; cause?: unknown }> = [
        { metadata: { provider: "exa" } },
        { metadata: { providerID: "exa" } },
        { cause: { providerID: "exa" } },
      ];
      for (const [index, shape] of shapes.entries()) {
        const h = await harness({ providers: ["tinyfish"], env });
        const native = event(
          "websearch",
          "child",
          `err-wrong-${index}`,
          { query: "x" },
          "fetch",
        );
        await callBefore(h.hooks, native);
        await callAfter(h.hooks, {
          ...native,
          status: "error",
          error: new Tool.Error({
            message: "Web search rate limited (HTTP 429)",
            metadata: shape.metadata,
            error: shape.cause,
          } as any),
        });

        const status = await control(h.tools, { action: "status" }, {
          sessionID: "child",
          agent: "fetch",
        });
        const tinyfish = status.report.providers.find(
          (provider: any) => provider.provider === "tinyfish",
        );
        expect(tinyfish.reason).toBe("native_search_provider_unavailable");
        const persisted = JSON.parse(
          await readFile(path.join(h.dir, "state.json"), "utf8"),
        );
        expect(persisted.providers.tinyfish.cooldownUntil).toBeUndefined();
        expect(persisted.providers.tinyfish.requiresOperator ?? false).toBe(false);
        expect(persisted.providers.tinyfish.rate.minute.count).toBe(1);

        const denied = await expectToolDenial(() =>
          callBefore(
            h.hooks,
            event("websearch", "child", `err-wrong-next-${index}`, { query: "y" }, "fetch"),
          ),
        );
        expect(denied.message).toContain("native_search_provider_unavailable");
      }
  });

  test("rejects a native websearch result from the wrong provider", async () => {
    const h = await harness({
      providers: ["tinyfish"],
      env: { TINYFISH_API_KEY: "test-key" },
    });
      const native = event("websearch", "child", "wrong-1", { query: "x" }, "fetch");
      await callBefore(h.hooks, native);
      await callAfter(h.hooks, {
        ...native,
        status: "completed",
        result: { content: "ok", metadata: { provider: "exa" } },
      });

      const status = await control(h.tools, { action: "status" }, {
        sessionID: "child",
        agent: "fetch",
      });
      const tinyfish = status.report.providers.find(
        (provider: any) => provider.provider === "tinyfish",
      );
      expect(tinyfish.reason).toBe("native_search_provider_unavailable");
      expect(tinyfish.next_available).toBeUndefined();
      const persisted = JSON.parse(
        await readFile(path.join(h.dir, "state.json"), "utf8"),
      );
      expect(persisted.providers.tinyfish.cooldownUntil).toBeUndefined();
      expect(persisted.providers.tinyfish.requiresOperator ?? false).toBe(false);
      expect(persisted.providers.tinyfish.rate.minute.count).toBe(1);

      const denied = await expectToolDenial(() =>
        callBefore(
          h.hooks,
          event("websearch", "child", "wrong-2", { query: "next" }, "fetch"),
        ),
      );
    expect(denied.message).toContain("native_search_provider_unavailable");
  });
});
