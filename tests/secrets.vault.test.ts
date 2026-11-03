import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServiceEnv,
  buildSopsEnv,
  decryptVault,
  defaultRunner,
  editVault,
  isAllowedServiceExecutable,
  launchService,
  parseAgeIdentities,
  parseVaultYaml,
  SECRET_KEYS,
  SecretVaultError,
  validateAgeIdentity,
  type ProcessRunner,
} from "../lib/secrets/vault";

const root = join(import.meta.dir, "..");

type Call = {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  captureStdout: boolean;
  interactive: boolean;
  silent: boolean;
  inheritStdout: boolean;
  timeoutMs?: number;
};

function fakeRunner(stdout = "", code = 0): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (command, args, env, options) => {
    calls.push({
      command,
      args,
      env,
      captureStdout: options.captureStdout,
      interactive: options.interactive === true,
      silent: options.silent === true,
      inheritStdout: options.inheritStdout === true,
      timeoutMs: options.timeoutMs,
    });
    return { code, stdout };
  };
  return { runner, calls };
}

function inRepoDotPathFixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(root, "..containment-"));
  const file = join(dir, "identity.txt");
  writeFileSync(file, "not-a-real-key", "utf8");
  return { dir, file };
}

describe("vault YAML: accepted shape", () => {
  test("parses a flat allowlisted vault with comments and markers", () => {
    const secrets = parseVaultYaml(
      [
        "---",
        "# public comment, no secret",
        'EXA_API_KEY: "abc-def"',
        "TINYFISH_API_KEY: plain-key",
        "EBAY_ENV: production",
        "HA_MCP_URL: https://ha.example/api/mcp",
        "...",
      ].join("\r\n"),
    );
    expect(secrets).toEqual({
      EXA_API_KEY: "abc-def",
      TINYFISH_API_KEY: "plain-key",
      EBAY_ENV: "production",
      HA_MCP_URL: "https://ha.example/api/mcp",
    });
  });

  test("double-quoted escapes are decoded and kept as one in-memory string", () => {
    const secrets = parseVaultYaml('HA_BEARER_TOKEN: "line1\\nline2\\t\\\\\\""');
    expect(secrets.HA_BEARER_TOKEN).toBe('line1\nline2\t\\"');
  });

  test("single-quoted values decode doubled quotes only", () => {
    const secrets = parseVaultYaml("EBAY_CLIENT_SECRET: 'it''s-literal'");
    expect(secrets.EBAY_CLIENT_SECRET).toBe("it's-literal");
  });

  test("shell metacharacters remain literal data, never shell syntax", () => {
    const value = '$(touch /tmp/pwned); `id`; & | ; rm -rf /#not-a-comment';
    const secrets = parseVaultYaml(`EXA_API_KEY: ${value}`);
    expect(secrets.EXA_API_KEY).toBe(value);
  });

  test("OPENROUTER_API_KEY is accepted when present and optional when absent", () => {
    const withKey = parseVaultYaml('EXA_API_KEY: exa\nOPENROUTER_API_KEY: "sk-or-test"\n');
    expect(withKey.OPENROUTER_API_KEY).toBe("sk-or-test");

    const withoutKey = parseVaultYaml("EXA_API_KEY: exa\n");
    expect(withoutKey).toEqual({ EXA_API_KEY: "exa" });
    expect(withoutKey).not.toHaveProperty("OPENROUTER_API_KEY");
  });
});

