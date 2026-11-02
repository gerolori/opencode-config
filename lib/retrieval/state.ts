import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { EventRecord, PersistentState, ProviderState, SessionBudget } from "./types";

export const SESSION_QUERY_TTL_MS = 24 * 60 * 60_000;
export const SESSION_RETRY_TTL_MS = 24 * 60 * 60_000;
export const MAX_SESSION_QUERY_ENTRIES = 32;
export const MAX_SESSION_RETRY_ENTRIES = 16;

export type StateFs = {
  mkdir(dir: string, opts?: { recursive?: boolean }): Promise<unknown>;
  rmdir(dir: string): Promise<unknown>;
  chmod?(file: string, mode: number): Promise<unknown>;
  stat?(file: string): Promise<{ mtimeMs: number; isDirectory(): boolean }>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
  appendFile(file: string, data: string): Promise<unknown>;
};

export const nodeStateFs: StateFs = {
  mkdir: (dir, opts) => fsp.mkdir(dir, { recursive: true, mode: 0o700, ...opts }),
  rmdir: (dir) => fsp.rmdir(dir),
  chmod: (file, mode) => fsp.chmod(file, mode),
  stat: async (file) => {
    const value = await fsp.stat(file);
    return { mtimeMs: value.mtimeMs, isDirectory: () => value.isDirectory() };
  },
  readFile: (file) => fsp.readFile(file, "utf8"),
  writeFile: (file, data) => fsp.writeFile(file, data, { encoding: "utf8", mode: 0o600 }),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (file) => fsp.unlink(file),
  appendFile: (file, data) => fsp.appendFile(file, data, { encoding: "utf8", mode: 0o600 }),
};

export const STATE_SCHEMA_VERSION = 1 as const;
export const CORRUPT_DEGRADE_MS = 5 * 60_000;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_MAX_EVENT_LINES = 2_000;
const DEFAULT_MAX_BLOCKED_RESOURCES = 200;

export function resolveStateDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, "opencode", "retrieval");
  return path.join(home, ".local", "share", "opencode", "retrieval");
}

export function defaultState(now: number): PersistentState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: now,
    providers: {},
    sessions: {},
    blockedResources: {},
    health: {},
    usage: {},
  };
}

export function defaultProviderState(): ProviderState {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
  };
}

export type StateStoreOptions = {
  dir: string;
  fs?: StateFs;
  now?: () => number;
  maxSessions?: number;
  maxEventLines?: number;
  lockWaitMs?: number;
  lockStaleMs?: number;
  lockPollMs?: number;
};

export class StateLockTimeoutError extends Error {
  constructor(message = "state lock timeout") {
    super(message);
    this.name = "StateLockTimeoutError";
  }
}

type LockHandle = { release(): Promise<void> };
type LockOwner = { nonce?: string; pid?: number; createdAt?: number };

/**
 * Metadata-only state store.
 *
 * Every read-modify-write goes through `transaction()`: acquire an advisory
 * lock directory, reload the latest document from disk, mutate, save, release.
 * A bounded lock wait fails closed. Temp-file + rename keeps the JSON document
 * whole even if a process dies mid-write.
 */
export class StateStore {
  readonly dir: string;
  readonly statePath: string;
  readonly eventsPath: string;
  private readonly lockDir: string;
  private readonly lockOwnerPath: string;
  private readonly fs: StateFs;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxEventLines: number;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;
  private readonly lockPollMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private eventLines = 0;
  private tempCounter = 0;
  lastPersistError?: string;

  constructor(options: StateStoreOptions) {
    this.dir = options.dir;
    this.statePath = path.join(options.dir, "state.json");
    this.eventsPath = path.join(options.dir, "events.jsonl");
    this.lockDir = path.join(options.dir, ".state.lock.d");
    this.lockOwnerPath = path.join(this.lockDir, "owner.json");
    this.fs = options.fs ?? nodeStateFs;
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxEventLines = options.maxEventLines ?? DEFAULT_MAX_EVENT_LINES;
    this.lockWaitMs = options.lockWaitMs ?? 3_000;
    this.lockStaleMs = options.lockStaleMs ?? 10_000;
    this.lockPollMs = options.lockPollMs ?? 25;
  }

  async load(): Promise<PersistentState> {
    await this.ensureDir();
    await this.countEventLines();
    return this.transaction((state) => state, { write: false });
  }

