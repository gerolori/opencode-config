/**
 * Shared types for the retrieval-policy plugin.
 *
 * Everything in this module is deliberately free of OpenCode runtime imports so
 * the policy can be unit-tested with injected clocks, filesystems, clients and
 * fetch implementations.
 */

export type RetrievalKind = "search" | "read" | "local";

export type ProviderId =
  | "duckduckgo"
  | "tinyfish"
  | "exa"
  | "gh_grep"
  | "context7"
  | "builtin_webfetch"
  | "builtin_websearch"
  | "semble"
  | "unknown";

export type CostClass =
  | "free"
  | "free_bounded"
  | "free_tier_then_paid"
  | "paid"
  | "unknown_maybe_paid";

export type ToolClassification = {
  tool: string;
  kind: RetrievalKind;
  provider: ProviderId;
  cost: CostClass;
  /** External providers are subject to per-session budgets/circuits. */
  external: boolean;
  /** Non-empty means the tool is refused even when the agent is otherwise allowed. */
  denyReason?: string;
};

export type ErrorCategory =
  | "auth"
  | "quota"
  | "captcha"
  | "access_denied"
  | "transient"
  | "unknown";

export type PolicyReason =
  | "not_retrieval"
  | "agent_unknown"
  | "agent_denied"
  | "nested_task"
  | "worker_task_denied"
  | "budget_exhausted"
  | "provider_limit"
  | "provider_circuit_open"
  | "provider_operator_action_required"
  | "provider_unavailable"
  | "missing_api_key"
  | "unknown_builtin_search_backend"
  | "unclassified_retrieval_tool"
  | "paid_or_unbounded_tool"
  | "transient_retry_exhausted"
  | "remote_repo_forbidden"
  | "resource_blocked"
  | "opaque_resource_unverifiable"
  | "batch_too_large"
  | "persistence_degraded"
  | "reset_not_authorized"
  | "provider_not_found"
  | "forged_session_target"
  | "target_not_child"
  | "extend_not_authorized"
  | "already_extended"
  | "session_not_found";

export type PolicyDecision = {
  allowed: boolean;
  reason: PolicyReason;
  message?: string;
  /** Providers the caller may try next, in preferred order. Never contains secrets. */
  allowedNextProviders?: ProviderId[];
};

export type SessionBudget = {
  searchUsed: number;
  readUsed: number;
  blockedSearch: number;
  blockedRead: number;
  extended: boolean;
  createdAt: number;
  updatedAt: number;
  /** Hashed per-assignment query/URL provider sets. */
  queryProviders?: Record<string, StoredQueryProviders>;
  /** Hashed transient retry counters. */
  retries?: Record<string, StoredRetry>;
};

export type StoredQueryProviders = {
  providers: ProviderId[];
  updatedAt: number;
};

export type StoredRetry = {
  provider: ProviderId;
  category: ErrorCategory;
  retried: boolean;
  at: number;
};

export type WindowCounter = {
  windowStart: number;
  count: number;
};

export type ProviderRateState = {
  minute: WindowCounter;
  hour: WindowCounter;
  day: WindowCounter;
};

export type ProviderState = {
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastLatencyMs?: number;
  lastErrorCategory?: ErrorCategory;
  cooldownUntil?: number;
  requiresOperator?: boolean;
  rate?: ProviderRateState;
};

export type PersistenceHealth = {
  persistenceFailed?: boolean;
  degradedUntil?: number;
  reason?: string;
  lastError?: string;
};

export type BlockedResource = {
  until: number;
  reason: "access_denied" | "captcha";
  createdAt: number;
};

export type UsageSnapshot = {
  label: "runtime_estimated_not_vendor_billing";
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  updatedAt: number;
};

export type PersistentState = {
  schemaVersion: 1;
  updatedAt: number;
  providers: Record<string, ProviderState>;
  /** Keyed by a truncated SHA-256 of the session id, never the raw id. */
  sessions: Record<string, SessionBudget>;
  /** Hashed resource keys only; never raw URLs. */
  blockedResources: Record<string, BlockedResource>;
  health: PersistenceHealth;
  usage?: Record<string, UsageSnapshot>;
};

export type EventRecord = {
  schemaVersion: 1;
  ts: number;
  /** Truncated SHA-256 of the session id. */
  session: string;
  tool: string;
  provider: ProviderId;
  kind: RetrievalKind;
  outcome: "allowed" | "blocked" | "success" | "failure" | "unavailable";
  reason?: string;
  errorCategory?: ErrorCategory;
  latencyMs?: number;
  attempts: { search: number; read: number };
  note: "local_attempt_counts_not_vendor_billing";
};

export type SessionInfo = {
  id: string;
  parentID?: string;
  agent?: string;
};

export type SessionLookup = {
  get(sessionID: string): Promise<SessionInfo | undefined>;
};

export type RateLimitResult = {
  allowed: boolean;
  reason?: "minute" | "hour" | "day" | "persistence";
  retryAfterMs?: number;
  remaining: { minute: number; hour: number; day: number };
};

export type ProviderAvailability = {
  provider: ProviderId;
  available: boolean;
  reason?: PolicyReason;
  requiresOperator?: boolean;
  nextAvailable?: number;
  keyConfigured?: boolean;
  cost: CostClass;
  rateRemaining?: { minute: number; hour: number; day: number };
};

/** The TinyFish REST adapter only needs this narrow slice of the engine. */
export type TinyFishProviderBridge = {
  availability(): ProviderAvailability;
  consumeCall(): Promise<RateLimitResult>;
  recordFailure(
    category: ErrorCategory,
    retryAfterMs?: number,
    latencyMs?: number,
  ): Promise<void>;
  recordSuccess(latencyMs?: number): Promise<void>;
};
