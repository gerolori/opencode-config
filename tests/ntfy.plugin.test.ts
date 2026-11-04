import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NTFY_TOKEN_ENV, NTFY_URL_ENV, parseNtfyUrl, resolveNtfyConfig } from "../lib/ntfy/config";
import {
  createNtfyNotifier,
  parseNtfyEvent,
  type NtfyNotification,
} from "../lib/ntfy/notifier";
import { createFetchPublisher, type NtfyFetch } from "../lib/ntfy/publisher";
import {
  consumeNtfyStream,
  NTFY_EVENT_TYPES,
  pumpNtfyEvents,
  startNtfyNotifications,
  type NtfyPluginContext,
} from "../lib/ntfy/plugin";
import pluginModule, * as pluginNamespace from "../plugins/notification-ntfy";
import { buildServiceEnv, parseVaultYaml } from "../lib/secrets/vault";

const VALID_URL = "https://ntfy.example.com/secret-topic-abcdef";

function event(id: string, type: string, data: Record<string, unknown>): unknown {
  return { id, type, created: 1, data };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function collector() {
  const sent: NtfyNotification[] = [];
  const errors: unknown[] = [];
  const notifier = createNtfyNotifier({
    send: async (notification) => {
      sent.push(notification);
    },
    onError: (error) => errors.push(error),
  });
  return { notifier, sent, errors };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeFetchContext(
  events: readonly unknown[],
  sessions?: ReadonlyArray<{ readonly id: string; readonly parentID?: string }>,
  listGate?: Promise<void>,
) {
  const subscriptions: Array<{
    types: readonly string[];
    signal?: AbortSignal;
  }> = [];
  let listCalls = 0;

  const context: NtfyPluginContext = {
    event: {
      subscribe: (options) => {
        subscriptions.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            for (const item of events) {
              if (options.signal?.aborted) return;
              yield item;
            }
          },
        };
      },
    },
    session:
      sessions === undefined
        ? undefined
        : {
            list: async () => {
              listCalls += 1;
              if (listGate !== undefined) await listGate;
              return { data: sessions };
            },
          },
  };

  return { context, subscriptions, listCalls: () => listCalls };
}

/**
 * A stream that only captures events pushed after a subscriber attaches, so a
 * test can prove events emitted during the seed window are not dropped.
 */
function controllableContext(
  sessions?: ReadonlyArray<{ readonly id: string; readonly parentID?: string }>,
  listGate?: Promise<void>,
) {
  const queue: unknown[] = [];
  let attached = false;
  let closed = false;
  let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;

  const stream: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      attached = true;
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        return(): Promise<IteratorResult<unknown>> {
          closed = true;
          resolveNext?.({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  const subscriptions: Array<{ types: readonly string[]; signal?: AbortSignal }> = [];
  const context: NtfyPluginContext = {
    event: {
      subscribe: (options) => {
        subscriptions.push(options);
        options.signal?.addEventListener("abort", () => {
          closed = true;
          resolveNext?.({ value: undefined, done: true });
        });
        return stream;
      },
    },
    session:
      sessions === undefined
        ? undefined
        : {
            list: async () => {
              if (listGate !== undefined) await listGate;
              return { data: sessions };
            },
          },
  };

  return {
    context,
    subscriptions,
    push(event: unknown) {
      // Events pushed before a subscriber attaches are dropped, modelling a
      // live stream that does not replay history.
      if (!attached) return;
      if (resolveNext !== undefined) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ value: event, done: false });
        return;
      }
      queue.push(event);
    },
  };
}