  /**
   * Cross-process read-modify-write. The callback receives the freshly loaded
   * document; it may call `saveDirect()` for intermediate writes. One final
   * write is performed unless `write:false` is requested.
   */
  async transaction<T>(
    fn: (state: PersistentState) => Promise<T> | T,
    options: { write?: boolean } = {},
  ): Promise<T> {
    await this.ensureDir();
    const lock = await this.acquireLock();
    try {
      const fresh = await this.readStateUnlocked();
      const result = await fn(fresh);
      if (options.write !== false) await this.saveDirect(fresh);
      return result;
    } finally {
      await lock.release();
    }
  }

  async save(state: PersistentState): Promise<void> {
    await this.ensureDir();
    const lock = await this.acquireLock();
    try {
      await this.saveDirect(state);
    } finally {
      await lock.release();
    }
  }

  async saveDirect(state: PersistentState): Promise<void> {
    const sanitized = sanitizeState(state, this.now(), this.maxSessions);
    await this.enqueue(async () => {
      try {
        await this.writeAtomic(sanitized);
        this.lastPersistError = undefined;
      } catch (error) {
        this.lastPersistError = errorText(error);
        throw error;
      }
    });
  }

  /**
   * Append one metadata-only event. Engine callers invoke this while already
   * holding the transaction lock, so trimming cannot race another writer.
   */
  async appendEvent(record: EventRecord): Promise<void> {
    await this.enqueue(async () => {
      try {
        if (this.eventLines >= this.maxEventLines) {
          await this.trimEvents();
        }
        await this.fs.appendFile(this.eventsPath, `${JSON.stringify(record)}\n`);
        this.eventLines += 1;
        await this.chmodQuiet(this.eventsPath, 0o600);
      } catch (error) {
        this.lastPersistError = errorText(error);
        throw error;
      }
    });
  }

  async readEvents(): Promise<string> {
    try {
      return await this.fs.readFile(this.eventsPath);
    } catch (error) {
      if (isNotFound(error)) return "";
      throw error;
    }
  }

  private async ensureDir(): Promise<void> {
    await this.fs.mkdir(this.dir, { recursive: true });
    await this.chmodQuiet(this.dir, 0o700);
  }

  private async chmodQuiet(file: string, mode: number): Promise<void> {
    if (!this.fs.chmod) return;
    try {
      await this.fs.chmod(file, mode);
    } catch {
      // Windows or filesystems without POSIX modes.
    }
  }

  private async countEventLines(): Promise<void> {
    try {
      const text = await this.fs.readFile(this.eventsPath);
      this.eventLines = text.length === 0 ? 0 : text.split("\n").filter(Boolean).length;
    } catch (error) {
      if (isNotFound(error)) {
        this.eventLines = 0;
        return;
      }
      throw error;
    }
  }

  private async readStateUnlocked(): Promise<PersistentState> {
    let raw: string | undefined;
    try {
      raw = await this.fs.readFile(this.statePath);
    } catch (error) {
      if (isNotFound(error)) return defaultState(this.now());
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistentState>;
      return normalizeState(parsed);
    } catch {
      const stamp = this.now();
      const quarantine = path.join(this.dir, `state.corrupt.${stamp}.json`);
      try {
        await this.fs.rename(this.statePath, quarantine);
      } catch {
        // Leave it in place; a successful save below will replace it.
      }
      const state = defaultState(stamp);
      state.health = {
        degradedUntil: stamp + CORRUPT_DEGRADE_MS,
        reason: "state_corrupt",
      };
      try {
        await this.writeAtomic(state);
      } catch (error) {
        this.lastPersistError = errorText(error);
        state.health.persistenceFailed = true;
        state.health.lastError = this.lastPersistError;
      }
      return state;
    }
  }

  private async trimEvents(): Promise<void> {
    const text = await this.readEvents();
    const lines = text.split("\n").filter(Boolean);
    const keep = lines.slice(Math.max(0, lines.length - Math.floor(this.maxEventLines / 2)));
    const next = keep.length > 0 ? `${keep.join("\n")}\n` : "";
    const temp = this.tempPath();
    await this.fs.writeFile(temp, next);
    await this.replace(temp, this.eventsPath);
    await this.chmodQuiet(this.eventsPath, 0o600);
    this.eventLines = keep.length;
  }

