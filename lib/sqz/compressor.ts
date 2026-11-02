/**
 * SQZ compressor orchestration.
 *
 * This module deliberately operates on *already captured* command output.
 * It never builds or rewrites a shell command: the `sqz` executable is
 * invoked directly with an argv array (`shell: false`), so neither the
 * command label nor the captured text can be interpreted as shell syntax.
 */

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";

export type SpawnOptions = {
  input: string;
  timeoutMs: number;
  cwd?: string;
};

export type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
};

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

export type CompressorSettings = {
  spawn: SpawnFn;
  /** Resolved via PATH by the OS; never hard-code a platform-specific path. */
  sqzPath?: string;
  timeoutMs?: number;
  minChars?: number;
  maxChars?: number;
  cwd?: string;
  /** Optional command label for SQZ statistics (`--cmd`). */
  label?: string;
};

export const DEFAULT_MIN_CHARS = 200;
export const DEFAULT_MAX_CHARS = 200_000;
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Shell-ish tools whose captured output may be compressed. */
const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "terminal",
  "run_shell_command",
  "powershell",
]);

/**
 * Output that already travelled through SQZ (or an equivalent compressor)
 * must not be compressed again.
 */
export const SQZ_MARKER_RE = /\[sqz\]|§ref:[0-9a-f]+|sqz(?:_ref|\.exe)?\s+compress/i;

const SOURCE_LINE_RE =
  /^(?:(?:import|export|from|const|let|var|function|class|interface|type|def|package|#include|using|namespace)\b.*|["'][^"']+["']\s*:.*|[A-Za-z_$][\w$]*\s*[:=]\s*.*|\/\/.*|\/\*.*|\*.*|<\/?[A-Za-z][^>]*>.*|[{}[\],;]+)$/;

/**
 * True when the output looks like raw source/configuration rather than
 * command output worth compressing. This is intentionally conservative:
 * misclassifying a log as source only skips a compression opportunity,
 * while compressing source/config can corrupt identifiers the agent needs.
 */
export function looksLikeSourceOrConfig(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 5) return false;
  const hits = lines.filter((line) => SOURCE_LINE_RE.test(line.trim())).length;
  return hits / lines.length >= 0.5;
}

export function isShellTool(tool: unknown): boolean {
  return typeof tool === "string" && SHELL_TOOLS.has(tool.toLowerCase());
}

/**
 * Extract the command name used for SQZ's `--cmd` statistics label.
 * Handles quoted paths, leading env assignments, and both POSIX (`/`)
 * and Windows (`\`) path separators. The returned value is only ever
 * passed as a separate argv item, never interpolated into a command.
 */
export function extractCommandLabel(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  const tokens = splitFirstTokens(trimmed);
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    // Skip leading shell env assignments (FOO=bar cmd ...).
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const name = token.split(/[\\/]/).pop() ?? "";
    const base = name.replace(/\.exe$/i, "");
    if (!base || base === "." || base === "..") return undefined;
    return base;
  }
  return undefined;
}

/**
 * Split off the leading tokens of a command, respecting simple single and
 * double quoting so `"/my tools/foo" --arg` yields `my tools/foo`.
 * We only need enough tokens to skip env assignments and find the command.
 */
function splitFirstTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
        if (tokens.length >= 8) break;
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Commands that must never trigger another compression pass. */
export function isCompressorCommand(label: string | undefined): boolean {
  if (!label) return false;
  const base = label.toLowerCase();
  return base === "sqz" || base === "sqz-mcp" || base === "sqz.exe";
}

export function isCompressibleText(
  text: unknown,
  options: Pick<CompressorSettings, "minChars" | "maxChars"> = {},
): text is string {
  if (typeof text !== "string") return false;
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const length = text.length;
  if (length < minChars || length > maxChars) return false;
  if (text.includes("\u0000")) return false;
  if (SQZ_MARKER_RE.test(text)) return false;

  const whitespaceRatio = (text.match(/\s/g)?.length ?? 0) / length;
  // A single line of cryptic identifiers is not usefully compressible.
  if (whitespaceRatio < 0.03) return false;
  if (!text.includes("\n") && whitespaceRatio < 0.08) return false;
  if (looksLikeSourceOrConfig(text)) return false;

  return true;
}