describe("ntfy configuration", () => {
  test("an unset or empty URL disables notifications", () => {
    expect(resolveNtfyConfig({})).toEqual({ enabled: false, reason: "not-configured" });
    expect(resolveNtfyConfig({ [NTFY_URL_ENV]: "" })).toEqual({
      enabled: false,
      reason: "not-configured",
    });
    expect(resolveNtfyConfig({ [NTFY_URL_ENV]: "   " })).toEqual({
      enabled: false,
      reason: "not-configured",
    });
  });

  test("plain HTTP, non-URLs, credentials, and fragments are rejected", () => {
    for (const raw of [
      "http://ntfy.example.com/topic",
      "ftp://ntfy.example.com/topic",
      "not a url",
      "ntfy.example.com/topic",
      "https://user:pass@ntfy.example.com/topic",
      "https://ntfy.example.com/topic#frag",
      "https://ntfy.example.com/topic\u0001",
    ]) {
      expect(parseNtfyUrl(raw)).toBeUndefined();
      expect(resolveNtfyConfig({ [NTFY_URL_ENV]: raw })).toEqual({
        enabled: false,
        reason: "invalid-url",
      });
    }
  });

  test("a valid HTTPS URL is accepted with an optional token", () => {
    expect(resolveNtfyConfig({ [NTFY_URL_ENV]: VALID_URL })).toEqual({
      enabled: true,
      config: { url: VALID_URL, token: undefined },
    });
    expect(
      resolveNtfyConfig({ [NTFY_URL_ENV]: VALID_URL, [NTFY_TOKEN_ENV]: "tk_secret" }),
    ).toEqual({
      enabled: true,
      config: { url: VALID_URL, token: "tk_secret" },
    });
  });

  test("an invalid URL is never echoed in the disabled result", () => {
    const sentinel = "SENTINEL_TOPIC_VALUE";
    const result = resolveNtfyConfig({ [NTFY_URL_ENV]: `http://${sentinel}.example.com/x` });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("a missing token is allowed for an intentionally public topic", () => {
    // No token key at all: enabled, unauthenticated.
    expect(resolveNtfyConfig({ [NTFY_URL_ENV]: VALID_URL })).toEqual({
      enabled: true,
      config: { url: VALID_URL, token: undefined },
    });
  });

  test("a whitespace-only or empty token fails closed", () => {
    for (const raw of ["", "   ", "\t", "\r\n", " \t "]) {
      expect(resolveNtfyConfig({ [NTFY_URL_ENV]: VALID_URL, [NTFY_TOKEN_ENV]: raw })).toEqual({
        enabled: false,
        reason: "invalid-token",
      });
    }
  });

  test("a token with leading or trailing whitespace is rejected, not trimmed", () => {
    for (const raw of [" abc", "abc ", " abc ", "  abc  ", "\nabc"]) {
      expect(resolveNtfyConfig({ [NTFY_URL_ENV]: VALID_URL, [NTFY_TOKEN_ENV]: raw })).toEqual({
        enabled: false,
        reason: "invalid-token",
      });
    }
    // The exact token is forwarded unchanged when it is well formed.
    expect(
      resolveNtfyConfig({ [NTFY_URL_ENV]: VALID_URL, [NTFY_TOKEN_ENV]: "abc" }),
    ).toEqual({ enabled: true, config: { url: VALID_URL, token: "abc" } });
  });

  test("a token with CR, LF, TAB, or other control characters fails closed", () => {
    for (const raw of [
      "abc\ndef",
      "abc\rdef",
      "abc\tdef",
      "abc\u0000def",
      "abc\u0001def",
      "abc\u007fdef",
      "abc\r\n",
    ]) {
      expect(resolveNtfyConfig({ [NTFY_URL_ENV]: VALID_URL, [NTFY_TOKEN_ENV]: raw })).toEqual({
        enabled: false,
        reason: "invalid-token",
      });
    }

    const sentinel = "SENTINEL_TOKEN_VALUE";
    const result = resolveNtfyConfig({
      [NTFY_URL_ENV]: VALID_URL,
      [NTFY_TOKEN_ENV]: `${sentinel}\nmore`,
    });
    expect(result).toEqual({ enabled: false, reason: "invalid-token" });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("the vault parser still decodes escaped control characters; the resolver fails closed", () => {
    // The vault parser's own rules are unchanged: a double-quoted `\n` decodes.
    const secrets = parseVaultYaml(
      ['NTFY_URL: "https://ntfy.example.com/topic"', 'NTFY_TOKEN: "line1\\nline2"'].join("\n"),
    );
    expect(secrets.NTFY_TOKEN).toBe("line1\nline2");

    // The ntfy resolver is stricter than the generic vault scalar rule and
    // disables the config rather than sending an unauthenticated request.
    expect(resolveNtfyConfig(secrets)).toEqual({ enabled: false, reason: "invalid-token" });
  });

  test("a whitespace-only token from the vault also fails closed", () => {
    const secrets = parseVaultYaml(
      ['NTFY_URL: "https://ntfy.example.com/topic"', 'NTFY_TOKEN: "   "'].join("\n"),
    );
    expect(secrets.NTFY_TOKEN).toBe("   ");
    expect(resolveNtfyConfig(secrets)).toEqual({ enabled: false, reason: "invalid-token" });
  });
});

describe("ntfy event parsing", () => {
  test("recognizes the subscribed event shapes", () => {
    expect(parseNtfyEvent(event("e1", "session.created", { sessionID: "s1", parentID: "p1" }))).toEqual(
      { kind: "created", id: "e1", sessionID: "s1", parentID: "p1" },
    );
    expect(parseNtfyEvent(event("e2", "session.idle", { sessionID: "s1" }))).toEqual({
      kind: "idle",
      id: "e2",
      sessionID: "s1",
    });
    expect(parseNtfyEvent(event("e3", "permission.asked", { sessionID: "s1", action: "shell" }))).toEqual({
      kind: "permission",
      id: "e3",
      sessionID: "s1",
    });
    expect(
      parseNtfyEvent(
        event("e4", "session.execution.failed", {
          sessionID: "s1",
          error: { type: "provider", message: "SHOULD_NOT_BE_READ" },
        }),
      ),
    ).toEqual({ kind: "error", id: "e4", sessionID: "s1" });
  });

  test("rejects malformed and unsubscribed events", () => {
    expect(parseNtfyEvent(null)).toBeUndefined();
    expect(parseNtfyEvent("text")).toBeUndefined();
    expect(parseNtfyEvent({})).toBeUndefined();
    expect(parseNtfyEvent({ id: "x", type: "session.idle" })).toBeUndefined();
    expect(parseNtfyEvent({ id: "x", type: "session.idle", data: {} })).toBeUndefined();
    expect(parseNtfyEvent({ type: "session.idle", data: { sessionID: "s" } })).toBeUndefined();
    expect(parseNtfyEvent(event("x", "session.deleted", { sessionID: "s" }))).toBeUndefined();
    // Sibling execution events are not subscribed to.
    expect(parseNtfyEvent(event("x", "session.execution.succeeded", { sessionID: "s" }))).toBeUndefined();
    expect(
      parseNtfyEvent(event("x", "session.execution.interrupted", { sessionID: "s", reason: "user" })),
    ).toBeUndefined();
    expect(parseNtfyEvent(event("x", "session.step.failed", { sessionID: "s" }))).toBeUndefined();
    expect(parseNtfyEvent(event("x", "session.retry.scheduled", { sessionID: "s" }))).toBeUndefined();
  });

  test("the error payload is never carried into the parsed event", () => {
    const sentinel = "SENTINEL_PROVIDER_ERROR_BODY";
    const parsed = parseNtfyEvent(
      event("e1", "session.execution.failed", {
        sessionID: "s1",
        error: { type: "provider", message: sentinel, response: { body: sentinel } },
      }),
    );
    expect(JSON.stringify(parsed)).not.toContain(sentinel);
  });
});

describe("ntfy notifier", () => {
  test("notifies on a root session idle", async () => {
    const { notifier, sent } = collector();
    notifier.handle(event("e1", "session.idle", { sessionID: "root" }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      title: "OpenCode",
      message: "Session idle",
      priority: "default",
      tags: ["white_check_mark"],
    });
  });

  test("suppresses idle, error, and permission events from child sessions", async () => {
    const { notifier, sent } = collector();
    notifier.handle(event("c1", "session.created", { sessionID: "child", parentID: "root" }));
    notifier.handle(event("i1", "session.idle", { sessionID: "child" }));
    notifier.handle(event("x1", "session.execution.failed", { sessionID: "child", error: { message: "boom" } }));
    notifier.handle(event("p1", "permission.asked", { sessionID: "child", action: "shell" }));
    await flush();
    expect(sent).toHaveLength(0);
  });

  test("notifies on a root execution failure with generic text", async () => {
    const { notifier, sent } = collector();
    notifier.handle(
      event("x1", "session.execution.failed", {
        sessionID: "root",
        error: { type: "provider", message: "SENTINEL_PROVIDER_ERROR" },
      }),
    );
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      title: "OpenCode",
      message: "Session error",
      priority: "high",
      tags: ["rotating_light"],
    });
    expect(JSON.stringify(sent[0])).not.toContain("SENTINEL_PROVIDER_ERROR");
  });

  test("notifies on a root permission ask with fixed generic text", async () => {
    const { notifier, sent } = collector();
    const secretAction = "SENTINEL_ACTION_dangerous_command <x>";
    notifier.handle(event("p1", "permission.asked", { sessionID: "root", action: secretAction }));
    notifier.handle(event("p2", "permission.asked", { sessionID: "root" }));
    await flush();
    expect(sent).toHaveLength(2);
    for (const notification of sent) {
      expect(notification).toEqual({
        title: "OpenCode",
        message: "Permission needed",
        priority: "high",
        tags: ["warning"],
      });
    }
    // The arbitrary action label is never read or echoed.
    expect(JSON.stringify(sent)).not.toContain("SENTINEL_ACTION");
    expect(JSON.stringify(sent)).not.toContain("dangerous");
  });

  test("deduplicates the same event id", async () => {
    const { notifier, sent } = collector();
    const duplicated = event("same", "session.idle", { sessionID: "root" });
    notifier.handle(duplicated);
    notifier.handle(duplicated);
    await flush();
    expect(sent).toHaveLength(1);
  });

  test("seedChildren suppresses sessions known before a reload", async () => {
    const { notifier, sent } = collector();
    notifier.seedChildren(["child-a", "child-b"]);
    notifier.handle(event("i1", "session.idle", { sessionID: "child-a" }));
    notifier.handle(event("x1", "session.execution.failed", { sessionID: "child-a", error: {} }));
    notifier.handle(event("p1", "permission.asked", { sessionID: "child-b", action: "edit" }));
    await flush();
    expect(sent).toHaveLength(0);
  });

  test("the child set is bounded; the oldest entries evict first", async () => {
    const sent: NtfyNotification[] = [];
    const notifier = createNtfyNotifier({
      send: async (notification) => {
        sent.push(notification);
      },
      maxTracked: 2,
    });
    notifier.seedChildren(["child-1", "child-2", "child-3"]);

    // child-3 and child-2 remain tracked.
    notifier.handle(event("i3", "session.idle", { sessionID: "child-3" }));
    notifier.handle(event("i2", "session.idle", { sessionID: "child-2" }));
    // child-1 was evicted, so it is no longer suppressed.
    notifier.handle(event("i1", "session.idle", { sessionID: "child-1" }));
    await flush();

    expect(sent).toHaveLength(1);
  });

  test("a publish failure is routed to onError and never thrown", async () => {
    const errors: unknown[] = [];
    const notifier = createNtfyNotifier({
      send: async () => {
        throw new Error("network down");
      },
      onError: (error) => errors.push(error),
    });
    expect(() => notifier.handle(event("e1", "session.idle", { sessionID: "root" }))).not.toThrow();
    await flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("network down");
  });

  test("a throwing onError sink cannot escape as an unhandled rejection", async () => {
    const notifier = createNtfyNotifier({
      send: async () => {
        throw new Error("send failed");
      },
      onError: () => {
        throw new Error("sink failed");
      },
    });
    expect(() => notifier.handle(event("e1", "session.idle", { sessionID: "root" }))).not.toThrow();
    await flush();
    // Still usable after the sink threw.
    expect(() => notifier.handle(event("e2", "session.idle", { sessionID: "root" }))).not.toThrow();
    await flush();
  });
});

describe("ntfy publisher", () => {
  test("posts the message body with metadata headers and a bearer token", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const fetchImpl: NtfyFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    };
    const publish = createFetchPublisher(fetchImpl);
    await publish({
      url: VALID_URL,
      token: "tk_secret",
      title: "OpenCode",
      message: "Session idle",
      priority: "default",
      tags: ["white_check_mark"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(VALID_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("Session idle");
    expect(calls[0]!.init.headers).toEqual({
      Title: "OpenCode",
      Priority: "default",
      Tags: "white_check_mark",
      Authorization: "Bearer tk_secret",
    });
  });

  test("omits authorization when no token is configured", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl: NtfyFetch = async (_url, init) => {
      calls.push(init.headers);
      return { ok: true };
    };
    await createFetchPublisher(fetchImpl)({
      url: VALID_URL,
      title: "OpenCode",
      message: "Session idle",
      priority: "high",
      tags: ["warning"],
    });
    expect(calls[0]!.Authorization).toBeUndefined();
  });

  test("rejects a non-ok response generically without the URL", async () => {
    const fetchImpl: NtfyFetch = async () => ({ ok: false });
    let message = "";
    try {
      await createFetchPublisher(fetchImpl)({
        url: VALID_URL,
        title: "OpenCode",
        message: "Session idle",
        priority: "default",
        tags: [],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("ntfy publish was rejected");
    expect(message).not.toContain("ntfy.example.com");
    expect(message).not.toContain("secret-topic");
  });

  test("sanitizes a transport failure into a generic URL-free error", async () => {
    const request = {
      url: VALID_URL,
      title: "OpenCode",
      message: "Session idle",
      priority: "default" as const,
      tags: [],
    };

    const network: NtfyFetch = async () => {
      throw new Error("ECONNREFUSED https://ntfy.example.com/secret-topic-abcdef");
    };
    let message = "";
    try {
      await createFetchPublisher(network)(request);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("ntfy publish failed");
    expect(message).not.toContain("ntfy.example.com");
    expect(message).not.toContain("secret-topic");
    expect(message).not.toContain("ECONNREFUSED");

    // A timeout/abort rejection is sanitized the same way.
    const aborted: NtfyFetch = async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    await expect(createFetchPublisher(aborted)(request)).rejects.toThrow("ntfy publish failed");
  });

  test("a lifecycle abort aborts a bounded in-flight publish", async () => {
    const lifecycle = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const fetchImpl: NtfyFetch = (_url, init) => {
      seenSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const publish = createFetchPublisher(fetchImpl, { signal: lifecycle.signal });
    const pending = publish({
      url: VALID_URL,
      title: "OpenCode",
      message: "Session idle",
      priority: "default",
      tags: [],
    });
    lifecycle.abort();
    await expect(pending).rejects.toThrow("ntfy publish failed");
    expect(seenSignal?.aborted).toBe(true);
  });

  test("an already-aborted lifecycle signal rejects without a request", async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    let called = false;
    const fetchImpl: NtfyFetch = async () => {
      called = true;
      return { ok: true };
    };
    await expect(
      createFetchPublisher(fetchImpl, { signal: lifecycle.signal })({
        url: VALID_URL,
        title: "OpenCode",
        message: "Session idle",
        priority: "default",
        tags: [],
      }),
    ).rejects.toThrow("ntfy publish failed");
    expect(called).toBe(false);
  });
});

describe("ntfy plugin wiring", () => {
  const fetchImpl: NtfyFetch = async () => ({ ok: true });

  test("stays disabled with no URL: no subscription and no network", async () => {
    const { context, subscriptions } = fakeFetchContext([]);
    const cleanup = await startNtfyNotifications(context, { env: {}, fetch: fetchImpl });
    expect(cleanup).toBeUndefined();
    expect(subscriptions).toHaveLength(0);
  });

  test("a synchronous subscribe throw is nonfatal and disables the plugin", async () => {
    const errors: unknown[] = [];
    const context: NtfyPluginContext = {
      event: {
        subscribe: () => {
          throw new Error("subscribe failed");
        },
      },
    };
    const cleanup = await startNtfyNotifications(context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
      onError: (error) => errors.push(error),
    });
    expect(cleanup).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("subscribe failed");

    // The claimed slot was released, so a later start can still work.
    const later = fakeFetchContext([]);
    const laterCleanup = await startNtfyNotifications(later.context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    expect(typeof laterCleanup).toBe("function");
    expect(later.subscriptions).toHaveLength(1);
    laterCleanup?.();
  });

  test("falls back to the global fetch when no override is provided", async () => {
    const { context, subscriptions } = fakeFetchContext([]);
    const cleanup = await startNtfyNotifications(context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
    });
    // Bun/Node expose a global fetch, so the plugin activates. The fake stream
    // has no events, so no network call is made.
    expect(typeof cleanup).toBe("function");
    expect(subscriptions).toHaveLength(1);
    cleanup?.();
  });

  test("subscribes once with the documented types and aborts on cleanup", async () => {
    const { context, subscriptions } = fakeFetchContext([]);
    const cleanup = await startNtfyNotifications(context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    expect(typeof cleanup).toBe("function");
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.types).toEqual([...NTFY_EVENT_TYPES]);
    expect(subscriptions[0]!.signal?.aborted).toBe(false);
    cleanup?.();
    expect(subscriptions[0]!.signal?.aborted).toBe(true);
  });

  test("seeds child sessions from the session list", async () => {
    const { context, listCalls } = fakeFetchContext([], [
      { id: "root-a" },
      { id: "child-a", parentID: "root-a" },
    ]);
    const cleanup = await startNtfyNotifications(context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    expect(listCalls()).toBe(1);
    cleanup?.();
  });

  test("end to end: idle, error, and permission reach the endpoint; children do not", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const recorder: NtfyFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    };
    const events = [
      event("c1", "session.created", { sessionID: "child", parentID: "root" }),
      event("i-child", "session.idle", { sessionID: "child" }),
      event("i-root", "session.idle", { sessionID: "root" }),
      event("x-root", "session.execution.failed", {
        sessionID: "root",
        error: { message: "SENTINEL_ERROR" },
      }),
      event("p-root", "permission.asked", { sessionID: "root", action: "SENTINEL_ACTION_shell" }),
    ];
    const { context } = fakeFetchContext(events);
    const cleanup = await startNtfyNotifications(context, {
      env: { [NTFY_URL_ENV]: VALID_URL, [NTFY_TOKEN_ENV]: "tk_secret" },
      fetch: recorder,
    });
    await flush();
    cleanup?.();

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.init.body)).toEqual([
      "Session idle",
      "Session error",
      "Permission needed",
    ]);
    for (const call of calls) expect(call.url).toBe(VALID_URL);
    expect(JSON.stringify(calls)).not.toContain("SENTINEL_ERROR");
    expect(JSON.stringify(calls)).not.toContain("SENTINEL_ACTION");
    expect(calls[0]!.init.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer tk_secret" }),
    );
  });

  test("a second setup aborts the first subscription", async () => {
    const first = fakeFetchContext([]);
    const second = fakeFetchContext([]);
    const cleanupFirst = await startNtfyNotifications(first.context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    const cleanupSecond = await startNtfyNotifications(second.context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    expect(first.subscriptions[0]!.signal?.aborted).toBe(true);
    expect(second.subscriptions[0]!.signal?.aborted).toBe(false);
    cleanupSecond?.();
    cleanupFirst?.();
  });

  test("a disabled re-setup aborts the prior subscription", async () => {
    const first = fakeFetchContext([]);
    const cleanupFirst = await startNtfyNotifications(first.context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    expect(first.subscriptions[0]!.signal?.aborted).toBe(false);

    const disabled = await startNtfyNotifications(fakeFetchContext([]).context, {
      env: {},
      fetch: fetchImpl,
    });
    expect(disabled).toBeUndefined();
    expect(first.subscriptions[0]!.signal?.aborted).toBe(true);
    cleanupFirst?.();
  });

  test("events during the seed are buffered, not dropped, and child suppression holds", async () => {
    const gate = deferred<void>();
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const recorder: NtfyFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true };
    };
    const { context, subscriptions, push } = controllableContext(
      [{ id: "child", parentID: "root" }],
      gate.promise,
    );

    const starting = startNtfyNotifications(context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: recorder,
      seedTimeoutMs: 1000,
    });

    // Subscribe happens synchronously before the seed await.
    expect(subscriptions).toHaveLength(1);

    // These arrive while the seed is still pending; a pre-subscription design
    // would have dropped them.
    push(event("c1", "session.created", { sessionID: "child", parentID: "root" }));
    push(event("i-child", "session.idle", { sessionID: "child" }));
    push(event("i-root", "session.idle", { sessionID: "root" }));

    gate.resolve();
    const cleanup = await starting;
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).toBe("Session idle");
    cleanup?.();
  });

  test("overlapping starts leave only the newest subscription live", async () => {
    // Both starts are held inside the async child seed. Because subscribe now
    // happens before the seed, the superseded call may have subscribed, but its
    // signal is aborted before the newer call subscribes, so only one stream is
    // ever live.
    const gate = deferred<void>();
    const first = fakeFetchContext([], [{ id: "child", parentID: "root" }], gate.promise);
    const second = fakeFetchContext([], [{ id: "child", parentID: "root" }], gate.promise);

    const startingFirst = startNtfyNotifications(first.context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    const startingSecond = startNtfyNotifications(second.context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
    });
    gate.resolve();

    const [cleanupFirst, cleanupSecond] = await Promise.all([startingFirst, startingSecond]);

    expect(first.subscriptions).toHaveLength(1);
    expect(first.subscriptions[0]!.signal?.aborted).toBe(true);
    expect(second.subscriptions).toHaveLength(1);
    expect(second.subscriptions[0]!.signal?.aborted).toBe(false);
    expect(cleanupFirst).toBeUndefined();
    expect(typeof cleanupSecond).toBe("function");
    cleanupSecond?.();
  });

  test("a hung child seed is bounded and the plugin still subscribes", async () => {
    const never = deferred<void>();
    const { context, subscriptions } = fakeFetchContext(
      [],
      [{ id: "child", parentID: "root" }],
      never.promise,
    );
    const cleanup = await startNtfyNotifications(context, {
      env: { [NTFY_URL_ENV]: VALID_URL },
      fetch: fetchImpl,
      seedTimeoutMs: 20,
    });
    expect(typeof cleanup).toBe("function");
    expect(subscriptions).toHaveLength(1);
    cleanup?.();
  });

  test("consumeNtfyStream forwards events and swallows per-event and stream errors", async () => {
    const handled: unknown[] = [];
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { id: "1" };
        yield { id: "2" };
      },
    };
    await consumeNtfyStream(stream, (value) => handled.push(value));
    expect(handled).toHaveLength(2);

    const errors: unknown[] = [];
    const one = {
      async *[Symbol.asyncIterator]() {
        yield { id: "1" };
      },
    };
    await consumeNtfyStream(
      one,
      () => {
        throw new Error("handler failed");
      },
      (error) => errors.push(error),
    );
    expect(errors).toHaveLength(1);

    const broken = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("stream failed");
          },
        };
      },
    };
    const streamErrors: unknown[] = [];
    await consumeNtfyStream(broken, () => {}, (error) => streamErrors.push(error));
    expect(streamErrors).toHaveLength(1);
  });

  test("a throwing onError sink cannot reject the stream consumer", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { id: "1" };
      },
    };
    await expect(
      consumeNtfyStream(
        stream,
        () => {
          throw new Error("handler failed");
        },
        () => {
          throw new Error("sink failed");
        },
      ),
    ).resolves.toBeUndefined();

    const broken = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("stream failed");
          },
        };
      },
    };
    await expect(
      consumeNtfyStream(broken, () => {}, () => {
        throw new Error("sink failed");
      }),
    ).resolves.toBeUndefined();
  });

  test("the pump buffers until release and preserves order", async () => {
    const handled: unknown[] = [];
    const notifier = {
      handle: (value: unknown) => {
        handled.push(value);
      },
      seedChildren: () => {},
    };
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { id: "1" };
        yield { id: "2" };
      },
    };
    const pump = pumpNtfyEvents(stream, notifier);
    await flush();
    expect(handled).toHaveLength(0);
    pump.release();
    expect(handled).toEqual([{ id: "1" }, { id: "2" }]);
    await pump.done;
  });

  test("the pump flushes early when its buffer overflows", async () => {
    const handled: unknown[] = [];
    const notifier = {
      handle: (value: unknown) => {
        handled.push(value);
      },
      seedChildren: () => {},
    };
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { id: "1" };
        yield { id: "2" };
        yield { id: "3" };
      },
    };
    const pump = pumpNtfyEvents(stream, notifier, undefined, 2);
    await pump.done;
    expect(pump.overflowed).toBe(true);
    expect(handled).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });
});

