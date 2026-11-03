import { describe, expect, test } from "bun:test";
import {
  defaultSpawn,
  extractCommandLabel,
  isCompressibleText,
  isCompressorCommand,
  isShellTool,
  maybeCompress,
  SQZ_MARKER_RE,
  type SpawnFn,
  type SpawnResult,
} from "../lib/sqz/compressor";
import {
  CONFIG_FIXTURE,
  CRYPTIC_IDENTIFIER_WALL,
  createMockSpawn,
  okResult,
  SAMPLE_COMMAND_OUTPUT,
  SOURCE_FIXTURE,
} from "../lib/sqz/testing";

const sqzOnPath = Bun.which("sqz");

describe("command label parsing (both slash styles)", () => {
  test("POSIX absolute path", () => {
    expect(extractCommandLabel("/usr/local/bin/git status --short")).toBe("git");
  });

  test("Windows absolute path with .exe", () => {
    expect(extractCommandLabel("C:\\Tools\\git.exe status --short")).toBe("git");
  });

  test("quoted Windows path with spaces", () => {
    expect(extractCommandLabel('"C:\\Program Files\\nvm\\node.exe" script.js')).toBe(
      "node",
    );
  });

  test("quoted POSIX path with spaces", () => {
    expect(extractCommandLabel('"/my tools/foo" --arg')).toBe("foo");
  });

  test("leading env assignments are skipped", () => {
    expect(extractCommandLabel("FOO=bar BAZ=qux /usr/bin/cargo test")).toBe("cargo");
  });

  test("multiline commands use the first command only", () => {
    expect(extractCommandLabel("git status\nrm -rf /tmp/example")).toBe("git");
  });

  test("blank/invalid commands yield no label", () => {
    expect(extractCommandLabel("   ")).toBeUndefined();
    expect(extractCommandLabel(undefined)).toBeUndefined();
  });
});

describe("tool and compressor guards", () => {
  test("only shell-ish tools are eligible", () => {
    expect(isShellTool("bash")).toBe(true);
    expect(isShellTool("SHELL")).toBe(true);
    expect(isShellTool("run_shell_command")).toBe(true);
    expect(isShellTool("read")).toBe(false);
    expect(isShellTool("sqz")).toBe(false);
  });

  test("sqz itself is never re-compressed", () => {
    expect(isCompressorCommand("sqz")).toBe(true);
    expect(isCompressorCommand("sqz-mcp")).toBe(true);
    expect(isCompressorCommand("git")).toBe(false);
    expect(isCompressorCommand(undefined)).toBe(false);
  });
});

describe("compressibility gate", () => {
  test("accepts ordinary command output", () => {
    expect(isCompressibleText(SAMPLE_COMMAND_OUTPUT)).toBe(true);
  });

  test("rejects short output", () => {
    expect(isCompressibleText("ok")).toBe(false);
  });

  test("rejects output already carrying SQZ markers", () => {
    expect(SQZ_MARKER_RE.test("[sqz] 27/181 tokens")).toBe(true);
    expect(isCompressibleText(`[sqz] 27/181 tokens\n${SAMPLE_COMMAND_OUTPUT}`)).toBe(
      false,
    );
    expect(isCompressibleText(`§ref:23b9d8633e40e416\n${SAMPLE_COMMAND_OUTPUT}`)).toBe(
      false,
    );
  });

  test("rejects raw source and configuration", () => {
    expect(isCompressibleText(SOURCE_FIXTURE)).toBe(false);
    expect(isCompressibleText(CONFIG_FIXTURE)).toBe(false);
  });

  test("rejects NUL-containing and oversized output", () => {
    expect(isCompressibleText(`${SAMPLE_COMMAND_OUTPUT}\u0000`)).toBe(false);
    expect(isCompressibleText("x".repeat(500), { maxChars: 100 })).toBe(false);
  });

  test("rejects a cryptic identifier wall above the minimum size", () => {
    expect(CRYPTIC_IDENTIFIER_WALL.length).toBeGreaterThan(200);
    expect(isCompressibleText(CRYPTIC_IDENTIFIER_WALL)).toBe(false);
  });
});