describe("vault YAML: rejected shape", () => {
  test("unknown fields are rejected without echoing the value", () => {
    let message = "";
    try {
      parseVaultYaml("EVIL_KEY: super-secret-value");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretVaultError);
      message = (error as Error).message;
    }
    expect(message).toContain("allowed secret list");
    expect(message).not.toContain("super-secret-value");
  });

  test("duplicate, empty, nested, block, and list shapes are rejected", () => {
    const bad = [
      "EXA_API_KEY: one\nEXA_API_KEY: two",
      "EXA_API_KEY:",
      "EXA_API_KEY:\n  nested: value",
      "EXA_API_KEY: |\n  line",
      "EXA_API_KEY: [one]",
      "EXA_API_KEY: {one: two}",
      "EXA_API_KEY: value # inline",
      "EXA_API_KEY: # only-a-comment",
      "",
    ];
    for (const text of bad) {
      expect(() => parseVaultYaml(text)).toThrow(SecretVaultError);
    }
  });

  test("malformed quotes and control characters are rejected", () => {
    expect(() => parseVaultYaml('EXA_API_KEY: "unterminated')).toThrow(SecretVaultError);
    expect(() => parseVaultYaml("EXA_API_KEY: bad\u0001value")).toThrow(SecretVaultError);
    expect(() => parseVaultYaml('EXA_API_KEY: "a\\u0000b"')).toThrow(SecretVaultError);
  });

  test("an invalid OPENROUTER_API_KEY entry never discloses its value", () => {
    const sentinel = "SENTINEL_OPENROUTER_VALUE";
    let message = "";
    try {
      parseVaultYaml(`OPENROUTER_API_KEY: "unterminated-${sentinel}`);
    } catch (error) {
      expect(error).toBeInstanceOf(SecretVaultError);
      message = (error as Error).message;
    }
    expect(message).toContain("OPENROUTER_API_KEY");
    expect(message).not.toContain(sentinel);
  });
});

