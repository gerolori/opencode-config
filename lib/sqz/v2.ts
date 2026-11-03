/**
 * SQZ 2.x (promise plugin API) after-hook handler.
 *
 * OpenCode 2.x's built-in `shell` tool returns a Tool.Result shaped like:
 *   {
 *     output: { output: string, truncated: boolean, exit?, signal?, timeout?, status? },
 *     content: [{ type: "text", text: output }, ...notice/file parts],
 *     metadata: { status, truncated, exit?, signal?, timeout?, shellID? }
 *   }
 *
 * The model reads `content`, so only that model-visible text is compressed.
 * The structured `output` and `metadata` (exit/signal/timeout/truncation)
 * are never modified. The shell command itself is never rewritten.
 */

import type { Tool } from "@opencode/schema/tool";
import {
  defaultSpawn,
  extractCommandLabel,
  isCompressorCommand,
  isShellTool,
  maybeCompress,
  type SpawnFn,
} from "./compressor";

/** Native Code Mode's outer tool. Its result aggregates leaf results. */
export const CODE_MODE_OUTER_TOOL = "execute";

const MAX_TRACKED_CALLS = 1024;

export type SqzAfterEvent = {
  readonly tool: string;
  readonly sessionID?: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly input?: unknown;
  readonly status: "completed" | "error";
  readonly result?: Tool.Result;
  readonly error?: Tool.Error;
};

export type SqzPluginSettings = {
  spawn: SpawnFn;
  sqzPath?: string;
  timeoutMs?: number;
  minChars?: number;
  maxChars?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Plugin options are deliberately plain JSON values in normal use. Tests may
 * provide an argv-only `spawn` factory through options to exercise the real
 * entrypoint without starting a process.
 */
export function settingsFromOptions(options: unknown): SqzPluginSettings {
  const value = isRecord(options) ? options : {};
  return {
    spawn:
      typeof value.spawn === "function" ? (value.spawn as SpawnFn) : defaultSpawn,
    sqzPath:
      typeof value.sqzPath === "string" && value.sqzPath.length > 0
        ? value.sqzPath
        : undefined,
    timeoutMs: positiveNumber(value.timeoutMs),
    minChars: positiveNumber(value.minChars),
    maxChars: positiveNumber(value.maxChars),
  };
}

function readCommand(input: unknown): string {
  if (!isRecord(input)) return "";
  return typeof input.command === "string" ? input.command : "";
}

/**
 * Detect SQZ anywhere in a command line, including pipelines and absolute
 * paths on either slash style. A false positive only skips compression.
 */
export function commandInvokesSqz(command: string): boolean {
  return /(?:^|[\s;&|()"'`\\/])sqz(?:-mcp)?(?:\.exe)?(?=\s|$)/i.test(command);
}

function hasErrorState(value: Record<string, unknown>): boolean {
  return (
    value.isError === true ||
    value.status === "error" ||
    value.error !== undefined
  );
}

/**
 * Refuse to touch any failure-shaped completion: non-zero exit, signal,
 * timeout, error, or running state. Metadata is never mutated either way.
 */
function isSuccessfulShellCompletion(result: Tool.Result): boolean {
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const output = isRecord(result.output) ? result.output : {};

  if (typeof metadata.exit === "number" && metadata.exit !== 0) return false;
  if (typeof output.exit === "number" && output.exit !== 0) return false;
  if (metadata.signal !== undefined || output.signal !== undefined) return false;
  if (metadata.timeout === true || output.timeout === true) return false;
  if (hasErrorState(metadata) || hasErrorState(output)) return false;

  const status = [metadata.status, output.status];
  if (status.includes("error") || status.includes("running")) return false;

  return true;
}

type MutableResultContent = {
  content?: string | Tool.Content[];
};

/**
 * Compress only the primary text content part (the captured output). Notice
 * text and file parts that follow are preserved byte-for-byte.
 */
async function compressModelVisibleContent(
  result: Tool.Result,
  label: string | undefined,
  settings: SqzPluginSettings,
): Promise<void> {
  const mutable = result as unknown as MutableResultContent;
  const content = mutable.content;

  if (typeof content === "string") {
    const compressed = await maybeCompress(content, { ...settings, label });
    if (compressed !== undefined) mutable.content = compressed;
    return;
  }

  if (!Array.isArray(content)) return;
  const index = content.findIndex((part) => part.type === "text");
  if (index < 0) return;

  const part = content[index];
  if (!part || part.type !== "text") return;

  const compressed = await maybeCompress(part.text, { ...settings, label });
  if (compressed === undefined) return;

  const next = content.slice();
  next[index] = { ...part, text: compressed };
  mutable.content = next;
}

/**
 * Build the `execute.after` callback used by the 2.x plugin entrypoint.
 *
 * Duplicate protection:
 * - the same result object is processed at most once;
 * - the same Tool.CallID is processed at most once (bounded memory);
 * - the native Code Mode outer `execute` tool is skipped entirely, so a leaf
 *   shell result cannot be compressed again when the outer result aggregates
 *   it.
 */
export function createSqzAfterHandler(options: unknown = {}) {
  const settings = settingsFromOptions(options);
  const seenResults = new WeakSet<object>();
  const seenCalls = new Set<string>();

  return async function handleAfter(event: SqzAfterEvent): Promise<void> {
    if (event.status !== "completed") return;
    if (event.tool === CODE_MODE_OUTER_TOOL) return;
    if (!isShellTool(event.tool)) return;

    const result = event.result;
    if (!result || typeof result !== "object") return;
    if (seenResults.has(result)) return;
    seenResults.add(result);

    const callID = typeof event.id === "string" ? event.id : undefined;
    if (callID !== undefined) {
      if (seenCalls.has(callID)) return;
      seenCalls.add(callID);
      if (seenCalls.size > MAX_TRACKED_CALLS) {
        const oldest = seenCalls.values().next().value;
        if (oldest !== undefined) seenCalls.delete(oldest);
      }
    }

    if (!isSuccessfulShellCompletion(result)) return;

    const command = readCommand(event.input);
    if (commandInvokesSqz(command)) return;
    const label = extractCommandLabel(command);
    if (isCompressorCommand(label)) return;

    try {
      await compressModelVisibleContent(result, label, settings);
    } catch {
      // Any unexpected compressor/content failure keeps the original result.
    }
  };
}
