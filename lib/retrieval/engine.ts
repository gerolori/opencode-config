import {
  candidateProviders,
  classifyTool,
  extractReadPlan,
  hashKey,
  isRemoteRepoRef,
  MAX_READS_PER_CALL,
  normalizeQuery,
  normalizeToolName,
  providerCost,
  sessionStorageKey,
} from "./catalog";
import { categorizeError, planCooldown } from "./errors";
import {
  defaultProviderState,
  defaultState,
  SESSION_QUERY_TTL_MS,
  SESSION_RETRY_TTL_MS,
  resolveStateDir,
  StateStore,
  type StateFs,
} from "./state";
import type {
  BlockedResource,
  CostClass,
  ErrorCategory,
  EventRecord,
  PersistenceHealth,
  PolicyDecision,
  PolicyReason,
  ProviderAvailability,
  ProviderId,
  ProviderRateState,
  ProviderState,
  RateLimitResult,
  RetrievalKind,
  SessionBudget,
  SessionInfo,
  SessionLookup,
  TinyFishProviderBridge,
  ToolClassification,
  UsageSnapshot,
} from "./types";

export const INITIAL_SEARCH_BUDGET = 3;
export const INITIAL_READ_BUDGET = 3;
export const EXTEND_AMOUNT = 3;
export const MAX_PROVIDERS_PER_QUERY = 2;
export const TINYFISH_RATE_LIMITS = {
  minute: { ms: 60_000, max: 30 },
  hour: { ms: 60 * 60_000, max: 500 },
  day: { ms: 24 * 60 * 60_000, max: 12_000 },
} as const;

const PENDING_TTL_MS = 15 * 60_000;
const COMPLETED_TTL_MS = 5 * 60_000;
const OUTCOME_MEMORY_LIMIT = 2_000;
const LOOKUP_CACHE_MS = 60_000;
export const RESETTABLE_PROVIDERS: ProviderId[] = [
  "duckduckgo",
  "tinyfish",
  "exa",
  "gh_grep",
  "context7",
  "builtin_webfetch",
  "semble",
];

export type RetrievalEngineOptions = {
  now?: () => number;
  stateDir?: string;
  store?: StateStore;
  fs?: StateFs;
  env?: Record<string, string | undefined>;
  sessionLookup?: SessionLookup;
  maxSessions?: number;
  maxEventLines?: number;
  lockWaitMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
};

export type BeforeInput = { tool: string; sessionID: string; callID: string };
export type AfterInput = BeforeInput & { args?: unknown };

type PendingCall = {
  tool: string;
  provider: ProviderId;
  kind: RetrievalKind;
  /** Retry/budget key; for batch reads this is a stable join of resource keys. */
  query?: string;
  /** Provider-limit keys (concrete URLs or query pseudo-keys). */
  keys: string[];
  /** Concrete normalized URLs only. */
  urls: string[];
  startedAt: number;
  wasRetry: boolean;
};

type RetryEntry = {
  provider: ProviderId;
  category: ErrorCategory;
  retried: boolean;
  at: number;
};

type CachedSession = SessionInfo & { loadedAt: number };

export type ControlCaller = { sessionID: string; agent?: string };

export type ControlStatus = {
  session: string;
  limits: { search: number; read: number };
  remaining: { search: number; read: number };
  used: { search: number; read: number; blockedSearch: number; blockedRead: number };
  extended: boolean;
  providers: Array<{
    provider: ProviderId;
    available: boolean;
    reason?: PolicyReason;
    next_available?: number | "operator";
    key_configured?: boolean;
    cost: CostClass;
    rate_remaining?: { minute: number; hour: number; day: number };
  }>;
  suggested: {
    search: ProviderId[];
    semantic: ProviderId[];
    read: ProviderId[];
  };
  health: {
    persistence_failed: boolean;
    degraded_until?: number;
    reason?: string;
  };
  usage?: UsageSnapshot;
  note: "counts_are_local_attempts_not_vendor_billing";
  blocked_attempts_consume_budget: true;
};

export type ControlResult = {
  ok: boolean;
  reason?: PolicyReason;
  message?: string;
  report?: ControlStatus;
  provider?: ProviderId;
  reset?: string[];
};

/**
 * Retrieval policy engine.
 *
 * The engine owns budgets, provider circuits, error classification, control
 * actions and metadata-only persistence. OpenCode-specific wiring lives in
 * `plugins/retrieval-policy.ts`.
 */