/**
 * Run `sqz compress --no-cache [--cmd label]` with the text on stdin.
 *
 * Returns `undefined` for every failure mode (missing binary, non-zero
 * exit, timeout, empty output, or an expansion) so the caller can keep
 * the original output untouched. `--no-cache` avoids emitting dedup
 * `§ref:` tokens and avoids persisting raw payloads in SQZ's cache.
 */
export async function compressText(
  text: string,
  settings: CompressorSettings,
): Promise<string | undefined> {
  const args = ["compress", "--no-cache"];
  if (settings.label) args.push("--cmd", settings.label);

  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<undefined>((resolveDeadline) => {
    deadline = setTimeout(() => resolveDeadline(undefined), timeoutMs);
  });

  let result: SpawnResult | undefined;
  try {
    // A custom/crashed process factory must never reject into the tool hook.
    result = await Promise.race([
      (async () =>
        settings.spawn(settings.sqzPath ?? "sqz", args, {
          input: text,
          timeoutMs,
          cwd: settings.cwd,
        }))(),
      hardDeadline,
    ]);
  } catch {
    return undefined;
  } finally {
    if (deadline) clearTimeout(deadline);
  }

  if (!result) return undefined;
  if (result.error || result.timedOut) return undefined;
  if (result.code !== 0) return undefined;
  const compressed = result.stdout;
  if (!compressed || compressed.trim().length === 0) return undefined;
  // Never expand or return something that is not smaller.
  if (compressed.length >= text.length) return undefined;
  if (SQZ_MARKER_RE.test(compressed)) return undefined;
  return compressed;
}

/** Gate + compress in one call. */
export async function maybeCompress(
  text: string,
  settings: CompressorSettings & { label?: string },
): Promise<string | undefined> {
  if (!isCompressibleText(text, settings)) return undefined;
  return compressText(text, settings);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Default process factory: argv-based, no shell, PATH-resolved binary.
 * Uses `spawn` (executable lookup) so `"sqz"` works on both Windows and
 * POSIX without hard-coding an installation path.
 */
export const defaultSpawn: SpawnFn = (file, args, options) =>
  new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;

    const noop = (): void => undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (!child) return;
      child.removeAllListeners("close");
      child.removeAllListeners("error");
      // Prevent a late kill/EPIPE/stream error from becoming an uncaught
      // EventEmitter error after the promise has already settled.
      child.on("error", noop);
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (!stream) continue;
        stream.removeAllListeners("data");
        stream.removeAllListeners("error");
        stream.on("error", noop);
        try {
          stream.destroy();
        } catch {
          // Stream teardown is best-effort.
        }
      }
    };

    const finish = (result: Pick<SpawnResult, "code" | "error">): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve({ ...result, stdout, stderr, timedOut });
    };

    try {
      child = spawnProcess(file, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: options.cwd,
      });
    } catch (error) {
      resolve({ code: null, stdout, stderr, error: asError(error) });
      return;
    }

    timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      // SIGKILL is not ignorable on POSIX and maps to TerminateProcess on
      // Windows. Kill hard, detach the child handle, and settle immediately:
      // a SIGTERM-ignoring process must not keep the agent hook pending.
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already reaped.
      }
      try {
        child?.unref();
      } catch {
        // Best-effort detach.
      }
      finish({
        code: null,
        error: new Error(`sqz timed out after ${options.timeoutMs}ms`),
      });
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish({ code: null, error: asError(error) }));
    child.on("close", (code) => finish({ code }));

    // A missing/closed compressor may make stdin fail; that is reported by
    // the process `error`/`close` handlers above, so ignore EPIPE here.
    child.stdin?.on("error", noop);
    try {
      child.stdin?.end(options.input, "utf8");
    } catch {
      // The process result still determines the fallback.
    }
  });
