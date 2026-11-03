import { normalizeToolName } from "./retrieval/catalog";

/**
 * Discovery budget for the bounded `explore` worker.
 *
 * This is a search/list-call budget, not a wall-clock timer. The plugin charges
 * one unit per leaf `execute.before` event. Code Mode leaves are intended to be
 * separate tool invocations even though they may share an outer call ID; actual
 * 2.2.5 leaf-hook emission remains unverified until a live smoke.
 */

export const DISCOVERY_DEFAULT_CALLS = 8;
export const DISCOVERY_DEFAULT_EXTENSION = 8;
export const DISCOVERY_MAX_EXTENSION = 32;
export const DISCOVERY_MAX_SESSIONS = 2_000;

const NATIVE_SEARCH_TOOLS = new Set(["glob", "grep"]);
const SQZ_SEARCH_TOOLS = new Set(["sqz_sqz_grep", "sqz_sqz_list_dir"]);
const SHELL_SEARCH_LIST =
  /^(ls|dir|gci|tree|find|fd|findstr|rg|grep|select-string|get-childitem)(\s|$)/i;

export type DiscoveryStatus = {
  limit: number;
  used: number;
  remaining: number;
  blocked: number;
  extended: boolean;
  extension_calls: number;
  /** Makes the unit explicit: calls, not elapsed time. */
  note: "local_search_list_calls_not_time";
};

export type DiscoveryDecision = {
  counted: boolean;
  allowed: boolean;
  reason?: "discovery_budget_exhausted";
  status: DiscoveryStatus;
};

export type DiscoveryExtensionResult =
  | { ok: true; status: DiscoveryStatus }
  | { ok: false; reason: "already_extended" | "invalid_extension"; status: DiscoveryStatus };

type Entry = {
  used: number;
  blocked: number;
  extended: boolean;
  extensionCalls: number;
  updatedAt: number;
};

export type DiscoveryBudgetOptions = {
  defaultLimit?: number;
  defaultExtension?: number;
  maxExtension?: number;
  maxSessions?: number;
  now?: () => number;
};

function shellCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.cmd;
  return typeof value === "string" ? value : undefined;
}

function shellSegments(command: string): string[] {
  return command
    .split(/[;&|\r\n]+/)
    .map((segment) => segment.trim().replace(/^\(+|\)+$/g, "").trim())
    .filter(Boolean);
}

/**
 * Count only calls that change discovery coverage: file/name search, directory
 * listing, and local semantic search. Reading a known file does not spend the
 * budget, because the objective is to stop repeated broad searching rather than
 * to cap evidence collection.
 *
 * Shell permission is evaluated before the tool hook. Commands that the explore
 * allowlist denies never reach this classifier; names here also count when they
 * run inside an allowed chain or multiline command.
 */
export function countsAsDiscoveryCall(tool: string, input: unknown): boolean {
  const name = normalizeToolName(tool);
  if (NATIVE_SEARCH_TOOLS.has(name) || SQZ_SEARCH_TOOLS.has(name)) return true;
  if (name.startsWith("semble_")) return true;
  if (name === "shell") {
    const command = shellCommand(input);
    if (!command) return false;
    return shellSegments(command).some((segment) => SHELL_SEARCH_LIST.test(segment));
  }
  return false;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export class DiscoveryBudget {
  private readonly entries = new Map<string, Entry>();
  private readonly defaultLimit: number;
  private readonly defaultExtension: number;
  private readonly maxExtension: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: DiscoveryBudgetOptions = {}) {
    this.defaultLimit = Math.max(1, clampInteger(options.defaultLimit, DISCOVERY_DEFAULT_CALLS, 1, 10_000));
    this.defaultExtension = Math.max(
      1,
      clampInteger(options.defaultExtension, DISCOVERY_DEFAULT_EXTENSION, 1, DISCOVERY_MAX_EXTENSION),
    );
    this.maxExtension = Math.max(
      this.defaultExtension,
      clampInteger(options.maxExtension, DISCOVERY_MAX_EXTENSION, 1, DISCOVERY_MAX_EXTENSION),
    );
    this.maxSessions = Math.max(1, clampInteger(options.maxSessions, DISCOVERY_MAX_SESSIONS, 1, 100_000));
    this.now = options.now ?? Date.now;
  }

  has(sessionID: string): boolean {
    return this.entries.has(sessionID);
  }

  status(sessionID: string): DiscoveryStatus {
    const entry = this.entries.get(sessionID);
    return this.statusOf(entry);
  }

  count(sessionID: string, tool: string, input: unknown): DiscoveryDecision {
    if (!countsAsDiscoveryCall(tool, input)) {
      return {
        counted: false,
        allowed: true,
        status: this.statusOf(this.entries.get(sessionID)),
      };
    }

    const entry = this.entry(sessionID);
    if (entry.used >= this.limitOf(entry)) {
      entry.blocked += 1;
      entry.updatedAt = this.now();
      return {
        counted: true,
        allowed: false,
        reason: "discovery_budget_exhausted",
        status: this.statusOf(entry),
      };
    }

    entry.used += 1;
    entry.updatedAt = this.now();
    return { counted: true, allowed: true, status: this.statusOf(entry) };
  }

  /**
   * One parent-approved extension. `extraCalls` is optional so a genuinely
   * larger assignment can ask for more than the default without inventing a
   * second extension path; it is clamped to the configured maximum.
   */
  extend(sessionID: string, extraCalls?: unknown): DiscoveryExtensionResult {
    const entry = this.entry(sessionID);
    if (entry.extended) {
      return { ok: false, reason: "already_extended", status: this.statusOf(entry) };
    }
    const extra = clampInteger(extraCalls, this.defaultExtension, 1, this.maxExtension);
    if (extra <= 0) {
      return { ok: false, reason: "invalid_extension", status: this.statusOf(entry) };
    }
    entry.extended = true;
    entry.extensionCalls = extra;
    entry.updatedAt = this.now();
    return { ok: true, status: this.statusOf(entry) };
  }

  private entry(sessionID: string): Entry {
    const existing = this.entries.get(sessionID);
    if (existing) return existing;
    const created: Entry = {
      used: 0,
      blocked: 0,
      extended: false,
      extensionCalls: 0,
      updatedAt: this.now(),
    };
    this.entries.set(sessionID, created);
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    return created;
  }

  private limitOf(entry: Entry): number {
    return this.defaultLimit + (entry.extended ? entry.extensionCalls : 0);
  }

  private statusOf(entry: Entry | undefined): DiscoveryStatus {
    const limit = entry ? this.limitOf(entry) : this.defaultLimit;
    const used = entry?.used ?? 0;
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      blocked: entry?.blocked ?? 0,
      extended: entry?.extended ?? false,
      extension_calls: entry?.extensionCalls ?? 0,
      note: "local_search_list_calls_not_time",
    };
  }
}