describe("ntfy secret allowlist", () => {
  test("the vault accepts NTFY_URL and NTFY_TOKEN", () => {
    const secrets = parseVaultYaml(
      [`NTFY_URL: "${VALID_URL}"`, 'NTFY_TOKEN: "tk_secret"', "EXA_API_KEY: exa"].join("\n"),
    );
    expect(secrets.NTFY_URL).toBe(VALID_URL);
    expect(secrets.NTFY_TOKEN).toBe("tk_secret");
  });

  test("the service environment forwards present ntfy values and scrubs stale ones", () => {
    const withValues = buildServiceEnv(
      { [NTFY_URL_ENV]: "stale", [NTFY_TOKEN_ENV]: "stale" },
      { [NTFY_URL_ENV]: VALID_URL, [NTFY_TOKEN_ENV]: "fresh" },
    );
    expect(withValues.NTFY_URL).toBe(VALID_URL);
    expect(withValues.NTFY_TOKEN).toBe("fresh");

    const withoutValues = buildServiceEnv(
      { [NTFY_URL_ENV]: "stale", [NTFY_TOKEN_ENV]: "stale" },
      {},
    );
    expect(withoutValues.NTFY_URL).toBeUndefined();
    expect(withoutValues.NTFY_TOKEN).toBeUndefined();
  });

  test("vault values feed the resolver end to end", () => {
    const secrets = parseVaultYaml(
      [`NTFY_URL: "${VALID_URL}"`, 'NTFY_TOKEN: "tk_secret"'].join("\n"),
    );
    expect(resolveNtfyConfig(secrets)).toEqual({
      enabled: true,
      config: { url: VALID_URL, token: "tk_secret" },
    });
  });
});

describe("ntfy source hygiene", () => {
  const root = join(import.meta.dir, "..");
  const sources = [
    "lib/ntfy/config.ts",
    "lib/ntfy/publisher.ts",
    "lib/ntfy/notifier.ts",
    "lib/ntfy/plugin.ts",
    "plugins/notification-ntfy.ts",
  ];

  for (const file of sources) {
    test(`${file} never logs to the console`, () => {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/console\.(log|error|warn|info|debug|trace)/);
    });
  }
});

describe("notification-ntfy entrypoint", () => {
  test("exports exactly one Plugin.define entrypoint", () => {
    expect(Object.keys(pluginNamespace).sort()).toEqual(["default"]);
    expect(pluginModule.id).toBe("notification-ntfy");
    expect(typeof pluginModule.setup).toBe("function");
  });
});

