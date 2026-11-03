import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const templatePath = join(root, "docs", "templates", "sops-vault.example.md");

/**
 * Read the first `path_regex` value from the public template so the docs and
 * these matching expectations cannot drift apart.
 */
function documentedPathRegex(): string {
  const text = readFileSync(templatePath, "utf8");
  const match = text.match(/^\s*- path_regex:\s*'?([^'\r\n]+)'?\s*$/m);
  if (!match) throw new Error("template has no path_regex line");
  return match[1].trim();
}

function toolAvailable(command: string): boolean {
  return spawnSync(command, ["--version"], { encoding: "utf8" }).error === undefined;
}

const pattern = documentedPathRegex();
const matches = new RegExp(pattern);
const sopsAvailable = toolAvailable("sops");
const ageKeygenAvailable = toolAvailable("age-keygen");

describe("documented SOPS path_regex", () => {
  test("matches the vault path with Windows and POSIX separators", () => {
    expect(matches.test("secrets/opencode.sops.yaml")).toBe(true);
    expect(matches.test("secrets\\opencode.sops.yaml")).toBe(true);
    expect(matches.test("secrets/nested/opencode.sops.yml")).toBe(true);
    expect(matches.test("secrets\\nested\\opencode.sops.yml")).toBe(true);
  });

  test("rejects lookalike paths and non-vault files", () => {
    expect(matches.test("mysecrets/opencode.sops.yaml")).toBe(false);
    expect(matches.test("mysecrets\\opencode.sops.yaml")).toBe(false);
    expect(matches.test("secrets/opencode.yaml")).toBe(false);
    expect(matches.test("secrets\\opencode.sops.yaml.bak")).toBe(false);
    expect(matches.test("opencode.sops.yaml")).toBe(false);
  });

  test("the old forward-slash-anchored form cannot match a Windows path", () => {
    // Regression: SOPS normalizes to "\" on Windows, so "^secrets/" is dead.
    expect(/^secrets\/.*\.sops\.ya?ml$/.test("secrets\\opencode.sops.yaml")).toBe(false);
  });
});

describe.skipIf(!sopsAvailable || !ageKeygenAvailable)("real sops path_regex fixture", () => {
  test("a generated identity encrypts and decrypts a disposable vault", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-sops-regex-"));
    try {
      const identity = join(dir, "identity.txt");
      expect(spawnSync("age-keygen", ["-o", identity], { encoding: "utf8" }).status).toBe(0);
      const recipient = spawnSync("age-keygen", ["-y", identity], { encoding: "utf8" });
      expect(recipient.status).toBe(0);
      expect(recipient.stdout.trim().startsWith("age1")).toBe(true);

      writeFileSync(
        join(dir, ".sops.yaml"),
        `creation_rules:\n  - path_regex: '${pattern}'\n    age: ${recipient.stdout.trim()}\n`,
        "utf8",
      );
      mkdirSync(join(dir, "secrets"), { recursive: true });
      writeFileSync(
        join(dir, "secrets", "fixture.sops.yaml"),
        "EXA_API_KEY: fixture-not-secret\n",
        "utf8",
      );

      const encrypted = spawnSync(
        "sops",
        ["--encrypt", "--in-place", "secrets/fixture.sops.yaml"],
        { cwd: dir, encoding: "utf8" },
      );
      expect(encrypted.status).toBe(0);
      expect(readFileSync(join(dir, "secrets", "fixture.sops.yaml"), "utf8")).toContain(
        "ENC[AES256_GCM",
      );

      const env: Record<string, string | undefined> = {
        ...process.env,
        SOPS_AGE_KEY_FILE: identity,
      };
      delete env.SOPS_AGE_KEY;
      const decrypted = spawnSync("sops", ["--decrypt", "secrets/fixture.sops.yaml"], {
        cwd: dir,
        encoding: "utf8",
        env,
      });
      expect(decrypted.status).toBe(0);
      expect(decrypted.stdout).toContain("fixture-not-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