export class RetrievalEngine {
  private readonly now: () => number;
  private readonly store: StateStore;
  private readonly env: Record<string, string | undefined>;
  private readonly lookup?: SessionLookup;
  private state = defaultState(0);
  private loaded?: Promise<void>;
  private persistenceFailed = false;
  private lastEventPersistError?: string;
  private readonly agents = new Map<string, string>();
  private readonly sessions = new Map<string, CachedSession>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly completed = new Map<string, { call: PendingCall; completedAt: number }>();
  private readonly callOutcomes = new Map<string, "success" | "failure">();
  private readonly usage = new Map<string, UsageSnapshot>();
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RetrievalEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
    this.lookup = options.sessionLookup;
    const dir = options.stateDir ?? resolveStateDir(this.env);
    this.store =
      options.store ??
      new StateStore({
        dir,
        fs: options.fs,
        now: this.now,
        maxSessions: options.maxSessions,
        maxEventLines: options.maxEventLines,
        lockWaitMs: options.lockWaitMs,
        lockStaleMs: options.lockStaleMs,
        lockPollMs: options.lockPollMs,
      });
  }

  get stateDirectory(): string {
    return this.store.dir;
  }

  get eventsFile(): string {
    return this.store.eventsPath;
  }

  async init(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          this.state = await this.store.load();
          this.persistenceFailed = Boolean(this.state.health.persistenceFailed);
        } catch (error) {
          this.state = defaultState(this.now());
          this.persistenceFailed = true;
          this.state.health = {
            persistenceFailed: true,
            lastError: errorMessage(error),
            reason: "state_load_failed",
          };
        }
      })();
    }
    await this.loaded;
    await this.clearExpiredDegradation();
  }

  noteAgent(sessionID: string, agent: string | undefined): void {
    if (typeof agent !== "string" || agent.trim().length === 0) return;
    this.agents.set(sessionID, agent.trim());
    const existing = this.sessions.get(sessionID);
    if (existing) existing.agent = agent.trim();
  }

  noteSession(info: SessionInfo): void {
    if (!info || typeof info.id !== "string") return;
    const existing = this.sessions.get(info.id) ?? { id: info.id, loadedAt: 0 };
    this.sessions.set(info.id, {
      ...existing,
      id: info.id,
      parentID: info.parentID ?? existing.parentID,
      agent: info.agent ?? existing.agent,
      loadedAt: this.now(),
    });
    if (info.agent) this.agents.set(info.id, info.agent);
  }

  async before(input: BeforeInput, output: { args?: unknown }): Promise<PolicyDecision> {
    await this.init();
    const tool = normalizeToolName(input.tool);
    if (tool === "task") return this.beforeTask(input);
    const classification = classifyTool(input.tool);
    if (!classification) return { allowed: true, reason: "not_retrieval" };
    // Identity lookup may touch the SDK; never do that while holding the lock.
    const agent = await this.resolveAgent(input.sessionID).catch(() => undefined);
    try {
      return await this.runTransaction(() =>
        classification.kind === "local"
          ? this.beforeLocal(input, output, classification, agent)
          : this.beforeExternal(input, output, classification, agent),
      );
    } catch (error) {
      this.markPersistenceFailure(error);
      return {
        allowed: false,
        reason: "persistence_degraded",
        message: "retrieval state transaction failed; retrieval is fail-closed",
      };
    }
  }

  async after(input: AfterInput, output: {
    title?: string;
    output?: string;
    metadata?: unknown;
  }): Promise<void> {
    await this.init();
    const classification = classifyTool(input.tool);
    if (!classification) return;
    const callKey = callKeyOf(input.sessionID, input.callID);
    const now = this.now();
    const metadata = isRecord(output.metadata) ? output.metadata : {};
    const errorInfo = metadataError(metadata, now);

    try {
      await this.runTransaction(async () => {
        if (this.callOutcomes.has(callKey)) return;
        const pending =
          this.pending.get(callKey) ?? this.completed.get(callKey)?.call;
        this.pending.delete(callKey);
        const budget = this.getBudget(input.sessionID);

        if (!pending) {
          // No authorized pre-hook call: never invent success or clear circuits.
          this.rememberOutcome(callKey, "failure");
          this.completed.delete(callKey);
          await this.appendEvent(
            this.makeEvent(
              input,
              classification,
              budget,
              "unavailable",
              "pending_missing",
              undefined,
              undefined,
            ),
          );
          await this.persist();
          return;
        }

        const latencyMs = Math.max(0, now - pending.startedAt);
        if (errorInfo.isError) {
          this.completed.delete(callKey);
          this.rememberOutcome(callKey, "failure");
          const resourceOnly =
            classification.kind === "read" &&
            (errorInfo.category === "access_denied" || errorInfo.category === "captcha");
          if (errorInfo.category && !resourceOnly) {
            await this.applyFailure(
              classification.provider,
              errorInfo.category,
              errorInfo.retryAfterMs,
              latencyMs,
              pending.wasRetry,
              classification.external,
            );
          }
          if (resourceOnly) {
            this.blockResources(pending.urls, errorInfo.category as "access_denied" | "captcha", errorInfo.retryAfterMs, now);
          }
          if (errorInfo.category === "transient" && !pending.wasRetry) {
            this.setRetry(
              input.sessionID,
              classification.provider,
              classification.tool,
              pending.query,
              {
                provider: classification.provider,
                category: errorInfo.category,
                retried: false,
                at: now,
              },
            );
          }
          await this.appendEvent(
            this.makeEvent(
              input,
              classification,
              budget,
              errorInfo.structuredUnavailable ? "unavailable" : "failure",
              errorInfo.code,
              errorInfo.category,
              latencyMs,
            ),
          );
          await this.persist();
          return;
        }

        const providerState = this.providerState(classification.provider);
        providerState.successes += 1;
        providerState.consecutiveFailures = 0;
        providerState.lastSuccessAt = now;
        providerState.cooldownUntil = undefined;
        providerState.requiresOperator = false;
        providerState.lastLatencyMs = latencyMs;
        this.clearRetry(
          input.sessionID,
          classification.provider,
          classification.tool,
          pending.query,
        );
        this.rememberOutcome(callKey, "success");
        this.rememberCompleted(callKey, pending, now);
        await this.appendEvent(
          this.makeEvent(
            input,
            classification,
            budget,
            "success",
            undefined,
            undefined,
            latencyMs,
          ),
        );
        await this.persist();
      });
    } catch (error) {
      this.markPersistenceFailure(error);
    }
  }

  async handleEvent(event: unknown): Promise<void> {
    await this.init();
    if (!isRecord(event) || typeof event.type !== "string") return;
    const properties = isRecord(event.properties) ? event.properties : {};

    if (
      event.type === "session.created" ||
      event.type === "session.updated" ||
      event.type === "session.deleted"
    ) {
      const info = properties.info;
      if (isRecord(info) && typeof info.id === "string") {
        if (event.type === "session.deleted") {
          this.sessions.delete(info.id);
          this.agents.delete(info.id);
        } else {
          this.noteSession({
            id: info.id,
            parentID: typeof info.parentID === "string" ? info.parentID : undefined,
          });
        }
      }
      return;
    }

    if (event.type === "message.updated") {
      const info = properties.info;
      if (isRecord(info) && info.role === "assistant" && typeof info.sessionID === "string") {
        if (typeof info.mode === "string") this.noteAgent(info.sessionID, info.mode);
        this.noteUsage(info.sessionID, info);
      }
      return;
    }

    if (event.type !== "message.part.updated") return;
    const part = properties.part;
    if (!isRecord(part) || part.type !== "tool") return;
    if (!isRecord(part.state) || part.state.status !== "error") return;
    const tool = typeof part.tool === "string" ? part.tool : "";
    const sessionID = typeof part.sessionID === "string" ? part.sessionID : "";
    const callID =
      typeof part.callID === "string"
        ? part.callID
        : typeof part.id === "string"
          ? part.id
          : "";
    if (!sessionID || !callID) return;
    const classification = classifyTool(tool);
    if (!classification) return;
    const callKey = callKeyOf(sessionID, callID);
    const now = this.now();
    const errorText = typeof part.state.error === "string" ? part.state.error : "";
    const errorMeta = isRecord(part.state.metadata) ? part.state.metadata : undefined;
    const { category, retryAfterMs } = categorizeError(errorText, errorMeta, now);

    try {
      await this.runTransaction(async () => {
        const prior = this.callOutcomes.get(callKey);
        if (prior === "failure") return;
        const pending =
          this.pending.get(callKey) ?? this.completed.get(callKey)?.call;
        this.pending.delete(callKey);
        this.completed.delete(callKey);
        const budget = this.getBudget(sessionID);

        if (!pending) {
          // A denied/never-authorized call must not poison provider circuits.
          this.rememberOutcome(callKey, "failure");
          await this.appendEvent(
            this.makeEvent(
              { tool, sessionID, callID },
              classification,
              budget,
              "failure",
              "unattributed_failure",
              category,
              undefined,
            ),
          );
          await this.persist();
          return;
        }

        if (prior === "success") {
          // An actual error event wins over a completed-tool success.
          const state = this.providerState(classification.provider);
          if (state.successes > 0) state.successes -= 1;
        }
        this.rememberOutcome(callKey, "failure");
        const latency = Math.max(0, now - pending.startedAt);
        const resourceOnly =
          classification.kind === "read" &&
          (category === "access_denied" || category === "captcha");
        if (!resourceOnly) {
          await this.applyFailure(
            classification.provider,
            category,
            retryAfterMs,
            latency,
            pending.wasRetry,
            Boolean(classification.external),
          );
        } else {
          this.blockResources(
            pending.urls,
            category as "access_denied" | "captcha",
            retryAfterMs,
            now,
          );
        }

        if (category === "transient" && !pending.wasRetry) {
          this.setRetry(
            sessionID,
            classification.provider,
            classification.tool,
            pending.query,
            {
              provider: classification.provider,
              category,
              retried: false,
              at: now,
            },
          );
        }

        await this.appendEvent(
          this.makeEvent(
            { tool, sessionID, callID },
            classification,
            budget,
            "failure",
            resourceOnly ? "resource_blocked" : undefined,
            category,
            latency,
          ),
        );
        await this.persist();
      });
    } catch (error) {
      this.markPersistenceFailure(error);
    }
  }

  async status(
    args: { session_id?: string },
    caller: ControlCaller,
  ): Promise<ControlResult> {
    await this.init();
    const target = typeof args.session_id === "string" && args.session_id.trim()
      ? args.session_id.trim()
      : caller.sessionID;
    if (target !== caller.sessionID) {
      const callerAgent = caller.agent ?? (await this.resolveAgent(caller.sessionID));
      if (callerAgent !== "build" && callerAgent !== "plan") {
        return { ok: false, reason: "forged_session_target", message: "status target must be your own session" };
      }
      const targetInfo = await this.resolveSession(target);
      if (!targetInfo) {
        return { ok: false, reason: "session_not_found" };
      }
      if (targetInfo.parentID !== caller.sessionID) {
        return { ok: false, reason: "target_not_child" };
      }
    }
    try {
      return await this.runTransaction(async () => {
        await this.tryRecoverPersistence();
        return { ok: true, report: this.buildStatus(target) };
      });
    } catch (error) {
      this.markPersistenceFailure(error);
      return { ok: true, report: this.buildStatus(target) };
    }
  }

  async extend(
    args: { session_id?: string },
    caller: ControlCaller,
  ): Promise<ControlResult> {
    await this.init();
    const callerAgent = caller.agent ?? (await this.resolveAgent(caller.sessionID));
    if (callerAgent !== "build" && callerAgent !== "plan") {
      return {
        ok: false,
        reason: "extend_not_authorized",
        message: "only build/plan may extend a child retrieval budget",
      };
    }
    const target = typeof args.session_id === "string" ? args.session_id.trim() : "";
    if (!target || target === caller.sessionID) {
      return { ok: false, reason: "forged_session_target", message: "session_id must name a child session" };
    }
    const targetInfo = await this.resolveSession(target);
    if (!targetInfo) return { ok: false, reason: "session_not_found" };
    if (targetInfo.parentID !== caller.sessionID) {
      return { ok: false, reason: "target_not_child", message: "target is not a child of the calling session" };
    }
    try {
      return await this.runTransaction(async () => {
        const budget = this.getBudget(target);
        if (budget.extended) {
          return { ok: false, reason: "already_extended", report: this.buildStatus(target) };
        }
        budget.extended = true;
        budget.updatedAt = this.now();
        if (!(await this.persist())) {
          budget.extended = false;
          return { ok: false, reason: "persistence_degraded" };
        }
        return { ok: true, report: this.buildStatus(target) };
      });
    } catch (error) {
      this.markPersistenceFailure(error);
      return { ok: false, reason: "persistence_degraded" };
    }
  }

  /**
   * Operator-controlled provider reset. This clears only blocked/circuit state;
   * TinyFish local rate counters and all session budgets are preserved.
   */
  async resetProvider(
    args: { provider?: string },
    caller: ControlCaller,
  ): Promise<ControlResult> {
    await this.init();
    const callerAgent = caller.agent ?? (await this.resolveAgent(caller.sessionID));
    if (callerAgent !== "build" && callerAgent !== "plan") {
      return {
        ok: false,
        reason: "reset_not_authorized",
        message: "only root build/plan may reset a provider circuit",
      };
    }
    const info = await this.resolveSession(caller.sessionID);
    if (!info || info.parentID) {
      return {
        ok: false,
        reason: "reset_not_authorized",
        message: "only a root build/plan session may reset a provider",
      };
    }
    const provider = typeof args.provider === "string" ? args.provider.trim() : "";
    if (!RESETTABLE_PROVIDERS.includes(provider as ProviderId)) {
      return {
        ok: false,
        reason: "provider_not_found",
        message: "provider must name a known retrieval provider",
      };
    }
    try {
      return await this.runTransaction(async () => {
        const state = this.providerState(provider as ProviderId);
        const reset: string[] = [];
        if (state.cooldownUntil !== undefined) {
          delete state.cooldownUntil;
          reset.push("cooldown");
        }
        if (state.requiresOperator) {
          state.requiresOperator = false;
          reset.push("operator_required");
        }
        if (state.lastErrorCategory) {
          delete state.lastErrorCategory;
          reset.push("last_error_category");
        }
        if (state.consecutiveFailures > 0) {
          state.consecutiveFailures = 0;
          reset.push("consecutive_failures");
        }
        // Deliberately preserve state.rate, attempts, successes, failures and
        // every session budget. Reset is not a budget/rate-limit grant.
        await this.persist();
        return {
          ok: true,
          provider: provider as ProviderId,
          reset,
          report: this.buildStatus(caller.sessionID),
        };
      });
    } catch (error) {
      this.markPersistenceFailure(error);
      return { ok: false, reason: "persistence_degraded" };
    }
  }

  providerAvailability(provider: ProviderId, now = this.now()): ProviderAvailability {
    const pstate = this.providerState(provider);
    const keyConfigured =
      provider === "exa"
        ? Boolean(this.env.EXA_API_KEY?.trim())
        : provider === "tinyfish"
          ? Boolean(this.env.TINYFISH_API_KEY?.trim())
          : undefined;
    const base: ProviderAvailability = {
      provider,
      available: false,
      cost: providerCost(provider),
      keyConfigured,
    };
    if (provider === "builtin_websearch") {
      return { ...base, reason: "unknown_builtin_search_backend", cost: "unknown_maybe_paid" };
    }
    if ((provider === "exa" || provider === "tinyfish") && !keyConfigured) {
      return { ...base, reason: "missing_api_key" };
    }
    if (pstate.requiresOperator) {
      return {
        ...base,
        reason: "provider_operator_action_required",
        requiresOperator: true,
        nextAvailable: undefined,
      };
    }
    if (pstate.cooldownUntil && pstate.cooldownUntil > now) {
      return {
        ...base,
        reason: "provider_circuit_open",
        nextAvailable: pstate.cooldownUntil,
      };
    }
    if (provider === "tinyfish") {
      const rate = this.checkRate(provider, now);
      if (!rate.allowed) {
        return {
          ...base,
          reason: "provider_unavailable",
          nextAvailable: rate.retryAfterMs ? now + rate.retryAfterMs : undefined,
          rateRemaining: rate.remaining,
        };
      }
      return { ...base, available: true, rateRemaining: rate.remaining };
    }
    return { ...base, available: true };
  }

  tinyfishBridge(): TinyFishProviderBridge {
    return {
      availability: () => this.providerAvailability("tinyfish"),
      consumeCall: async () => {
        try {
          return await this.runTransaction(() => this.consumeTinyFishCall());
        } catch (error) {
          this.markPersistenceFailure(error);
          return {
            allowed: false,
            reason: "persistence" as const,
            remaining: { minute: 0, hour: 0, day: 0 },
          };
        }
      },
      recordFailure: async (category, retryAfterMs, latencyMs) => {
        try {
          await this.runTransaction(() =>
            this.applyFailure("tinyfish", category, retryAfterMs, latencyMs, false, true),
          );
        } catch (error) {
          this.markPersistenceFailure(error);
        }
      },
      recordSuccess: async (latencyMs) => {
        try {
          await this.runTransaction(() => this.applySuccess("tinyfish", latencyMs));
        } catch (error) {
          this.markPersistenceFailure(error);
        }
      },
    };
  }

  private async beforeTask(input: BeforeInput): Promise<PolicyDecision> {
    const info = await this.resolveSession(input.sessionID);
    if (info?.parentID) {
      return {
        allowed: false,
        reason: "nested_task",
        message: "task may not be invoked from a child session (no nested subagent spawning)",
      };
    }
    if (!info) {
      return {
        allowed: false,
        reason: "agent_unknown",
        message: "cannot resolve session identity; task is fail-closed",
      };
    }
    const agent = this.agents.get(input.sessionID) ?? info?.agent;
    if (!agent) {
      return {
        allowed: false,
        reason: "agent_unknown",
        message: "cannot resolve calling agent; task is fail-closed",
      };
    }
    if (agent !== "build" && agent !== "plan") {
      return {
        allowed: false,
        reason: "worker_task_denied",
        message: `agent '${agent}' may not spawn subagents`,
      };
    }
    return { allowed: true, reason: "not_retrieval" };
  }

  private async beforeLocal(
    input: BeforeInput,
    output: { args?: unknown },
    classification: ToolClassification,
    agent: string | undefined,
  ): Promise<PolicyDecision> {
    const budget = this.getBudget(input.sessionID);
    if (!agent) {
      await this.recordBlocked(input, classification, budget, "agent_unknown");
      return {
        allowed: false,
        reason: "agent_unknown",
        message: "cannot resolve calling agent; local Retrieval is fail-closed",
      };
    }
    if (agent !== "explore") {
      await this.recordBlocked(input, classification, budget, "agent_denied");
      return {
        allowed: false,
        reason: "agent_denied",
        message: `agent '${agent}' may not use local code retrieval; only explore may`,
      };
    }
    if (classification.denyReason) {
      await this.recordBlocked(input, classification, budget, "unclassified_retrieval_tool");
      return {
        allowed: false,
        reason: "unclassified_retrieval_tool",
        message: `unclassified local retrieval tool '${classification.tool}'`,
      };
    }
    const args = isRecord(output.args) ? output.args : {};
    if (isRemoteRepoRef(args.repo)) {
      await this.recordBlocked(input, classification, budget, "remote_repo_forbidden");
      return {
        allowed: false,
        reason: "remote_repo_forbidden",
        message: "Semble repo must be a local directory; network git URLs are not allowed",
      };
    }
    await this.appendEvent(
      this.makeEvent(input, classification, budget, "allowed", undefined, undefined, undefined),
    );
    return { allowed: true, reason: "not_retrieval" };
  }

  private async beforeExternal(
    input: BeforeInput,
    output: { args?: unknown },
    classification: ToolClassification,
    agent: string | undefined,
  ): Promise<PolicyDecision> {
    const now = this.now();
    const budget = this.getBudget(input.sessionID);
    const isRead = classification.kind === "read";
    const readPlan = isRead ? extractReadPlan(output.args) : undefined;
    const keys = isRead
      ? (readPlan?.keys ?? [])
      : (() => {
          const query = normalizeQuery("search", output.args);
          return query ? [query] : [];
        })();
    const urls = isRead ? (readPlan?.urls ?? []) : [];
    const units = isRead ? Math.max(1, readPlan?.requested ?? 1) : 1;
    const retryToken = keys.length > 0 ? keys.join("|") : undefined;
    const counter = isRead ? "readUsed" : "searchUsed";
    budget[counter] += units;
    budget.updatedAt = now;

    const deny = async (
      reason: PolicyReason,
      message: string,
      options: { countBlocked?: boolean; next?: ProviderId[] } = {},
    ): Promise<PolicyDecision> => {
      if (options.countBlocked !== false) {
        if (isRead) budget.blockedRead += units;
        else budget.blockedSearch += units;
      }
      budget.updatedAt = now;
      await this.appendEvent(
        this.makeEvent(input, classification, budget, "blocked", reason, undefined, undefined),
      );
      await this.persist();
      const noNext =
        reason === "budget_exhausted" ||
        reason === "provider_limit" ||
        reason === "resource_blocked" ||
        reason === "batch_too_large" ||
        reason === "opaque_resource_unverifiable" ||
        reason === "persistence_degraded" ||
        reason === "agent_unknown" ||
        reason === "agent_denied" ||
        reason === "unknown_builtin_search_backend" ||
        reason === "paid_or_unbounded_tool" ||
        reason === "unclassified_retrieval_tool";
      return {
        allowed: false,
        reason,
        message,
        allowedNextProviders:
          options.next ??
          (noNext ? [] : this.nextProviders(classification.kind, input.sessionID, keys)),
      };
    };

    if (!(await this.ensurePersistent())) {
      return deny("persistence_degraded", "retrieval state cannot be persisted; external retrieval is fail-closed");
    }
    if (this.state.health.degradedUntil && this.state.health.degradedUntil > now) {
      return deny("persistence_degraded", "retrieval state was corrupted; temporary fail-closed window is active");
    }

    if (!agent) {
      return deny("agent_unknown", "cannot resolve calling agent; external retrieval is fail-closed");
    }
    if (agent !== "fetch") {
      return deny("agent_denied", `agent '${agent}' must delegate external retrieval to fetch`);
    }
    if (classification.denyReason === "unknown_builtin_search_backend") {
      return deny(
        "unknown_builtin_search_backend",
        "built-in websearch has an unknown/paid/unbounded backend; use an audited provider",
      );
    }
    if (classification.denyReason === "paid_or_unbounded_tool") {
      return deny("paid_or_unbounded_tool", `tool '${classification.tool}' is paid or unbounded`);
    }
    if (classification.denyReason) {
      return deny(
        "unclassified_retrieval_tool",
        `unclassified retrieval tool '${classification.tool}' is denied by default`,
      );
    }

    if (isRead) {
      if (readPlan?.opaque) {
        return deny(
          "opaque_resource_unverifiable",
          "opaque expansion tokens cannot be checked against blocked resources; supply a concrete URL",
        );
      }
      if (units > MAX_READS_PER_CALL) {
        return deny(
          "batch_too_large",
          `at most ${MAX_READS_PER_CALL} reads are allowed per call`,
        );
      }
    }

    const limit = budgetLimit(budget, classification.kind);
    const used = isRead ? budget.readUsed : budget.searchUsed;
    if (used > limit) {
      return deny("budget_exhausted", `${classification.kind} budget exhausted (${limit} per session)`);
    }

    for (const url of urls) {
      if (this.blockedResource(url, now)) {
        return deny(
          "resource_blocked",
          "this URL was blocked by the site; switching extractors is not allowed while the block is active",
          { next: [] },
        );
      }
    }

    const availability = this.providerAvailability(classification.provider, now);
    const typedUnavailableCustomTool =
      classification.tool === "tinyfish_search" &&
      availability.reason === "missing_api_key";
    if (!availability.available && !typedUnavailableCustomTool) {
      return deny(
        availability.reason ?? "provider_unavailable",
        providerDenyMessage(classification.provider, availability),
      );
    }

    const retry = this.retryEntry(
      input.sessionID,
      classification.provider,
      classification.tool,
      retryToken,
    );
    let wasRetry = false;
    if (retry) {
      if (retry.category !== "transient" || retry.retried) {
        return deny(
          "transient_retry_exhausted",
          "only one transient retry is allowed within the budget",
        );
      }
      retry.retried = true;
      wasRetry = true;
    }

    for (const key of keys) {
      const providers = this.providerSet(input.sessionID, hashKey(key));
      if (!providers.has(classification.provider) && providers.size >= MAX_PROVIDERS_PER_QUERY) {
        return deny(
          "provider_limit",
          `at most ${MAX_PROVIDERS_PER_QUERY} distinct providers per normalized query/URL`,
        );
      }
    }
    for (const key of keys) {
      this.addProvider(input.sessionID, hashKey(key), classification.provider, now);
    }

    this.pending.set(callKeyOf(input.sessionID, input.callID), {
      tool: classification.tool,
      provider: classification.provider,
      kind: classification.kind,
      query: retryToken,
      keys,
      urls,
      startedAt: now,
      wasRetry,
    });
    const providerState = this.providerState(classification.provider);
    providerState.attempts += 1;
    providerState.lastAttemptAt = now;
    await this.appendEvent(
      this.makeEvent(input, classification, budget, "allowed", undefined, undefined, undefined),
    );
    if (!(await this.persist())) {
      this.pending.delete(callKeyOf(input.sessionID, input.callID));
      return deny("persistence_degraded", "retrieval state could not be persisted; call denied");
    }
    return {
      allowed: true,
      reason: "not_retrieval",
      allowedNextProviders: this.nextProviders(
        classification.kind,
        input.sessionID,
        keys,
      ),
    };
  }

  private async applyFailure(
    provider: ProviderId,
    category: ErrorCategory,
    retryAfterMs: number | undefined,
    latencyMs: number | undefined,
    wasRetry: boolean,
    external: boolean,
  ): Promise<void> {
    const now = this.now();
    const pstate = this.providerState(provider);
    pstate.failures += 1;
    pstate.consecutiveFailures += 1;
    pstate.lastErrorCategory = category;
    if (latencyMs !== undefined) pstate.lastLatencyMs = latencyMs;
    pstate.lastAttemptAt = now;

    if (category === "transient" && !wasRetry) {
      // The first transient failure intentionally leaves the provider open so
      // exactly one retry can happen inside the same budget.
      pstate.cooldownUntil = undefined;
      pstate.requiresOperator = false;
    } else {
      const plan = planCooldown(category, retryAfterMs, now);
      pstate.cooldownUntil = plan.cooldownUntil;
      pstate.requiresOperator = plan.requiresOperator;
    }
    if (!external) {
      pstate.cooldownUntil = undefined;
      pstate.requiresOperator = false;
    }
    await this.persist();
  }

  private async applySuccess(provider: ProviderId, latencyMs?: number): Promise<void> {
    const now = this.now();
    const pstate = this.providerState(provider);
    pstate.successes += 1;
    pstate.consecutiveFailures = 0;
    pstate.lastSuccessAt = now;
    pstate.cooldownUntil = undefined;
    pstate.requiresOperator = false;
    if (latencyMs !== undefined) pstate.lastLatencyMs = latencyMs;
    await this.persist();
  }

  private async consumeTinyFishCall(): Promise<RateLimitResult> {
    const now = this.now();
    const rate = this.rateState("tinyfish");
    const windows = [
      ["minute", TINYFISH_RATE_LIMITS.minute] as const,
      ["hour", TINYFISH_RATE_LIMITS.hour] as const,
      ["day", TINYFISH_RATE_LIMITS.day] as const,
    ];
    const counts: Record<string, number> = {};
    for (const [key, spec] of windows) {
      const window = rate[key];
      const currentStart = Math.floor(now / spec.ms) * spec.ms;
      if (window.windowStart !== currentStart) {
        window.windowStart = currentStart;
        window.count = 0;
      }
      counts[key] = window.count;
    }
    for (const [key, spec] of windows) {
      if (counts[key] >= spec.max) {
        const window = rate[key];
        return {
          allowed: false,
          reason: key,
          retryAfterMs: Math.max(0, window.windowStart + spec.ms - now),
          remaining: this.rateRemaining(rate),
        };
      }
    }
    for (const [key] of windows) rate[key].count += 1;
    if (!(await this.persist())) {
      return {
        allowed: false,
        reason: "persistence",
        remaining: this.rateRemaining(rate),
      };
    }
    return { allowed: true, remaining: this.rateRemaining(rate) };
  }

  private checkRate(provider: ProviderId, now: number): RateLimitResult {
    const rate = this.rateState(provider);
    const windows = [
      ["minute", TINYFISH_RATE_LIMITS.minute] as const,
      ["hour", TINYFISH_RATE_LIMITS.hour] as const,
      ["day", TINYFISH_RATE_LIMITS.day] as const,
    ];
    for (const [key, spec] of windows) {
      const window = rate[key];
      const currentStart = Math.floor(now / spec.ms) * spec.ms;
      if (window.windowStart !== currentStart) {
        window.windowStart = currentStart;
        window.count = 0;
      }
      if (window.count >= spec.max) {
        return {
          allowed: false,
          reason: key,
          retryAfterMs: Math.max(0, currentStart + spec.ms - now),
          remaining: this.rateRemaining(rate),
        };
      }
    }
    return { allowed: true, remaining: this.rateRemaining(rate) };
  }

  private rateState(provider: ProviderId): ProviderRateState {
    const pstate = this.providerState(provider);
    pstate.rate ??= {
      minute: { windowStart: 0, count: 0 },
      hour: { windowStart: 0, count: 0 },
      day: { windowStart: 0, count: 0 },
    };
    return pstate.rate;
  }

  private rateRemaining(rate: ProviderRateState): { minute: number; hour: number; day: number } {
    return {
      minute: Math.max(0, TINYFISH_RATE_LIMITS.minute.max - rate.minute.count),
      hour: Math.max(0, TINYFISH_RATE_LIMITS.hour.max - rate.hour.count),
      day: Math.max(0, TINYFISH_RATE_LIMITS.day.max - rate.day.count),
    };
  }

  private buildStatus(sessionID: string): ControlStatus {
    const now = this.now();
    const budget = this.getBudget(sessionID);
    const limits = {
      search: budgetLimit(budget, "search"),
      read: budgetLimit(budget, "read"),
    };
    const remaining = {
      search: Math.max(0, limits.search - budget.searchUsed),
      read: Math.max(0, limits.read - budget.readUsed),
    };
    const providerIds: ProviderId[] = [
      "duckduckgo",
      "tinyfish",
      "exa",
      "gh_grep",
      "context7",
      "builtin_webfetch",
      "builtin_websearch",
    ];
    const providers = providerIds.map((provider) => {
      const a = this.providerAvailability(provider, now);
      return {
        provider,
        available: a.available,
        reason: a.reason,
        next_available: a.requiresOperator
          ? ("operator" as const)
          : a.nextAvailable,
        key_configured: a.keyConfigured,
        cost: a.cost,
        rate_remaining: a.rateRemaining,
      };
    });
    const availableSearch = (provider: ProviderId) =>
      this.providerAvailability(provider, now).available &&
      provider !== "builtin_webfetch";
    const availableRead = (provider: ProviderId) =>
      this.providerAvailability(provider, now).available;
    const searchSuggested =
      remaining.search > 0
        ? candidateProviders({
            kind: "search",
            attempted: new Set(),
            available: availableSearch,
          })
        : [];
    const readSuggested =
      remaining.read > 0
        ? candidateProviders({
            kind: "read",
            attempted: new Set(),
            available: availableRead,
          })
        : [];
    return {
      session: sessionStorageKey(sessionID),
      limits,
      remaining,
      used: {
        search: budget.searchUsed,
        read: budget.readUsed,
        blockedSearch: budget.blockedSearch,
        blockedRead: budget.blockedRead,
      },
      extended: budget.extended,
      providers,
      suggested: {
        search: searchSuggested,
        semantic:
          remaining.search > 0
            ? candidateProviders({
                kind: "search",
                attempted: new Set(),
                available: availableSearch,
                preferExa: true,
              })
            : [],
        read: readSuggested,
      },
      health: {
        persistence_failed: this.persistenceFailed,
        degraded_until: this.state.health.degradedUntil,
        reason: this.state.health.reason,
      },
      usage: this.usage.get(sessionID),
      note: "counts_are_local_attempts_not_vendor_billing",
      blocked_attempts_consume_budget: true,
    };
  }

  private nextProviders(
    kind: RetrievalKind,
    sessionID: string,
    keys: string[],
  ): ProviderId[] {
    const attempted = this.attemptedProviders(sessionID, keys);
    const available = (provider: ProviderId) =>
      this.providerAvailability(provider).available &&
      !(kind === "search" && provider === "builtin_webfetch") &&
      !(kind === "read" && provider === "builtin_websearch");
    return candidateProviders({ kind, attempted, available });
  }

  private attemptedProviders(sessionID: string, keys: string[]): Set<ProviderId> {
    const out = new Set<ProviderId>();
    const budget = this.getBudget(sessionID);
    const now = this.now();
    for (const key of keys) {
      for (const provider of this.providerSet(sessionID, hashKey(key), now)) {
        out.add(provider);
      }
    }
    return out;
  }

  private providerSet(sessionID: string, keyHash: string, now = this.now()): Set<ProviderId> {
    const budget = this.getBudget(sessionID);
    const entry = budget.queryProviders?.[keyHash];
    if (!entry || !Array.isArray(entry.providers)) return new Set();
    if (now - entry.updatedAt > SESSION_QUERY_TTL_MS) {
      delete budget.queryProviders?.[keyHash];
      return new Set();
    }
    return new Set(entry.providers);
  }

  private addProvider(
    sessionID: string,
    keyHash: string,
    provider: ProviderId,
    now = this.now(),
  ): void {
    const budget = this.getBudget(sessionID);
    budget.queryProviders ??= {};
    let entry = budget.queryProviders[keyHash];
    if (!entry || !Array.isArray(entry.providers)) {
      entry = { providers: [], updatedAt: now };
    }
    if (!entry.providers.includes(provider)) entry.providers.push(provider);
    entry.updatedAt = now;
    budget.queryProviders[keyHash] = entry;
    budget.updatedAt = now;
  }

  private retryEntry(
    sessionID: string,
    provider: ProviderId,
    tool: string,
    query: string | undefined,
  ): RetryEntry | undefined {
    const budget = this.getBudget(sessionID);
    const key = this.retryKey(provider, tool, query);
    const entry = budget.retries?.[key];
    if (!entry) return undefined;
    if (
      typeof entry.at !== "number" ||
      typeof entry.retried !== "boolean" ||
      this.now() - entry.at > SESSION_RETRY_TTL_MS
    ) {
      delete budget.retries?.[key];
      return undefined;
    }
    return entry;
  }

  private setRetry(
    sessionID: string,
    provider: ProviderId,
    tool: string,
    query: string | undefined,
    entry: RetryEntry,
  ): void {
    const budget = this.getBudget(sessionID);
    budget.retries ??= {};
    budget.retries[this.retryKey(provider, tool, query)] = entry;
    budget.updatedAt = this.now();
  }

  private clearRetry(
    sessionID: string,
    provider: ProviderId,
    tool: string,
    query: string | undefined,
  ): void {
    const budget = this.getBudget(sessionID);
    if (budget.retries) delete budget.retries[this.retryKey(provider, tool, query)];
  }

  private retryKey(provider: ProviderId, tool: string, query: string | undefined): string {
    return hashKey(`retry|${provider}|${tool}|${query ?? "-"}`);
  }

  private blockedResource(query: string, now: number): BlockedResource | undefined {
    const key = hashKey(query);
    const entry = this.state.blockedResources?.[key];
    if (!entry) return undefined;
    if (entry.until <= now) {
      delete this.state.blockedResources[key];
      return undefined;
    }
    return entry;
  }

  private blockResource(
    query: string,
    reason: "access_denied" | "captcha",
    retryAfterMs: number | undefined,
    now: number,
  ): void {
    const plan = planCooldown(reason, retryAfterMs, now);
    this.state.blockedResources ??= {};
    this.state.blockedResources[hashKey(query)] = {
      until: plan.cooldownUntil ?? now + plan.cooldownMs,
      reason,
      createdAt: now,
    };
  }

  private blockResources(
    urls: string[],
    reason: "access_denied" | "captcha",
    retryAfterMs: number | undefined,
    now: number,
  ): void {
    for (const url of urls) {
      this.blockResource(url, reason, retryAfterMs, now);
    }
  }

  private getBudget(sessionID: string): SessionBudget {
    const key = sessionStorageKey(sessionID);
    const existingRaw = this.state.sessions[key];
    if (existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)) {
      const existing = existingRaw;
      existing.searchUsed = finiteInt(existing.searchUsed);
      existing.readUsed = finiteInt(existing.readUsed);
      existing.blockedSearch = finiteInt(existing.blockedSearch);
      existing.blockedRead = finiteInt(existing.blockedRead);
      existing.extended = Boolean(existing.extended);
      existing.updatedAt = finiteInt(existing.updatedAt) || this.now();
      existing.queryProviders =
        existing.queryProviders &&
        typeof existing.queryProviders === "object" &&
        !Array.isArray(existing.queryProviders)
          ? existing.queryProviders
          : {};
      existing.retries =
        existing.retries &&
        typeof existing.retries === "object" &&
        !Array.isArray(existing.retries)
          ? existing.retries
          : {};
      return existing;
    }
    const now = this.now();
    const budget: SessionBudget = {
      searchUsed: 0,
      readUsed: 0,
      blockedSearch: 0,
      blockedRead: 0,
      extended: false,
      createdAt: now,
      updatedAt: now,
      queryProviders: {},
      retries: {},
    };
    this.state.sessions[key] = budget;
    return budget;
  }

  private providerState(provider: ProviderId): ProviderState {
    const existing = this.state.providers[provider];
    if (existing) return existing;
    const created = defaultProviderState();
    this.state.providers[provider] = created;
    return created;
  }

  private async recordBlocked(
    input: BeforeInput,
    classification: ToolClassification,
    budget: SessionBudget,
    reason: PolicyReason,
  ): Promise<void> {
    if (classification.external) {
      if (classification.kind === "search") budget.blockedSearch += 1;
      else budget.blockedRead += 1;
    }
    budget.updatedAt = this.now();
    await this.appendEvent(
      this.makeEvent(input, classification, budget, "blocked", reason, undefined, undefined),
    );
    await this.persist();
  }

  private makeEvent(
    input: { tool: string; sessionID: string; callID: string },
    classification: ToolClassification,
    budget: SessionBudget,
    outcome: EventRecord["outcome"],
    reason: string | undefined,
    errorCategory: ErrorCategory | undefined,
    latencyMs: number | undefined,
  ): EventRecord {
    const record: EventRecord = {
      schemaVersion: 1,
      ts: this.now(),
      session: sessionStorageKey(input.sessionID),
      tool: classification.tool,
      provider: classification.provider,
      kind: classification.kind,
      outcome,
      attempts: { search: budget.searchUsed, read: budget.readUsed },
      note: "local_attempt_counts_not_vendor_billing",
    };
    if (reason) record.reason = reason;
    if (errorCategory) record.errorCategory = errorCategory;
    if (latencyMs !== undefined) record.latencyMs = latencyMs;
    return record;
  }

  private async appendEvent(record: EventRecord): Promise<void> {
    try {
      await this.store.appendEvent(record);
    } catch (error) {
      this.lastEventPersistError = errorMessage(error);
    }
  }

  private async persist(): Promise<boolean> {
    this.state.updatedAt = this.now();
    try {
      await this.store.saveDirect(this.state);
      this.persistenceFailed = false;
      this.state.health.persistenceFailed = false;
      this.state.health.lastError = undefined;
      if (this.state.health.reason === "persistence_failed") {
        this.state.health.reason = undefined;
      }
      return true;
    } catch (error) {
      this.markPersistenceFailure(error);
      return false;
    }
  }

  private markPersistenceFailure(error: unknown): void {
    this.persistenceFailed = true;
    this.state.health.persistenceFailed = true;
    this.state.health.lastError = errorMessage(error);
    this.state.health.reason = "persistence_failed";
  }

  private async runTransaction<T>(
    fn: () => Promise<T>,
    options: { write?: boolean } = {},
  ): Promise<T> {
    const run = this.operationQueue.then(async () =>
      this.store.transaction(async (fresh) => {
        this.state = fresh;
        await this.clearExpiredDegradation();
        return fn();
      }, options),
    );
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensurePersistent(): Promise<boolean> {
    if (!this.persistenceFailed) return true;
    return this.persist();
  }

  private async tryRecoverPersistence(): Promise<void> {
    if (this.persistenceFailed) await this.persist();
  }

  private async clearExpiredDegradation(): Promise<void> {
    const until = this.state.health.degradedUntil;
    if (until && until <= this.now()) {
      this.state.health.degradedUntil = undefined;
      this.state.health.reason = undefined;
    }
  }

  private rememberCompleted(key: string, call: PendingCall, now: number): void {
    this.completed.set(key, { call, completedAt: now });
    if (this.completed.size <= OUTCOME_MEMORY_LIMIT) {
      for (const [entryKey, entry] of this.completed) {
        if (now - entry.completedAt > COMPLETED_TTL_MS) this.completed.delete(entryKey);
      }
      return;
    }
    for (const [entryKey, entry] of this.completed) {
      if (now - entry.completedAt > COMPLETED_TTL_MS || this.completed.size > OUTCOME_MEMORY_LIMIT) {
        this.completed.delete(entryKey);
      }
      if (this.completed.size <= OUTCOME_MEMORY_LIMIT) break;
    }
  }

  private rememberOutcome(key: string, outcome: "success" | "failure"): void {
    this.callOutcomes.set(key, outcome);
    if (this.callOutcomes.size > OUTCOME_MEMORY_LIMIT) {
      const oldest = this.callOutcomes.keys().next().value;
      if (typeof oldest === "string") this.callOutcomes.delete(oldest);
    }
    // Bound pending calls as well.
    if (this.pending.size > OUTCOME_MEMORY_LIMIT) {
      const now = this.now();
      for (const [pendingKey, value] of this.pending) {
        if (now - value.startedAt > PENDING_TTL_MS) this.pending.delete(pendingKey);
        if (this.pending.size <= OUTCOME_MEMORY_LIMIT) break;
      }
    }
  }

  private noteUsage(sessionID: string, info: Record<string, unknown>): void {
    const tokens = isRecord(info.tokens) ? info.tokens : undefined;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;
    const snapshot: UsageSnapshot = {
      label: "runtime_estimated_not_vendor_billing",
      updatedAt: this.now(),
    };
    if (tokens) {
      snapshot.inputTokens = numberOrUndefined(tokens.input);
      snapshot.outputTokens = numberOrUndefined(tokens.output);
      snapshot.reasoningTokens = numberOrUndefined(tokens.reasoning);
    }
    if (cache) {
      snapshot.cacheReadTokens = numberOrUndefined(cache.read);
      snapshot.cacheWriteTokens = numberOrUndefined(cache.write);
    }
    snapshot.cost = numberOrUndefined(info.cost);
    this.usage.set(sessionID, snapshot);
  }

  private async resolveAgent(sessionID: string): Promise<string | undefined> {
    const direct = this.agents.get(sessionID);
    if (direct) return direct;
    const info = await this.resolveSession(sessionID);
    return info?.agent;
  }

  private async resolveSession(sessionID: string): Promise<CachedSession | undefined> {
    const cached = this.sessions.get(sessionID);
    if (cached && this.now() - cached.loadedAt < LOOKUP_CACHE_MS) return cached;
    if (!this.lookup) return cached;
    try {
      const info = await this.lookup.get(sessionID);
      if (info) {
        this.noteSession(info);
        return this.sessions.get(sessionID);
      }
    } catch {
      // Fail closed at the caller: an unresolved identity must not weaken a
      // task/external gate.
    }
    return cached;
  }

  get health(): PersistenceHealth {
    return this.state.health;
  }

  get lastEventError(): string | undefined {
    return this.lastEventPersistError;
  }
}

