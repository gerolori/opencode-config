import { Plugin } from "@opencode/plugin";
import { Tool } from "@opencode/schema/tool";
import { DiscoveryBudget } from "../lib/discovery";
import { registerHostConfig } from "../lib/host-config";
import {
  categorizeError,
  InvocationIdentity,
  RetrievalEngine,
  type ControlCaller,
  type ControlResult,
  type PolicyDecision,
  type SessionInfo,
} from "../lib/retrieval";

const PLUGIN_ID = "retrieval-policy";

const controlInput = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["status", "extend", "extend_explore", "reset_provider"],
    },
    session_id: { type: "string" },
    extra_calls: { type: "integer", minimum: 1, maximum: 32 },
    provider: {
      type: "string",
      enum: [
        "duckduckgo",
        "tinyfish",
        "exa",
        "gh_grep",
        "context7",
        "builtin_webfetch",
        "semble",
        "ebay",
      ],
    },
  },
} as const;

type ControlInput = {
  action: "status" | "extend" | "extend_explore" | "reset_provider";
  session_id?: string;
  extra_calls?: number;
  provider?: string;
};

type RegistrationLike = { dispose(): Promise<void> };

function formatDecision(decision: PolicyDecision): string {
  const parts = [`retrieval-policy: ${decision.reason}`];
  if (decision.message) parts.push(decision.message);
  if (decision.allowedNextProviders && decision.allowedNextProviders.length > 0) {
    parts.push(`allowed next providers: ${decision.allowedNextProviders.join(", ")}`);
  }
  return parts.join(" — ");
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function afterMetadata(event: any): Record<string, unknown> {
  if (event.status === "error") {
    const metadata = asRecord(event.error?.metadata) ?? {};
    const cause = asRecord(event.error?.error);
    const provider =
      typeof metadata.provider === "string"
        ? metadata.provider
        : typeof metadata.providerID === "string"
          ? metadata.providerID
          : typeof cause?.providerID === "string"
            ? cause.providerID
            : typeof cause?.provider === "string"
              ? cause.provider
              : undefined;
    if (event.tool === "websearch" && provider !== undefined && provider !== "tinyfish") {
      return {
        retrieval_outcome: "unavailable",
        code: "native_search_provider_mismatch",
      };
    }
    return {
      ...metadata,
      isError: true,
      error: typeof event.error?.message === "string" ? event.error.message : "tool error",
    };
  }

  const metadata = asRecord(event.result?.metadata) ?? {};
  if (event.tool === "websearch") {
    const output = asRecord(event.result?.output);
    const provider =
      typeof metadata.provider === "string"
        ? metadata.provider
        : typeof output?.provider === "string"
          ? output.provider
          : undefined;
    if (provider !== "tinyfish") {
      return {
        retrieval_outcome: "unavailable",
        code: "native_search_provider_mismatch",
      };
    }
  }
  return metadata;
}

export const RetrievalPolicyPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(context) {
    const stateDir =
      typeof context.options?.stateDir === "string" ? context.options.stateDir : undefined;
    const options = asRecord(context.options);
    // Tests and embedded hosts may inject a hermetic environment. Production
    // falls back to the service process environment.
    const env = asRecord(options?.env) ?? process.env;

    const engine = new RetrievalEngine({
      stateDir,
      env: env as Record<string, string | undefined>,
      nativeSearchAvailable: false,
      sessionLookup: {
        async get(sessionID: string): Promise<SessionInfo | undefined> {
          const info = await context.session.get({ sessionID: sessionID as any });
          return {
            id: info.id,
            parentID: info.parentID,
            agent: info.agent,
          };
        },
      },
    });
    await engine.init();
    const discovery = new DiscoveryBudget();

    const registrations: RegistrationLike[] = [];
    const invocations = new InvocationIdentity();
    type ActiveSource = { count: number; until: number };
    const activeExecutes = new Map<string, ActiveSource>();
    const activeWebfetch = new Map<string, ActiveSource>();
    const sourceTTL = 30 * 60_000;
    const sourceKey = (sessionID: string, messageID: string, id: string) =>
      `${sessionID}:${messageID}:${id}`;
    const pruneSources = (sources: Map<string, ActiveSource>, now: number) => {
      for (const [key, entry] of sources) {
        if (entry.until <= now) sources.delete(key);
      }
      while (sources.size > 1_000) {
        const oldest = sources.keys().next().value;
        if (typeof oldest !== "string") break;
        sources.delete(oldest);
      }
    };
    const trackSource = (sources: Map<string, ActiveSource>, event: any) => {
      const now = Date.now();
      pruneSources(sources, now);
      const key = sourceKey(event.sessionID, event.messageID, String(event.id));
      const existing = sources.get(key);
      sources.set(key, { count: (existing?.count ?? 0) + 1, until: now + sourceTTL });
    };
    const untrackSource = (sources: Map<string, ActiveSource>, event: any) => {
      const key = sourceKey(event.sessionID, event.messageID, String(event.id));
      const existing = sources.get(key);
      if (!existing) return;
      if (existing.count <= 1) sources.delete(key);
      else sources.set(key, { ...existing, count: existing.count - 1 });
    };
    const hasSource = (
      sources: Map<string, ActiveSource>,
      sessionID: string,
      source: any,
    ) => {
      if (!source || source.type !== "tool") return false;
      if (typeof source.messageID !== "string" || typeof source.id !== "string") return false;
      pruneSources(sources, Date.now());
      return sources.has(sourceKey(sessionID, source.messageID, source.id));
    };
    const cleanupOuter = (event: any) => {
      const sessionID = event.sessionID;
      const outerID = String(event.id);
      const tokens = invocations.abandonOuter(sessionID, outerID);
      for (const token of tokens) engine.abandonCall(sessionID, token);
    };
    const trackOuter = (event: any) => {
      pruneSources(activeExecutes, Date.now());
      const key = sourceKey(event.sessionID, event.messageID, String(event.id));
      if (!activeExecutes.has(key)) cleanupOuter(event);
      trackSource(activeExecutes, event);
    };
    const untrackOuter = (event: any) => {
      const key = sourceKey(event.sessionID, event.messageID, String(event.id));
      const existing = activeExecutes.get(key);
      if (!existing) {
        cleanupOuter(event);
        return;
      }
      if (existing.count <= 1) {
        activeExecutes.delete(key);
        cleanupOuter(event);
      } else {
        activeExecutes.set(key, { ...existing, count: existing.count - 1 });
      }
    };
    const isOuterSource = (sessionID: string, source: any) =>
      hasSource(activeExecutes, sessionID, source);
    const trackWebfetch = (event: any) => trackSource(activeWebfetch, event);
    const untrackWebfetch = (event: any) => untrackSource(activeWebfetch, event);
    const isWebfetchSource = (sessionID: string, source: any) =>
      hasSource(activeWebfetch, sessionID, source);

    type PermissionSourceState = { effect: "allow" | "ask" | "deny"; until: number };
    const permissionSources = new Map<string, PermissionSourceState>();
    const permissionRequests = new Map<
      string,
      {
        key: string;
        sessionID: string;
        messageID: string;
        id: string;
        action: string;
        token?: string;
        fingerprint?: string;
        until: number;
      }
    >();
    const rejectedInvocations = new Map<string, number>();
    const permissionKey = (
      sessionID: string,
      messageID: unknown,
      id: unknown,
      action: unknown,
    ) => {
      if (typeof messageID !== "string" || typeof id !== "string" || typeof action !== "string") {
        return undefined;
      }
      return `${sourceKey(sessionID, messageID, id)}|${action}`;
    };
    const eventPermissionKey = (event: any) =>
      permissionKey(event.sessionID, event.messageID, String(event.id), event.tool);
    const sourcePermissionKey = (sessionID: string, source: any, action: unknown) =>
      source && source.type === "tool"
        ? permissionKey(sessionID, source.messageID, source.id, action)
        : undefined;
    const permissionInput = (data: Record<string, any>): unknown => {
      const metadata = asRecord(data.metadata);
      if (!metadata) return undefined;
      // MCP tools publish { input }; built-in webfetch/websearch publish their
      // input directly; read_mcp_resource publishes { server, uri } (its input).
      if ("input" in metadata) return metadata.input;
      return metadata;
    };
    const prunePermissionMaps = (now: number) => {
      for (const [key, entry] of permissionSources) {
        if (entry.until <= now) permissionSources.delete(key);
      }
      for (const [key, until] of rejectedInvocations) {
        if (until <= now) rejectedInvocations.delete(key);
      }
      for (const [requestID, entry] of permissionRequests) {
        if (entry.until <= now) permissionRequests.delete(requestID);
      }
      while (permissionSources.size > 1_000) {
        const oldest = permissionSources.keys().next().value;
        if (typeof oldest !== "string") break;
        permissionSources.delete(oldest);
      }
      while (rejectedInvocations.size > 1_000) {
        const oldest = rejectedInvocations.keys().next().value;
        if (typeof oldest !== "string") break;
        rejectedInvocations.delete(oldest);
      }
    };
    const rememberPermission = (
      key: string,
      effect: PermissionSourceState["effect"],
      now: number,
    ) => {
      prunePermissionMaps(now);
      permissionSources.set(key, { effect, until: now + sourceTTL });
    };
    const rememberPermissionReject = (fingerprint: string, now: number) => {
      prunePermissionMaps(now);
      rejectedInvocations.set(fingerprint, now + sourceTTL);
    };
    const permissionTag =
      /permission[.\s:_-]*(denied|blocked|declined|corrected)|permission denied|user rejected|rejected fetching|declinederror|blockederror|correctederror/i;
    const localPermissionFailure = (
      event: any,
      key: string | undefined,
      fingerprint: string,
    ) => {
      if (event.status !== "error") return false;
      const now = Date.now();
      prunePermissionMaps(now);
      const rejected = rejectedInvocations.get(fingerprint);
      if (rejected !== undefined && rejected > now) {
        rejectedInvocations.delete(fingerprint);
        return true;
      }
      const metadata = asRecord(event.error?.metadata) ?? {};
      const cause = asRecord(event.error?.error);
      const text = [
        typeof event.error?.message === "string" ? event.error.message : "",
        typeof event.error?.error === "string" ? event.error.error : "",
        typeof cause?.message === "string" ? cause.message : "",
      ].join(" ");
      if (permissionTag.test(text)) return true;
      const state = key ? permissionSources.get(key) : undefined;
      if (state?.effect === "deny") return true;
      if (state?.effect === "ask") {
        return categorizeError(text || "unknown", metadata, now).category === "unknown";
      }
      return false;
    };
    const handlePermissionEvent = (raw: any) => {
      if (!raw || typeof raw !== "object") return;
      const data = asRecord(raw.data) ?? asRecord(raw.properties?.data) ?? {};
      const now = Date.now();
      if (raw.type === "permission.asked") {
        const source = asRecord(data.source);
        const key = sourcePermissionKey(data.sessionID, source, data.action);
        if (
          key &&
          typeof data.id === "string" &&
          typeof data.sessionID === "string" &&
          typeof data.action === "string" &&
          typeof source?.messageID === "string" &&
          typeof source?.id === "string"
        ) {
          const input = permissionInput(data);
          const fingerprint =
            input === undefined
              ? undefined
              : invocations.fingerprint(
                  data.sessionID,
                  source.id,
                  data.action,
                  input,
                );
          const token =
            input === undefined
              ? undefined
              : invocations.peek(data.sessionID, source.id, data.action, input);
          permissionRequests.set(data.id, {
            key,
            sessionID: data.sessionID,
            messageID: source.messageID,
            id: source.id,
            action: data.action,
            token,
            fingerprint,
            until: now + sourceTTL,
          });
          while (permissionRequests.size > 1_000) {
            const oldest = permissionRequests.keys().next().value;
            if (typeof oldest !== "string") break;
            permissionRequests.delete(oldest);
          }
        }
        return;
      }
      if (raw.type === "permission.replied" && typeof data.requestID === "string") {
        const request = permissionRequests.get(data.requestID);
        if (!request) return;
        permissionRequests.delete(data.requestID);
        if (data.reply === "reject") {
          if (request.fingerprint) {
            rememberPermissionReject(request.fingerprint, now);
          }
          if (request.token) {
            invocations.abandon(request.token);
            engine.abandonCall(request.sessionID, request.token);
            // Decrement, not delete: sibling webfetch calls may share the
            // outer Code Mode id and must keep their source accounting.
            untrackSource(activeWebfetch, {
              sessionID: request.sessionID,
              messageID: request.messageID,
              id: request.id,
            });
            permissionSources.delete(request.key);
          } else if (!request.fingerprint) {
            // No input identity was published. Do not guess and discard a
            // sibling: leave the token/pending record to after/TTL cleanup.
          }
          // activeExecutes remains until outer after/TTL: removing it on a
          // caught leaf rejection would disable the raw-fetch guard mid-script.
        } else {
          rememberPermission(request.key, "allow", now);
        }
      }
    };

    // Install the core policy hooks before optional host/websearch setup. A
    // failure in optional setup must not leave external retrieval ungated.
    registrations.push(
      await context.permission.hook("evaluate", (event) => {
        if (
          event.action === "webfetch" &&
          (!isWebfetchSource(event.sessionID, event.source) ||
            isOuterSource(event.sessionID, event.source))
        ) {
          event.effect = "deny";
          event.message =
            "Only the governed webfetch tool may perform web fetches; raw Code Mode fetch is not permitted.";
        }
        const key = sourcePermissionKey(event.sessionID, event.source, event.action);
        if (key) {
          rememberPermission(key, event.effect as PermissionSourceState["effect"], Date.now());
        }
      }),
    );

    try {
      const stream = context.event?.subscribe?.();
      if (stream) {
        const iterator = stream[Symbol.asyncIterator]();
        let stopped = false;
        const task = (async () => {
          try {
            while (!stopped) {
              const next = await iterator.next();
              if (next.done) break;
              handlePermissionEvent(next.value);
            }
          } catch {
            // Event observation is best-effort; permission.evaluate/message
            // recognition still covers explicit denials.
          }
        })();
        registrations.push({
          dispose: async () => {
            stopped = true;
            try {
              await iterator.return?.();
            } catch {
              // ignore
            }
            await task;
          },
        });
      }
    } catch {
      // EventDomain unavailable: keep evaluate/message based recognition.
    }


    registrations.push(
      await context.tool.hook("execute.before", async (event) => {
        if (event.tool === "execute") {
          engine.noteAgent(event.sessionID, event.agent);
          trackOuter(event);
          return;
        }
        engine.noteAgent(event.sessionID, event.agent);
        if (event.agent === "explore") {
          const discoveryDecision = discovery.count(event.sessionID, event.tool, event.input);
          if (!discoveryDecision.allowed) {
            const status = discoveryDecision.status;
            throw new Tool.Error({
              message:
                `retrieval-policy: discovery_budget_exhausted — explore used ${status.used}/${status.limit} ` +
                `search/list calls for this assignment. Stop and report scoped locations and queries, ` +
                `results, remaining uncertainty, and one concrete next step. The parent may approve one ` +
                `bounded extension with retrieval_control action=extend_explore.`,
            });
          }
        }
        if (event.tool === "webfetch") trackWebfetch(event);
        const token = invocations.begin(
          event.sessionID,
          String(event.id),
          event.tool,
          event.input,
        );
        // A new identical invocation is not the previously rejected one; the
        // rejected token was already abandoned, so drop its late-after marker.
        rejectedInvocations.delete(
          invocations.fingerprint(event.sessionID, String(event.id), event.tool, event.input),
        );
        const decision = await engine.before(
          {
            tool: event.tool,
            sessionID: event.sessionID,
            callID: token,
          },
          { args: event.input },
        );
        if (!decision.allowed) {
          invocations.abandon(token);
          if (event.tool === "webfetch") untrackWebfetch(event);
          throw new Tool.Error({ message: formatDecision(decision) });
        }
      }),
    );

    registrations.push(
      await context.tool.hook("execute.after", async (event) => {
        if (event.tool === "execute") {
          untrackOuter(event);
          return;
        }
        engine.noteAgent(event.sessionID, event.agent);
        if (event.tool === "webfetch") untrackWebfetch(event);
        const permissionKey = eventPermissionKey(event);
        const permissionFingerprint = invocations.fingerprint(
          event.sessionID,
          String(event.id),
          event.tool,
          event.input,
        );
        const localPermission = localPermissionFailure(
          event,
          permissionKey,
          permissionFingerprint,
        );
        const metadata = localPermission
          ? { retrieval_outcome: "unavailable", code: "permission_denied" }
          : afterMetadata(event);
        if (permissionKey) permissionSources.delete(permissionKey);
        rejectedInvocations.delete(permissionFingerprint);
        if (metadata.code === "native_search_provider_mismatch") {
          engine.setNativeSearchAvailable(false);
        }
        const token = invocations.complete(
          event.sessionID,
          String(event.id),
          event.tool,
          event.input,
        );
        if (!token) return;
        await engine.after(
          {
            tool: event.tool,
            sessionID: event.sessionID,
            callID: token,
            args: event.input,
          },
          {
            title: "",
            output: "",
            metadata,
          },
        );
      }),
    );

    const extendExploreBudget = async (
      input: ControlInput,
      caller: ControlCaller,
    ): Promise<ControlResult> => {
      const lookup = async (sessionID: string) => {
        try {
          return await context.session.get({ sessionID: sessionID as any });
        } catch {
          return undefined;
        }
      };
      const callerInfo = await lookup(caller.sessionID);
      const callerAgent = caller.agent ?? callerInfo?.agent;
      if (callerAgent !== "build" && callerAgent !== "plan") {
        return {
          ok: false,
          reason: "extend_not_authorized",
          message: "only build/plan may extend an explore discovery budget",
        };
      }
      const target = typeof input.session_id === "string" ? input.session_id.trim() : "";
      if (!target || target === caller.sessionID) {
        return {
          ok: false,
          reason: "forged_session_target",
          message: "session_id must name an explore child session",
        };
      }
      const targetInfo = await lookup(target);
      if (!targetInfo) return { ok: false, reason: "session_not_found" };
      if (targetInfo.parentID !== caller.sessionID) {
        return {
          ok: false,
          reason: "target_not_child",
          message: "target is not a child of the calling session",
        };
      }
      if (targetInfo.agent !== "explore" && !(targetInfo.agent === undefined && discovery.has(target))) {
        return {
          ok: false,
          reason: "target_not_explore",
          message: "target child is not an explore assignment",
        };
      }
      const extended = discovery.extend(target, input.extra_calls);
      if (!extended.ok) {
        return { ok: false, reason: extended.reason };
      }
      return engine.status({ session_id: target }, caller);
    };

    registrations.push(
      await context.tool.transform((editor) => {
        editor.add({
          name: "retrieval_control",
          options: { codemode: false },
          description:
            "Inspect or extend retrieval or exploration budgets, or reset a blocked provider circuit. status returns remaining search/read budget and, for a tracked explore child, its local search/list-call budget; also reports policy-eligible providers, key presence, and connector_status (configured vs recorded live success; not a live health probe). extend is build/plan-only, targets a direct child, and grants +3 search/+3 read once. extend_explore is build/plan-only, targets a direct child, and grants one bounded local search/list extension (8 calls by default, extra_calls up to 32) without resetting its counters. reset_provider is root build/plan-only and clears auth/circuit state without resetting rate caps or budgets.",
          input: controlInput as any,
          async execute(rawInput: unknown, toolContext) {
            const input = rawInput as ControlInput;
            engine.noteAgent(toolContext.sessionID, toolContext.agent);
            const caller: ControlCaller = {
              sessionID: toolContext.sessionID,
              agent: toolContext.agent,
            };
            const result =
              input.action === "status"
                ? await engine.status(input, caller)
                : input.action === "extend"
                  ? await engine.extend(input, caller)
                  : input.action === "extend_explore"
                    ? await extendExploreBudget(input, caller)
                    : await engine.resetProvider({ provider: input.provider }, caller);
            const discoveryTarget =
              typeof input.session_id === "string" && input.session_id.trim()
                ? input.session_id.trim()
                : toolContext.sessionID;
            const report =
              result.report && discovery.has(discoveryTarget)
                ? { ...result.report, discovery: discovery.status(discoveryTarget) }
                : result.report;
            const body = result.ok
              ? {
                  ok: true,
                  report,
                  provider: result.provider,
                  reset: result.reset,
                }
              : {
                  ok: false,
                  reason: result.reason,
                  message: result.message,
                  report,
                };
            return {
              content: JSON.stringify(body),
              metadata: {
                retrieval_control: true,
                action: input.action,
                ok: result.ok,
                reason: result.reason,
                provider: result.provider,
                reset: result.reset,
              },
            };
          },
        });
      }),
    );

    // Optional setup runs only after the core policy/permission hooks above.
    try {
      registrations.push(
        await registerHostConfig(context, { env: env as Record<string, string | undefined> }),
      );
    } catch {
      // Host config is owned elsewhere; core retrieval policy remains active.
      // Report failure without echoing config values or credentials.
      console.error(
        "retrieval-policy: host config setup failed; continuing without host defaults",
      );
    }

    let tinyfishAvailable = false;
    try {
      const result = await context.websearch.providers();
      const list = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [];
      tinyfishAvailable = list.some((provider: any) => provider?.id === "tinyfish");
    } catch {
      tinyfishAvailable = false;
    }
    engine.setNativeSearchAvailable(false);

    try {
      registrations.push(
        await context.websearch.transform((editor) => {
          try {
            if (!editor?.default || typeof editor.default.set !== "function") {
              engine.setNativeSearchAvailable(false);
              return;
            }
            editor.default.set(tinyfishAvailable ? "tinyfish" : false);
            engine.setNativeSearchAvailable(tinyfishAvailable);
          } catch {
            engine.setNativeSearchAvailable(false);
            try {
              editor.default?.set(false);
            } catch {
              // Incomplete editor: fail closed through the engine guard.
            }
          }
        }),
      );
    } catch {
      engine.setNativeSearchAvailable(false);
    }

    return async () => {
      for (const registration of registrations.reverse()) {
        await registration.dispose();
      }
    };
  },
});

export default RetrievalPolicyPlugin;
