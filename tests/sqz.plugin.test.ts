import { describe, expect, test } from "bun:test";
import type { Hooks } from "@opencode-ai/plugin";
import pluginModule, * as moduleNamespace from "../plugins/sqz";
import { createSqzPlugin } from "../lib/sqz/plugin";
import { createMockSpawn, okResult, SAMPLE_COMMAND_OUTPUT } from "../lib/sqz/testing";

type AfterHook = NonNullable<Hooks["tool.execute.after"]>;

async function makeHooks(
  handler: Parameters<typeof createMockSpawn>[0],
): Promise<{ hooks: Hooks; mock: ReturnType<typeof createMockSpawn> }> {
  const mock = createMockSpawn(handler);
  const factory = createSqzPlugin({ spawn: mock.spawn });
  const hooks = await factory({} as never);
  return { hooks, mock };
}

function afterOf(hooks: Hooks): AfterHook {
  const hook = hooks["tool.execute.after"];
  if (!hook) throw new Error("tool.execute.after hook missing");
  return hook;
}

function call(
  hook: AfterHook,
  command: string,
  output: { title: string; output: string; metadata: any },
  args: Record<string, unknown> = { command },
  tool = "bash",
): Promise<void> {
  return hook(
    { tool, sessionID: "ses_1", callID: "call_1", args },
    output,
  );
}

const COMPRESSED = "short compressed command output";
const sqzOnPath = Bun.which("sqz");

describe("plugin entrypoint shape", () => {
  test("exactly one default plugin export and no duplicate entrypoint", () => {
    expect(Object.keys(moduleNamespace).sort()).toEqual(["default"]);
    expect(pluginModule.id).toBe("sqz");
    expect(typeof pluginModule.server).toBe("function");
  });

  test("registers a single after hook and no before hook", async () => {
    const { hooks } = await makeHooks(() => okResult(COMPRESSED));
    expect(Object.keys(hooks)).toEqual(["tool.execute.after"]);
    expect("tool.execute.before" in hooks).toBe(false);
  });
});

describe("successful shell output", () => {
  test("replaces only output; title, metadata, args and exit code survive", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const metadata = { exitCode: 0, stdout: "raw stdout", stderr: "" };
    const args = { command: "git status" };
    const argsSnapshot = JSON.parse(JSON.stringify(args));
    const output = { title: "git status", output: SAMPLE_COMMAND_OUTPUT, metadata };

    await call(afterOf(hooks), "git status", output, args);

    expect(output.output).toBe(COMPRESSED);
    expect(output.title).toBe("git status");
    expect(output.metadata).toBe(metadata);
    expect(output.metadata).toEqual({ exitCode: 0, stdout: "raw stdout", stderr: "" });
    expect(args).toEqual(argsSnapshot);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.file).toBe("sqz");
    expect(mock.calls[0]!.args).toEqual([
      "compress",
      "--no-cache",
      "--cmd",
      "git",
    ]);
  });

  test("non-zero exit still compresses output and preserves exit metadata", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const metadata = { exitCode: 1, stdout: "raw stdout", stderr: "command failed" };
    const output = {
      title: "cargo test",
      output: SAMPLE_COMMAND_OUTPUT,
      metadata,
    };

    await call(afterOf(hooks), "cargo test", output);

    expect(output.output).toBe(COMPRESSED);
    expect(output.metadata).toBe(metadata);
    expect(output.metadata).toEqual({
      exitCode: 1,
      stdout: "raw stdout",
      stderr: "command failed",
    });
    expect(mock.calls[0]!.args).toContain("cargo");
  });

  test("multiline commands are never mutated", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const command = "echo one\necho two\nif ($?) { echo three }";
    const args = { command };
    const argsSnapshot = JSON.parse(JSON.stringify(args));
    const metadata = { exitCode: 0 };
    const output = { title: "multi", output: SAMPLE_COMMAND_OUTPUT, metadata };

    await call(afterOf(hooks), command, output, args);

    expect(args).toEqual(argsSnapshot);
    expect(args.command).toBe(command);
    expect(output.metadata).toBe(metadata);
    expect(output.output).toBe(COMPRESSED);
    expect(mock.calls).toHaveLength(1);
  });

  test("Windows and POSIX executable paths both yield portable labels", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    await call(
      afterOf(hooks),
      "C:\\Tools\\git.exe status",
      { title: "win", output: SAMPLE_COMMAND_OUTPUT, metadata: {} },
      { command: "C:\\Tools\\git.exe status" },
    );
    await call(
      afterOf(hooks),
      "/usr/bin/node script.js",
      { title: "posix", output: SAMPLE_COMMAND_OUTPUT, metadata: {} },
      { command: "/usr/bin/node script.js" },
    );

    expect(mock.calls.map((entry) => entry.args.at(-1))).toEqual(["git", "node"]);
  });
});