export function budgetLimit(budget: SessionBudget, kind: RetrievalKind): number {
  if (kind === "search") return INITIAL_SEARCH_BUDGET + (budget.extended ? EXTEND_AMOUNT : 0);
  if (kind === "read") return INITIAL_READ_BUDGET + (budget.extended ? EXTEND_AMOUNT : 0);
  return 0;
}

function callKeyOf(sessionID: string, callID: string): string {
  return `${sessionID}:${callID}`;
}

function providerDenyMessage(
  provider: ProviderId,
  availability: ProviderAvailability,
): string {
  if (availability.reason === "missing_api_key") {
    return `provider '${provider}' has no configured credential`;
  }
  if (availability.reason === "provider_operator_action_required") {
    return `provider '${provider}' is blocked pending operator action`;
  }
  if (availability.reason === "provider_circuit_open") {
    return `provider '${provider}' circuit is open until ${availability.nextAvailable ?? "unknown"}`;
  }
  if (availability.reason === "unknown_builtin_search_backend") {
    return "built-in websearch has an unknown/paid/unbounded backend";
  }
  return `provider '${provider}' is temporarily unavailable`;
}

function finiteInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MetadataErrorInfo = {
  isError: boolean;
  structuredUnavailable: boolean;
  code?: string;
  category?: ErrorCategory;
  retryAfterMs?: number;
};

