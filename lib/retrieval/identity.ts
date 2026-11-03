import { hashKey } from "./catalog";

type Invocation = { token: string; createdAt: number };

export type InvocationIdentityOptions = {
  now?: () => number;
  ttlMs?: number;
  maxBases?: number;
  maxQueueLength?: number;
};

/**
 * Maps the shared 2.2.5 outer Code Mode call ID to a privacy-safe, ordered
 * per-invocation token. Normal Code Mode leaves reuse the outer context ID, so
 * the adapter must add identity without mutating tool arguments.
 */
export class InvocationIdentity {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBases: number;
  private readonly maxQueueLength: number;
  private readonly queues = new Map<string, Invocation[]>();
  private readonly baseScopes = new Map<string, string>();
  private readonly scopes = new Map<string, Set<string>>();
  private sequence = 0;

  constructor(options: InvocationIdentityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.maxBases = options.maxBases ?? 2_000;
    this.maxQueueLength = options.maxQueueLength ?? 64;
  }

  begin(sessionID: string, outerID: string, tool: string, input: unknown): string {
    const now = this.now();
    this.prune(now);
    const base = this.base(sessionID, outerID, tool, input);
    const scope = scopeKey(sessionID, outerID);
    let queue = this.queues.get(base);
    if (!queue) {
      queue = [];
      this.queues.set(base, queue);
      this.baseScopes.set(base, scope);
      let bases = this.scopes.get(scope);
      if (!bases) {
        bases = new Set();
        this.scopes.set(scope, bases);
      }
      bases.add(base);
      while (this.queues.size > this.maxBases) {
        const oldest = this.queues.keys().next().value;
        if (typeof oldest !== "string") break;
        this.queues.delete(oldest);
        this.forgetBase(oldest);
      }
    }
    this.sequence += 1;
    const token = `${base}:${this.sequence}`;
    queue.push({ token, createdAt: now });
    while (queue.length > this.maxQueueLength) queue.shift();
    return token;
  }

  complete(sessionID: string, outerID: string, tool: string, input: unknown): string | undefined {
    this.prune(this.now());
    const base = this.base(sessionID, outerID, tool, input);
    const queue = this.queues.get(base);
    if (!queue || queue.length === 0) return undefined;
    const next = queue.shift();
    if (queue.length === 0) {
      this.queues.delete(base);
      this.forgetBase(base);
    }
    return next?.token;
  }

  /**
   * Stable per-input identity for a pending permission request. The hash lets
   * the plugin remember a rejection without retaining raw tool input.
   */
  fingerprint(sessionID: string, outerID: string, tool: string, input: unknown): string {
    return this.base(sessionID, outerID, tool, input);
  }

  /** First pending token for this exact invocation identity (symmetric FIFO). */
  peek(sessionID: string, outerID: string, tool: string, input: unknown): string | undefined {
    this.prune(this.now());
    return this.queues.get(this.base(sessionID, outerID, tool, input))?.[0]?.token;
  }

  /** Abandon the first pending token for this exact identity, leaving siblings. */
  abandonMatching(
    sessionID: string,
    outerID: string,
    tool: string,
    input: unknown,
  ): string | undefined {
    const token = this.peek(sessionID, outerID, tool, input);
    if (token) this.abandon(token);
    return token;
  }

  abandon(token: string): void {
    const separator = token.lastIndexOf(":");
    if (separator <= 0) return;
    const base = token.slice(0, separator);
    const queue = this.queues.get(base);
    if (!queue) return;
    const index = queue.findIndex((entry) => entry.token === token);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(base);
      this.forgetBase(base);
    }
  }

  /** Drop every outstanding invocation belonging to one outer Code Mode ID. */
  abandonOuter(sessionID: string, outerID: string): string[] {
    const scope = scopeKey(sessionID, outerID);
    const bases = this.scopes.get(scope);
    if (!bases) return [];
    const tokens: string[] = [];
    for (const base of bases) {
      const queue = this.queues.get(base);
      if (queue) {
        for (const entry of queue) tokens.push(entry.token);
        this.queues.delete(base);
      }
      this.baseScopes.delete(base);
    }
    this.scopes.delete(scope);
    return tokens;
  }

  private forgetBase(base: string): void {
    const scope = this.baseScopes.get(base);
    if (!scope) return;
    this.baseScopes.delete(base);
    const bases = this.scopes.get(scope);
    if (!bases) return;
    bases.delete(base);
    if (bases.size === 0) this.scopes.delete(scope);
  }

  private base(sessionID: string, outerID: string, tool: string, input: unknown): string {
    let canonical: string;
    try {
      canonical = canonicalInput(input);
    } catch {
      canonical = "unserializable";
    }
    return hashKey(`invocation|${sessionID}|${outerID}|${tool}|${canonical}`);
  }

  private prune(now: number): void {
    for (const [base, queue] of this.queues) {
      const keep = queue.filter((entry) => now - entry.createdAt <= this.ttlMs);
      if (keep.length === 0) {
        this.queues.delete(base);
        this.forgetBase(base);
      } else if (keep.length !== queue.length) {
        this.queues.set(base, keep);
      }
    }
  }
}

function scopeKey(sessionID: string, outerID: string): string {
  return hashKey(`scope|${sessionID}|${outerID}`);
}

function canonicalInput(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalInput(record[key])}`)
      .join(",")}}`;
  }
  return String(value);
}