  private async writeAtomic(state: PersistentState): Promise<void> {
    const temp = this.tempPath();
    await this.fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
    await this.chmodQuiet(temp, 0o600);
    await this.replace(temp, this.statePath);
    await this.chmodQuiet(this.statePath, 0o600);
  }

  private async replace(temp: string, target: string): Promise<void> {
    try {
      await this.fs.rename(temp, target);
    } catch {
      // Windows does not always allow replacing an existing destination.
      try {
        await this.fs.unlink(target);
      } catch {
        // ignore: target may not exist
      }
      await this.fs.rename(temp, target);
    }
  }

  private async acquireLock(): Promise<LockHandle> {
    const nonce = randomUUID();
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        await this.fs.mkdir(this.lockDir, { recursive: false });
        try {
          await this.fs.writeFile(
            this.lockOwnerPath,
            JSON.stringify({ nonce, pid: process.pid, createdAt: Date.now() }),
          );
        } catch (error) {
          await this.forceRemoveLock();
          throw error;
        }
        return {
          release: async () => {
            await this.releaseLock(nonce);
          },
        };
      } catch (error) {
        if (!isExist(error)) throw error;
        if (await this.breakStaleLock()) continue;
        if (Date.now() >= deadline) throw new StateLockTimeoutError();
        await sleep(this.lockPollMs);
      }
    }
  }

  private async breakStaleLock(): Promise<boolean> {
    const owner = await this.readLockOwner();
    const age = await this.lockAgeMs(owner);
    if (age === undefined || age < this.lockStaleMs) return false;
    // A live owner is never stolen, even if its timestamp is old (pause,
    // debugger, suspended VM, etc.).
    if (owner?.pid !== undefined && isProcessAlive(owner.pid)) return false;
    const confirm = await this.readLockOwner();
    if ((owner?.nonce ?? null) !== (confirm?.nonce ?? null)) return false;
    return this.forceRemoveLock(owner?.nonce ?? null);
  }

  private async readLockOwner(): Promise<LockOwner | undefined> {
    try {
      const text = await this.fs.readFile(this.lockOwnerPath);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return {
        nonce: typeof parsed.nonce === "string" ? parsed.nonce : undefined,
        pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
          ? parsed.pid
          : undefined,
        createdAt: typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)
          ? parsed.createdAt
          : undefined,
      };
    } catch {
      return undefined;
    }
  }

  private async lockAgeMs(owner: LockOwner | undefined): Promise<number | undefined> {
    if (owner?.createdAt !== undefined) {
      return Date.now() - owner.createdAt;
    }
    if (this.fs.stat) {
      try {
        const info = await this.fs.stat(this.lockDir);
        if (info.isDirectory()) return Date.now() - info.mtimeMs;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async releaseLock(nonce: string): Promise<void> {
    const owner = await this.readLockOwner();
    if (!owner || owner.nonce !== nonce) return;
    await this.forceRemoveLock(nonce);
  }

  private async forceRemoveLock(expectedNonce?: string | null): Promise<boolean> {
    if (expectedNonce !== undefined) {
      const owner = await this.readLockOwner();
      if ((owner?.nonce ?? null) !== expectedNonce) return false;
    }
    let removed = true;
    try {
      await this.fs.unlink(this.lockOwnerPath);
    } catch (error) {
      if (!isNotFound(error)) removed = false;
    }
    try {
      await this.fs.rmdir(this.lockDir);
    } catch (error) {
      if (!isNotFound(error)) removed = false;
    }
    return removed;
  }

  private tempPath(): string {
    this.tempCounter += 1;
    return path.join(this.dir, `.state.${process.pid}.${this.tempCounter}.tmp`);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function normalizeState(parsed: Partial<PersistentState>): PersistentState {
  if (!parsed || typeof parsed !== "object") throw new Error("invalid state");
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) throw new Error("unsupported schema");
  const now = Date.now();
  const state: PersistentState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
    providers: isRecord(parsed.providers) ? parsed.providers as Record<string, ProviderState> : {},
    sessions: isRecord(parsed.sessions) ? parsed.sessions : {},
    blockedResources: isRecord(parsed.blockedResources) ? parsed.blockedResources : {},
    health: isRecord(parsed.health) ? parsed.health : {},
    usage: isRecord(parsed.usage) ? parsed.usage : {},
  };
  for (const [key, provider] of Object.entries(state.providers)) {
    if (!isRecord(provider)) {
      delete state.providers[key];
      continue;
    }
    state.providers[key] = { ...defaultProviderState(), ...provider };
  }
  return state;
}

export function sanitizeState(
  state: PersistentState,
  now: number,
  maxSessions: number,
): PersistentState {
  state.schemaVersion = STATE_SCHEMA_VERSION;
  state.updatedAt = now;
  if (!isRecord(state.health)) state.health = {};
  if (!isRecord(state.providers)) state.providers = {};
  if (!isRecord(state.sessions)) state.sessions = {};
  if (!isRecord(state.blockedResources)) state.blockedResources = {};
  if (!isRecord(state.usage)) state.usage = {};
  pruneByUpdatedAt(state.sessions, maxSessions);
  pruneByUpdatedAt(state.usage ?? {}, maxSessions);
  pruneSessionGovernance(state.sessions, now);
  pruneBlockedResources(state.blockedResources, now, DEFAULT_MAX_BLOCKED_RESOURCES);
  return state;
}

function pruneSessionGovernance(
  sessions: Record<string, SessionBudget>,
  now: number,
): void {
  for (const budget of Object.values(sessions)) {
    if (!budget || typeof budget !== "object" || Array.isArray(budget)) continue;

    const queryProviders =
      budget.queryProviders &&
      typeof budget.queryProviders === "object" &&
      !Array.isArray(budget.queryProviders)
        ? budget.queryProviders
        : {};
    for (const [key, entry] of Object.entries(queryProviders)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !Array.isArray(entry.providers) ||
        typeof entry.updatedAt !== "number" ||
        now - entry.updatedAt > SESSION_QUERY_TTL_MS
      ) {
        delete queryProviders[key];
      }
    }
    const queryKeys = Object.keys(queryProviders);
    if (queryKeys.length > MAX_SESSION_QUERY_ENTRIES) {
      queryKeys.sort((a, b) => queryProviders[a].updatedAt - queryProviders[b].updatedAt);
      for (const key of queryKeys.slice(0, queryKeys.length - MAX_SESSION_QUERY_ENTRIES)) {
        delete queryProviders[key];
      }
    }
    budget.queryProviders = queryProviders;

    const retries =
      budget.retries && typeof budget.retries === "object" && !Array.isArray(budget.retries)
        ? budget.retries
        : {};
    for (const [key, entry] of Object.entries(retries)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.at !== "number" ||
        now - entry.at > SESSION_RETRY_TTL_MS
      ) {
        delete retries[key];
      }
    }
    const retryKeys = Object.keys(retries);
    if (retryKeys.length > MAX_SESSION_RETRY_ENTRIES) {
      retryKeys.sort((a, b) => retries[a].at - retries[b].at);
      for (const key of retryKeys.slice(0, retryKeys.length - MAX_SESSION_RETRY_ENTRIES)) {
        delete retries[key];
      }
    }
    budget.retries = retries;
  }
}