describe("maybeCompress process semantics", () => {
  test("passes argv (never a shell string) and disables SQZ caching", async () => {
    const mock = createMockSpawn(() => okResult("short compressed output"));
    const result = await maybeCompress(SAMPLE_COMMAND_OUTPUT, {
      spawn: mock.spawn,
      label: "git",
    });

    expect(result).toBe("short compressed output");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.file).toBe("sqz");
    expect(mock.calls[0]!.args).toEqual([
      "compress",
      "--no-cache",
      "--cmd",
      "git",
    ]);
    expect(mock.calls[0]!.options.input).toBe(SAMPLE_COMMAND_OUTPUT);
  });

  test("missing compressor falls back to the original", async () => {
    const mock = createMockSpawn(() => ({
      code: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn sqz ENOENT"), { code: "ENOENT" }),
    }));
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: mock.spawn }),
    ).toBeUndefined();
  });

  test("non-zero compressor exit falls back", async () => {
    const mock = createMockSpawn(() => okResult("short", { code: 2 }));
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: mock.spawn }),
    ).toBeUndefined();
  });

  test("timeout falls back", async () => {
    const mock = createMockSpawn(() => okResult("short", { timedOut: true }));
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: mock.spawn }),
    ).toBeUndefined();
  });

  test("rejected spawn promise falls back instead of crashing", async () => {
    const mock = createMockSpawn(async () => {
      throw new Error("spawn rejected");
    });
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: mock.spawn }),
    ).toBeUndefined();
  });

  test("synchronously throwing spawn falls back instead of crashing", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("spawn threw synchronously");
    };
    expect(await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn })).toBeUndefined();
  });

  test("a spawn promise that never settles is abandoned at the deadline", async () => {
    const mock = createMockSpawn(
      () => new Promise<SpawnResult>(() => undefined),
    );
    const started = Date.now();
    const result = await maybeCompress(SAMPLE_COMMAND_OUTPUT, {
      spawn: mock.spawn,
      timeoutMs: 50,
    });
    const elapsed = Date.now() - started;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(2_000);
  });

  test("empty result falls back", async () => {
    const mock = createMockSpawn(() => okResult(""));
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: mock.spawn }),
    ).toBeUndefined();
    const whitespace = createMockSpawn(() => okResult("   \n  "));
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: whitespace.spawn }),
    ).toBeUndefined();
  });

  test("expanded result falls back", async () => {
    const mock = createMockSpawn(() => okResult("x".repeat(10_000)));
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: mock.spawn }),
    ).toBeUndefined();
  });

  test("compressed output that is itself a SQZ marker falls back", async () => {
    const mock = createMockSpawn(() => okResult("[sqz] cached"));
    expect(
      await maybeCompress(SAMPLE_COMMAND_OUTPUT, { spawn: mock.spawn }),
    ).toBeUndefined();
  });

  test("gated input never invokes the compressor", async () => {
    const mock = createMockSpawn(() => okResult("nope"));
    expect(await maybeCompress("short", { spawn: mock.spawn })).toBeUndefined();
    expect(
      await maybeCompress(SOURCE_FIXTURE, { spawn: mock.spawn }),
    ).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });
});

describe("defaultSpawn real process factory", () => {
  test("actual success captures stdout and exit code 0", async () => {
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { input: "hello from stdin", timeoutMs: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
  });

  test("actual non-zero exit is reported verbatim", async () => {
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "process.stderr.write('boom'); process.exit(3)"],
      { input: "", timeoutMs: 10_000 },
    );
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("boom");
  });

  test("actual missing executable reports an error/fallback", async () => {
    const result = await defaultSpawn(
      "sqz-definitely-not-installed-7f3a1c",
      ["compress"],
      { input: "", timeoutMs: 5_000 },
    );
    expect(result.code).toBeNull();
    expect(result.error).toBeDefined();
  });

  test("actual timeout settles at the hard deadline", async () => {
    const started = Date.now();
    const result = await defaultSpawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { input: "", timeoutMs: 100 },
    );
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(result.error).toBeDefined();
    expect(elapsed).toBeLessThan(2_000);
  });

  test.skipIf(process.platform === "win32")(
    "actual SIGTERM-ignoring child still settles at the hard deadline",
    async () => {
      const started = Date.now();
      const result = await defaultSpawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ],
        { input: "", timeoutMs: 150 },
      );
      const elapsed = Date.now() - started;

      expect(result.timedOut).toBe(true);
      // Must not wait for close after a SIGTERM-ignoring child.
      expect(elapsed).toBeLessThan(2_000);
    },
  );

  test.skipIf(!sqzOnPath)(
    "PATH-resolved sqz runs directly without a shell wrapper",
    async () => {
      const result = await defaultSpawn("sqz", ["--version"], {
        input: "",
        timeoutMs: 10_000,
      });
      const combined = `${result.stdout}${result.stderr}`;

      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
      expect(combined).toMatch(/sqz\s+\d+\.\d+\.\d+/i);
      expect(combined.toLowerCase()).not.toContain("running scripts is disabled");
      expect(combined.toLowerCase()).not.toContain("cannot be loaded because");
    },
  );

  test.skipIf(!sqzOnPath)(
    "real PATH sqz compresses sample output through maybeCompress",
    async () => {
      const compressed = await maybeCompress(SAMPLE_COMMAND_OUTPUT, {
        spawn: defaultSpawn,
        label: "build",
        timeoutMs: 10_000,
      });

      expect(compressed).toBeDefined();
      expect(compressed!.length).toBeLessThan(SAMPLE_COMMAND_OUTPUT.length);
      expect(compressed).not.toContain("[sqz]");
      expect(compressed).not.toContain("§ref:");
    },
  );
});