describe("fallbacks leave original output untouched", () => {
  const cases: Array<[string, () => ReturnType<typeof okResult>]> = [
    [
      "missing compressor",
      () => ({
        code: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn sqz ENOENT"), { code: "ENOENT" }),
      }),
    ],
    ["compressor failure", () => okResult("tiny", { code: 1 })],
    ["timeout", () => okResult("tiny", { timedOut: true })],
    ["empty result", () => okResult("")],
    ["whitespace result", () => okResult("  \n ")],
    ["longer result", () => okResult(SAMPLE_COMMAND_OUTPUT + SAMPLE_COMMAND_OUTPUT)],
    ["SQZ-marker result", () => okResult("[sqz] 1/2 tokens")],
  ];

  for (const [name, handler] of cases) {
    test(name, async () => {
      const { hooks } = await makeHooks(handler);
      const metadata = { exitCode: 0, stdout: "raw" };
      const output = { title: "git log", output: SAMPLE_COMMAND_OUTPUT, metadata };

      await call(afterOf(hooks), "git log", output);

      expect(output.output).toBe(SAMPLE_COMMAND_OUTPUT);
      expect(output.title).toBe("git log");
      expect(output.metadata).toBe(metadata);
    });
  }
});

describe("duplicate application guards", () => {
  test("output already containing a SQZ marker is not compressed again", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const already = `[sqz] 27/181 tokens (85% reduction)\n${SAMPLE_COMMAND_OUTPUT}`;
    const output = { title: "x", output: already, metadata: { exitCode: 0 } };

    await call(afterOf(hooks), "git log", output);

    expect(output.output).toBe(already);
    expect(mock.calls).toHaveLength(0);
  });

  test("MCP sqz / non-shell tools are not touched", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const output = {
      title: "sqz",
      output: SAMPLE_COMMAND_OUTPUT,
      metadata: { exitCode: 0 },
    };

    await call(afterOf(hooks), "compress", output, { command: "compress" }, "sqz");
    await call(afterOf(hooks), "read", output, { filePath: "x" }, "read");

    expect(mock.calls).toHaveLength(0);
    expect(output.output).toBe(SAMPLE_COMMAND_OUTPUT);
  });

  test("a shell command that is sqz itself is skipped", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const output = {
      title: "sqz",
      output: SAMPLE_COMMAND_OUTPUT,
      metadata: { exitCode: 0 },
    };

    await call(afterOf(hooks), "sqz compress --cmd git", output);

    expect(mock.calls).toHaveLength(0);
    expect(output.output).toBe(SAMPLE_COMMAND_OUTPUT);
  });

  test("raw source/config shell output is skipped", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const output = {
      title: "cat src.ts",
      output: 'import { x } from "y";\n\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n',
      metadata: { exitCode: 0 },
    };

    await call(afterOf(hooks), "cat src.ts", output);

    expect(mock.calls).toHaveLength(0);
    expect(output.output).toContain("import");
  });
});

describe("default plugin hook integration", () => {
  test.skipIf(!sqzOnPath)(
    "real PATH sqz compresses captured output and preserves nonzero metadata",
    async () => {
      const hooks = await pluginModule.server({} as never);
      const after = afterOf(hooks);
      const metadata = {
        exitCode: 1,
        stdout: "raw stdout payload",
        stderr: "raw stderr payload",
      };
      const args = { command: "git log --oneline" };
      const output = {
        title: "git log --oneline",
        output: SAMPLE_COMMAND_OUTPUT,
        metadata,
      };

      await call(after, "git log --oneline", output, args);

      expect(output.output.length).toBeLessThan(SAMPLE_COMMAND_OUTPUT.length);
      expect(output.output).not.toContain("[sqz]");
      expect(output.output).not.toContain("§ref:");
      expect(output.title).toBe("git log --oneline");
      expect(output.metadata).toBe(metadata);
      expect(output.metadata).toEqual({
        exitCode: 1,
        stdout: "raw stdout payload",
        stderr: "raw stderr payload",
      });
      expect(args).toEqual({ command: "git log --oneline" });
    },
  );

  test.skipIf(!sqzOnPath)(
    "real PATH sqz skips output that already carries a SQZ marker",
    async () => {
      const hooks = await pluginModule.server({} as never);
      const after = afterOf(hooks);
      const already = `[sqz] 27/181 tokens\n${SAMPLE_COMMAND_OUTPUT}`;
      const output = { title: "x", output: already, metadata: { exitCode: 0 } };

      await call(after, "git log", output);

      expect(output.output).toBe(already);
    },
  );
});

describe("runtime failed tools", () => {
  test("error metadata is preserved verbatim and never compressed", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const metadata = { isError: true, error: "boom", exitCode: 1 };
    const output = { title: "failed", output: "boom", metadata };

    await call(afterOf(hooks), "false", output);

    expect(output.output).toBe("boom");
    expect(output.metadata).toBe(metadata);
    expect(output.metadata).toEqual({ isError: true, error: "boom", exitCode: 1 });
    expect(mock.calls).toHaveLength(0);
  });

  test("non-string output is ignored", async () => {
    const { hooks, mock } = await makeHooks(() => okResult(COMPRESSED));
    const output = { title: "x", output: undefined as unknown as string, metadata: {} };

    await call(afterOf(hooks), "git log", output);

    expect(output.output).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });
});