/**
 * Defensive error detection for the after hook. Runtime normally calls after
 * only for success, but a completed/error metadata shape still must never be
 * counted as success or clear an auth/circuit block.
 */
function metadataError(metadata: Record<string, any>, now: number): MetadataErrorInfo {
  const structuredUnavailable =
    metadata.retrieval_outcome === "unavailable" ||
    metadata.retrieval_outcome === "failure";
  const exitCode = metadata.exitCode ?? metadata.exit;
  const exitIsError =
    (typeof exitCode === "number" && exitCode !== 0) ||
    (typeof exitCode === "string" && exitCode.length > 0 && exitCode !== "0");
  const isError =
    structuredUnavailable ||
    metadata.isError === true ||
    metadata.status === "error" ||
    metadata.status === "failed" ||
    metadata.ok === false ||
    metadata.success === false ||
    metadata.failed === true ||
    metadata.error_category !== undefined ||
    metadata.retry_after_ms !== undefined ||
    Boolean(metadata.error) ||
    Boolean(metadata.errorMessage) ||
    exitIsError;

  if (!isError) {
    return { isError: false, structuredUnavailable: false };
  }

  const code =
    typeof metadata.code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(metadata.code)
      ? metadata.code
      : undefined;
  const category = isErrorCategory(metadata.error_category)
    ? (metadata.error_category as ErrorCategory)
    : undefined;
  const retryAfterMs =
    typeof metadata.retry_after_ms === "number" && Number.isFinite(metadata.retry_after_ms)
      ? Math.max(0, metadata.retry_after_ms)
      : undefined;

  if (category) {
    return { isError: true, structuredUnavailable, code, category, retryAfterMs };
  }
  if (structuredUnavailable) {
    return { isError: true, structuredUnavailable, code, retryAfterMs };
  }

  const text =
    typeof metadata.error === "string"
      ? metadata.error
      : isRecord(metadata.error) && typeof metadata.error.message === "string"
        ? metadata.error.message
        : typeof metadata.errorMessage === "string"
          ? metadata.errorMessage
          : typeof metadata.message === "string"
            ? metadata.message
            : "unknown tool error";
  const classified = categorizeError(text, metadata, now);
  return {
    isError: true,
    structuredUnavailable,
    code,
    category: classified.category,
    retryAfterMs: retryAfterMs ?? classified.retryAfterMs,
  };
}

function isErrorCategory(value: unknown): value is ErrorCategory {
  return (
    value === "auth" ||
    value === "quota" ||
    value === "captcha" ||
    value === "access_denied" ||
    value === "transient" ||
    value === "unknown"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
