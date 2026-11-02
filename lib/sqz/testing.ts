/** Cross-platform fixtures and a process-factory mock for SQZ tests. */

import type { SpawnFn, SpawnResult } from "./compressor";

export type MockCall = {
  file: string;
  args: string[];
  options: { input: string; timeoutMs: number; cwd?: string };
};

export type MockSpawn = {
  spawn: SpawnFn;
  calls: MockCall[];
};

export function createMockSpawn(
  handler: (call: MockCall, index: number) => SpawnResult | Promise<SpawnResult>,
): MockSpawn {
  const calls: MockCall[] = [];
  const spawn: SpawnFn = async (file, args, options) => {
    const call: MockCall = { file, args: [...args], options: { ...options } };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { spawn, calls };
}

export function okResult(stdout: string, overrides: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, stdout, stderr: "", ...overrides };
}

/** Comfortably above the default minimum and realistically compressible. */
export const SAMPLE_COMMAND_OUTPUT = Array.from(
  { length: 10 },
  (_, index) =>
    `2026-01-01T00:00:${String(index).padStart(2, "0")}Z INFO build step ${index} completed successfully in ${100 + index} ms`,
).join("\n");

/** Raw source: must not be sent through the output compressor. */
export const SOURCE_FIXTURE = [
  'import { readFile } from "node:fs/promises";',
  "",
  "export type Config = {",
  "  root: string;",
  "  retries: number;",
  "};",
  "",
  "export async function load(path: string): Promise<Config> {",
  '  const raw = await readFile(path, "utf8");',
  "  return JSON.parse(raw) as Config;",
  "}",
].join("\n");

/**
 * A cryptic identifier wall well above `DEFAULT_MIN_CHARS`, so tests exercise
 * the compressibility heuristic rather than the minimum-length guard.
 */
export const CRYPTIC_IDENTIFIER_WALL = Array.from(
  { length: 12 },
  (_, index) =>
    `aaaaaaaa.bbbbbbbb.cccccccc.dddddddd.eeeeeeee${String(index).padStart(2, "0")}`,
).join(" ");

/** Raw JSON configuration: also must be skipped. */
export const CONFIG_FIXTURE = JSON.stringify(
  {
    name: "example",
    version: "1.0.0",
    compilerOptions: { strict: true, target: "ESNext" },
    include: ["src/**/*.ts"],
  },
  null,
  2,
);