function pruneBlockedResources(
  resources: Record<string, { until?: number; createdAt?: number }>,
  now: number,
  max: number,
): void {
  for (const [key, value] of Object.entries(resources)) {
    if (!value || (typeof value.until === "number" && value.until <= now)) {
      delete resources[key];
    }
  }
  const keys = Object.keys(resources);
  if (keys.length <= max) return;
  keys.sort((a, b) => (resources[a]?.createdAt ?? 0) - (resources[b]?.createdAt ?? 0));
  for (const key of keys.slice(0, keys.length - max)) delete resources[key];
}

function pruneByUpdatedAt<T extends { updatedAt?: number; createdAt?: number }>(
  record: Record<string, T>,
  max: number,
): void {
  const keys = Object.keys(record);
  if (keys.length <= max) return;
  keys.sort((a, b) => {
    const ta = record[a]?.updatedAt ?? record[a]?.createdAt ?? 0;
    const tb = record[b]?.updatedAt ?? record[b]?.createdAt ?? 0;
    return ta - tb;
  });
  for (const key of keys.slice(0, keys.length - max)) delete record[key];
}

function isRecord(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isExist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "EEXIST"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: string }).code
        : undefined;
    if (code === "ESRCH" || code === "EINVAL") return false;
    // EPERM and unknown platform errors mean "do not steal".
    return true;
  }
}