describe("identity and decryption", () => {
  test("a missing age key file is rejected without reading it", () => {
    expect(() =>
      validateAgeIdentity({
        kind: "age-key-file",
        path: join(root, "does-not-exist", "identity.txt"),
      }),
    ).toThrow(SecretVaultError);
  });

  test("an identity inside the Git checkout is rejected", () => {
    expect(() =>
      validateAgeIdentity({ kind: "age-key-file", path: join(root, "package.json") }),
    ).toThrow("outside the Git checkout");
    expect(() =>
      validateAgeIdentity({
        kind: "age-encrypted-identity",
        path: join(root, "package.json"),
      }),
    ).toThrow("outside the Git checkout");
  });

  test("a ..foo-prefixed identity inside the checkout is rejected", () => {
    const fixture = inRepoDotPathFixture();
    try {
      expect(() =>
        validateAgeIdentity({ kind: "age-key-file", path: fixture.file }),
      ).toThrow("outside the Git checkout");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("Git unavailable still rejects an in-repo identity via the package root", () => {
    const fixture = inRepoDotPathFixture();
    const previousPath = process.env.PATH;
    const previousPathAlt = process.env.Path;
    try {
      process.env.PATH = "";
      process.env.Path = "";
      expect(() =>
        validateAgeIdentity({ kind: "age-key-file", path: fixture.file }),
      ).toThrow("outside the Git checkout");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousPathAlt === undefined) delete process.env.Path;
      else process.env.Path = previousPathAlt;
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("an identity outside the checkout is accepted without reading it", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-identity-"));
    const identity = join(dir, "identity.txt");
    try {
      writeFileSync(identity, "not-a-real-key", "utf8");
      expect(() => validateAgeIdentity({ kind: "age-key-file", path: identity })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SOPS environment is explicit and ambient identity variables are stripped", () => {
    const fileEnv = buildSopsEnv(
      {
        PATH: "/bin",
        SOPS_AGE_KEY: "ambient-inline",
        SOPS_AGE_KEY_CMD: "ambient-cmd",
        SOPS_AGE_RECIPIENTS: "age1ambient",
      },
      { kind: "age-key-file", path: "C:/keys/opencode.txt" },
    );
    expect(fileEnv.SOPS_AGE_KEY).toBeUndefined();
    expect(fileEnv.SOPS_AGE_KEY_CMD).toBeUndefined();
    expect(fileEnv.SOPS_AGE_RECIPIENTS).toBeUndefined();
    expect(fileEnv.SOPS_AGE_KEY_FILE).toBe("C:/keys/opencode.txt");
    expect(fileEnv.PATH).toBe("/bin");

    const inlineEnv = buildSopsEnv(
      { SOPS_AGE_KEY_FILE: "ambient-file", SOPS_AGE_KEY: "ambient-inline" },
      { kind: "age-encrypted-identity", path: "C:/keys/opencode.age" },
      "AGE-SECRET-KEY-1TEST",
    );
    expect(inlineEnv.SOPS_AGE_KEY_FILE).toBeUndefined();
    expect(inlineEnv.SOPS_AGE_KEY).toBe("AGE-SECRET-KEY-1TEST");
  });

  test("an encrypted identity without decrypted material is rejected", () => {
    expect(() =>
      buildSopsEnv({}, { kind: "age-encrypted-identity", path: "C:/keys/opencode.age" }),
    ).toThrow("was not decrypted");
  });

  test("decrypts through a subprocess pipe with argv, never a shell string", async () => {
    const { runner, calls } = fakeRunner('EXA_API_KEY: "secret-value"\n');
    const secrets = await decryptVault({
      vaultPath: "C:/vaults/opencode.sops.yaml",
      identity: { kind: "age-key-file", path: "C:/keys/opencode.txt" },
      baseEnv: { PATH: "C:/bin", SOPS_AGE_KEY: "ambient" },
      runner,
    });
    expect(secrets).toEqual({ EXA_API_KEY: "secret-value" });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("sops");
    expect(calls[0].args).toEqual(["--decrypt", "C:/vaults/opencode.sops.yaml"]);
    expect(calls[0].captureStdout).toBe(true);
    expect(calls[0].env.SOPS_AGE_KEY).toBeUndefined();
    expect(calls[0].env.SOPS_AGE_KEY_FILE).toBe("C:/keys/opencode.txt");
  });

  test("an encrypted identity is decrypted interactively then passed inline", async () => {
    const calls: Call[] = [];
    const runner: ProcessRunner = async (command, args, env, options) => {
      calls.push({
        command,
        args,
        env,
        captureStdout: options.captureStdout,
        interactive: options.interactive === true,
        silent: options.silent === true,
        inheritStdout: options.inheritStdout === true,
        timeoutMs: options.timeoutMs,
      });
      if (command === "age") {
        return { code: 0, stdout: "# created: now\nAGE-SECRET-KEY-1TESTONLY\n" };
      }
      return { code: 0, stdout: 'EXA_API_KEY: "secret-value"\n' };
    };

    const secrets = await decryptVault({
      vaultPath: "C:/vaults/opencode.sops.yaml",
      identity: { kind: "age-encrypted-identity", path: "C:/keys/opencode.age" },
      baseEnv: { PATH: "C:/bin" },
      runner,
    });

    expect(secrets).toEqual({ EXA_API_KEY: "secret-value" });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("age");
    expect(calls[0].args).toEqual(["--decrypt", "C:/keys/opencode.age"]);
    expect(calls[0].interactive).toBe(true);
    expect(calls[1].command).toBe("sops");
    expect(calls[1].env.SOPS_AGE_KEY).toBe("AGE-SECRET-KEY-1TESTONLY");
    expect(calls[1].env.SOPS_AGE_KEY_FILE).toBeUndefined();
  });

  test("age output without an identity is rejected generically", async () => {
    const runner: ProcessRunner = async (command) => {
      if (command === "age") return { code: 0, stdout: "not an identity" };
      return { code: 0, stdout: "" };
    };
    let message = "";
    try {
      await decryptVault({
        vaultPath: "C:/vault.yaml",
        identity: { kind: "age-encrypted-identity", path: "C:/key.age" },
        runner,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("age output contains an unrecognized identity line");
  });

  test("an age identity failure is generic and never exposes output", async () => {
    const runner: ProcessRunner = async (command) => {
      if (command === "age") return { code: 1, stdout: "SENTINEL_AGE_OUTPUT" };
      return { code: 0, stdout: "" };
    };
    let message = "";
    try {
      await decryptVault({
        vaultPath: "C:/vault.yaml",
        identity: { kind: "age-encrypted-identity", path: "C:/key.age" },
        runner,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("age identity decryption failed");
    expect(message).not.toContain("SENTINEL");
  });

  test("sops failures are generic and never expose stderr or values", async () => {
    const { runner } = fakeRunner("", 2);
    let message = "";
    try {
      await decryptVault({
        vaultPath: "C:/vaults/opencode.sops.yaml",
        identity: { kind: "age-key-file", path: "C:/keys/opencode.txt" },
        runner,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("sops decryption failed");
    expect(message).not.toContain("AGE-SECRET-KEY");
  });

  test("a runner exception is converted to a generic error", async () => {
    const runner: ProcessRunner = async () => {
      throw new Error("sops: could not decrypt AGE-SECRET-KEY-LEAK");
    };
    await expect(
      decryptVault({
        vaultPath: "C:/vault.yaml",
        identity: { kind: "age-key-file", path: "C:/key.txt" },
        runner,
      }),
    ).rejects.toThrow("could not run sops");
  });
});

describe("age identity parsing", () => {
  const keyA = "AGE-SECRET-KEY-1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const keyB = "AGE-SECRET-KEY-PQ-1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  test("comments and blank lines are ignored", () => {
    expect(parseAgeIdentities(`# created: now\n\n${keyA}\n`)).toEqual([keyA]);
  });

  test("multiple identity lines are preserved in order", () => {
    expect(parseAgeIdentities(`${keyA}\n${keyB}\n`)).toEqual([keyA, keyB]);
  });

  test("a fake identity inside a comment is not selected", () => {
    expect(parseAgeIdentities(`# AGE-SECRET-KEY-1FAKE\n${keyA}\n`)).toEqual([keyA]);
  });

  test("a public key or junk line is rejected instead of skipped", () => {
    expect(() => parseAgeIdentities("age1publickey\n")).toThrow("unrecognized identity line");
    expect(() => parseAgeIdentities(`${keyA}\njunk\n`)).toThrow("unrecognized identity line");
  });

  test("zero identity lines is rejected", () => {
    expect(() => parseAgeIdentities("# only a comment\n\n")).toThrow(
      "did not return a valid identity",
    );
  });
});

describe("service environment", () => {
  test("vault values are authoritative and stale allowlisted values are removed", () => {
    const env = buildServiceEnv(
      {
        PATH: "/bin",
        EXA_API_KEY: "stale",
        EBAY_CLIENT_ID: "stale-id",
        SOPS_AGE_KEY_FILE: "C:/keys/opencode.txt",
        SOPS_AGE_KEY: "ambient",
        UNRELATED: "kept",
      },
      { EXA_API_KEY: "fresh", HA_BEARER_TOKEN: "token" },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.UNRELATED).toBe("kept");
    expect(env.EXA_API_KEY).toBe("fresh");
    expect(env.HA_BEARER_TOKEN).toBe("token");
    expect(env.EBAY_CLIENT_ID).toBeUndefined();
    expect(env.SOPS_AGE_KEY_FILE).toBeUndefined();
    expect(env.SOPS_AGE_KEY).toBeUndefined();
  });

  test("no allowlisted key is silently inherited when absent from the vault", () => {
    for (const key of SECRET_KEYS) {
      const env = buildServiceEnv({ [key]: "stale" }, {});
      expect(env[key]).toBeUndefined();
    }
  });

  test("OPENROUTER_API_KEY is forwarded when present and scrubbed when absent", () => {
    const withKey = buildServiceEnv(
      { OPENROUTER_API_KEY: "stale" },
      { OPENROUTER_API_KEY: "fresh" },
    );
    expect(withKey.OPENROUTER_API_KEY).toBe("fresh");

    const withoutKey = buildServiceEnv({ OPENROUTER_API_KEY: "stale" }, {});
    expect(withoutKey.OPENROUTER_API_KEY).toBeUndefined();
  });

  test("launch uses the fixed service subcommand and discards output", async () => {
    const { runner, calls } = fakeRunner("should-not-be-printed");
    const result = await launchService({
      baseEnv: { PATH: "/bin", EXA_API_KEY: "stale" },
      secrets: { EXA_API_KEY: "fresh" },
      runner,
    });
    expect(result).toEqual({ code: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("opencode");
    expect(calls[0].args).toEqual(["service", "restart"]);
    expect(calls[0].captureStdout).toBe(false);
    expect(calls[0].silent).toBe(true);
    expect(calls[0].timeoutMs).toBe(60_000);
    expect(calls[0].env.EXA_API_KEY).toBe("fresh");
  });

  test("executable validation accepts only opencode names by platform", () => {
    for (const binary of [
      "opencode",
      "opencode.exe",
      "opencode.cmd",
      "OpenCode.EXE",
      "C:/Users/example/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe",
      "C:\\tools\\opencode.cmd",
    ]) {
      expect(isAllowedServiceExecutable(binary, "win32")).toBe(true);
    }
    expect(isAllowedServiceExecutable("/usr/local/bin/opencode", "linux")).toBe(true);
    expect(isAllowedServiceExecutable("opencode", "darwin")).toBe(true);

    for (const binary of [
      "opencode.bat",
      "opencode.ps1",
      "evil.exe",
      "/tmp/not-opencode",
      "C:/tmp/opencode.exe.bak",
      "C:/tmp/",
      " opencode",
      "opencode ",
    ]) {
      expect(isAllowedServiceExecutable(binary, "win32")).toBe(false);
    }
    for (const binary of ["opencode.exe", "opencode.cmd", "/tmp/not-opencode"]) {
      expect(isAllowedServiceExecutable(binary, "linux")).toBe(false);
    }
  });

  test("an explicit Windows opencode.exe path remains usable", async () => {
    const executable =
      "C:/Users/example/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe";
    const { runner, calls } = fakeRunner();
    await launchService({
      secrets: { EXA_API_KEY: "fake-sentinel" },
      runner,
      command: [executable, "service", "restart"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(executable);
    expect(calls[0].env.EXA_API_KEY).toBe("fake-sentinel");
  });

  test("an arbitrary executable is refused without echoing its name", async () => {
    const sentinel = "SENTINEL_FAKE_EXECUTABLE";
    const { runner, calls } = fakeRunner();
    let message = "";
    try {
      await launchService({
        secrets: { EXA_API_KEY: "fake-sentinel" },
        runner,
        command: [`C:/tmp/${sentinel}.exe`, "service", "restart"],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("only the approved service command may run");
    expect(message).not.toContain(sentinel);
    expect(calls).toHaveLength(0);
  });

  test("any other command is refused", async () => {
    const { runner, calls } = fakeRunner();
    await expect(
      launchService({
        secrets: {},
        runner,
        command: ["opencode", "service", "stop"],
      }),
    ).rejects.toThrow("approved service command");
    await expect(
      launchService({
        secrets: {},
        runner,
        command: ["rm", "-rf", "restart"],
      }),
    ).rejects.toThrow("approved service command");
    expect(calls).toHaveLength(0);
  });

  test("a non-zero child exit is reported as a code only", async () => {
    const { runner } = fakeRunner("", 7);
    const result = await launchService({ secrets: {}, runner });
    expect(result).toEqual({ code: 7 });
  });
});

describe("edit mode", () => {
  test("opens sops with an in-memory inline identity and interactive stdio", async () => {
    const key = "AGE-SECRET-KEY-1EDITTEST";
    const calls: Call[] = [];
    const runner: ProcessRunner = async (command, args, env, options) => {
      calls.push({
        command,
        args,
        env,
        captureStdout: options.captureStdout,
        interactive: options.interactive === true,
        silent: options.silent === true,
        inheritStdout: options.inheritStdout === true,
        timeoutMs: options.timeoutMs,
      });
      if (command === "age") return { code: 0, stdout: `${key}\n` };
      return { code: 0, stdout: "" };
    };

    const result = await editVault({
      vaultPath: "C:/vaults/opencode.sops.yaml",
      identity: { kind: "age-encrypted-identity", path: "C:/keys/opencode.age" },
      baseEnv: { PATH: "C:/bin" },
      runner,
    });

    expect(result).toEqual({ code: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("age");
    expect(calls[0].interactive).toBe(true);
    expect(calls[1].command).toBe("sops");
    expect(calls[1].args).toEqual(["C:/vaults/opencode.sops.yaml"]);
    expect(calls[1].env.SOPS_AGE_KEY).toBe(key);
    expect(calls[1].interactive).toBe(true);
    expect(calls[1].inheritStdout).toBe(true);
    expect(calls[1].captureStdout).toBe(false);
  });

  test("a plaintext key file edit uses SOPS_AGE_KEY_FILE", async () => {
    const { runner, calls } = fakeRunner("", 0);
    await editVault({
      vaultPath: "C:/vault.sops.yaml",
      identity: { kind: "age-key-file", path: "C:/keys/identity.txt" },
      baseEnv: { PATH: "C:/bin" },
      runner,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].env.SOPS_AGE_KEY_FILE).toBe("C:/keys/identity.txt");
    expect(calls[0].env.SOPS_AGE_KEY).toBeUndefined();
  });
});

describe("real subprocess behavior", () => {
  test("the stdout cap rejects with a generic limit error", async () => {
    await expect(
      defaultRunner(
        process.execPath,
        ["-e", "process.stdout.write('A'.repeat(2 * 1024 * 1024))"],
        {},
        { captureStdout: true },
      ),
    ).rejects.toThrow("process output exceeded the safe limit");
  });

  test("a bounded noninteractive timeout kills the subprocess", async () => {
    await expect(
      defaultRunner(
        process.execPath,
        ["-e", "setTimeout(() => {}, 5000)"],
        {},
        { captureStdout: true, timeoutMs: 200 },
      ),
    ).rejects.toThrow("process timed out");
  });

  test("silent mode ignores stdout and stderr", async () => {
    const result = await defaultRunner(
      process.execPath,
      ["-e", "console.log('SENTINEL_STDOUT'); console.error('SENTINEL_STDERR'); process.exit(0)"],
      {},
      { captureStdout: false, silent: true },
    );
    expect(result).toEqual({ code: 0, stdout: "" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  test("stderr is discarded and never returned", async () => {
    const result = await defaultRunner(
      process.execPath,
      ["-e", "console.error('SENTINEL_STDERR'); console.log('SENTINEL_STDOUT')"],
      {},
      { captureStdout: true },
    );
    expect(result.stdout).toContain("SENTINEL_STDOUT");
    expect(JSON.stringify(result)).not.toContain("SENTINEL_STDERR");
  });

  test("failure output is suppressed when stdout is not captured", async () => {
    const result = await defaultRunner(
      process.execPath,
      [
        "-e",
        "console.log('SENTINEL_STDOUT'); console.error('SENTINEL_STDERR'); process.exit(3)",
      ],
      {},
      { captureStdout: false },
    );
    expect(result).toEqual({ code: 3, stdout: "" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  test("decryptVault turns a real subprocess failure into a generic error", async () => {
    const runner: ProcessRunner = (command, args, env, options) =>
      defaultRunner(
        process.execPath,
        ["-e", "console.error('SENTINEL_STDERR'); process.exit(2)"],
        env,
        options,
      );
    let message = "";
    try {
      await decryptVault({
        vaultPath: "C:/vault.yaml",
        identity: { kind: "age-key-file", path: "C:/key.txt" },
        runner,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("sops decryption failed");
    expect(message).not.toContain("SENTINEL");
  });

  test("launchService suppresses a real subprocess failure output", async () => {
    const runner: ProcessRunner = (command, args, env, options) =>
      defaultRunner(
        process.execPath,
        [
          "-e",
          "console.log('SENTINEL_STDOUT'); console.error('SENTINEL_STDERR'); process.exit(4)",
        ],
        env,
        options,
      );
    const result = await launchService({ secrets: {}, runner });
    expect(result).toEqual({ code: 4 });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });
});

describe("CLI error hygiene", () => {
  test("an unknown argument is not echoed", () => {
    const sentinel = "SENTINEL_UNKNOWN_ARGUMENT";
    const out = spawnSync(
      process.execPath,
      [join(root, "scripts", "secret-launch.ts"), `--${sentinel}`],
      { cwd: root, encoding: "utf8" },
    );
    const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    expect(out.status).toBe(1);
    expect(combined).toContain("unknown argument");
    expect(combined).not.toContain(sentinel);
  });

  test("--edit and --restart cannot be combined", () => {
    const out = spawnSync(
      process.execPath,
      [
        join(root, "scripts", "secret-launch.ts"),
        "--vault",
        "C:/vault.sops.yaml",
        "--age-key-file",
        "C:/identity.txt",
        "--edit",
        "--restart",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(out.status).toBe(1);
    expect(`${out.stdout ?? ""}${out.stderr ?? ""}`).toContain("cannot be combined");
  });
});

describe("no plaintext persistence", () => {
  test("the vault module contains no filesystem writes", () => {
    const source = readFileSync(join(root, "lib", "secrets", "vault.ts"), "utf8");
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdtemp|tmpdir/);
  });

  test("the launcher contains no filesystem writes or shell evaluation", () => {
    const source = readFileSync(join(root, "scripts", "secret-launch.ts"), "utf8");
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdtemp|tmpdir/);
    expect(source).not.toMatch(/\bexecSync\b|\bshell\s*:\s*true\b|eval\(/);
  });
});
