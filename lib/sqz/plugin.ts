/**
 * SQZ plugin wiring.
 *
 * Compression happens in `tool.execute.after`, after the shell tool has
 * already run and captured its output. The original command, its exit
 * code, and its stdout/stderr metadata are therefore never touched.
 */

import type { Hooks, Plugin } from "@opencode-ai/plugin";
import {
  compressText,
  defaultSpawn,
  extractCommandLabel,
  isCompressibleText,
  isCompressorCommand,
  isShellTool,
  type SpawnFn,
} from "./compressor";

export type SqzPluginDeps = {
  spawn?: SpawnFn;
  sqzPath?: string;
  timeoutMs?: number;
  minChars?: number;
  maxChars?: number;
};

/**
 * True only for runtime failures that the host may still surface to the
 * after hook. Such output must stay verbatim; we never mutate error state.
 */
function hasErrorState(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const value = metadata as Record<string, unknown>;
  if (value.isError === true) return true;
  if (value.status === "error") return true;
  if (typeof value.error === "string" && value.error.length > 0) return true;
  if (value.error && typeof value.error === "object") return true;
  return false;
}

export function createSqzPlugin(deps: SqzPluginDeps = {}): Plugin {
  return async (): Promise<Hooks> => {
    const spawn = deps.spawn ?? defaultSpawn;

    return {
      "tool.execute.after": async (input, output) => {
        if (!isShellTool(input.tool)) return;
        if (!output || typeof output.output !== "string") return;
        if (hasErrorState(output.metadata)) return;

        // Read-only: the command label is only used for `--cmd` statistics.
        const command =
          typeof input.args?.command === "string" ? input.args.command : "";
        const label = extractCommandLabel(command);
        if (isCompressorCommand(label)) return;

        if (!isCompressibleText(output.output, deps)) return;

        const compressed = await compressText(output.output, {
          spawn,
          sqzPath: deps.sqzPath,
          timeoutMs: deps.timeoutMs,
          minChars: deps.minChars,
          maxChars: deps.maxChars,
          label,
        });

        // Missing compressor, error, timeout, empty result, or expansion:
        // keep the original output byte-for-byte.
        if (compressed === undefined) return;
        output.output = compressed;

        // `title` and `metadata` (including exitCode/stdout/stderr) are
        // intentionally left untouched.
      },
    };
  };
}
