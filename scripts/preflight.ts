import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Probe = { ok: boolean; detail: string };
type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const root = process.cwd();

function runRaw(cmd: string, maxBuffer = 1024 * 1024): Probe {
  try {
    const out = execSync(cmd, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer,
    }).trim();
    return { ok: true, detail: out };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function run(cmd: string): Probe {
  const probe = runRaw(cmd);
  return probe.ok ? { ok: true, detail: probe.detail.split(/\r?\n/)[0] ?? "" } : probe;
}

function parseSemver(text: string): string | undefined {
  return text.match(/\d+\.\d+\.\d+/)?.[0];
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTracked(relativePath: string): boolean {
  try {
    const out = execSync(`git ls-files -- "${relativePath}"`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

const pkg = readJson<PackageJson>(join(root, "package.json"));
const pin = pkg?.dependencies?.["@opencode-ai/plugin"];
const installed = readJson<{ version?: string }>(
  join(root, "node_modules", "@opencode-ai", "plugin", "package.json"),
);

const runtime = run("opencode --version");
const bun = run("bun --version");
const node = run("node --version");

const runtimeVersion = runtime.ok ? parseSemver(runtime.detail) : undefined;
const pinVersion = pin ? parseSemver(pin) : undefined;
const installedVersion = installed?.version;

const locks = {
  bun: existsSync(join(root, "bun.lock")),
  packageLock: existsSync(join(root, "package-lock.json")),
};
const packageLockTracked = isTracked("package-lock.json");

const checks: Array<{ name: string; ok: boolean; detail: string }> = [
  { name: "runtime.present", ok: runtime.ok, detail: runtime.detail },
  { name: "bun.present", ok: bun.ok, detail: bun.detail },
  { name: "node.present", ok: node.ok, detail: node.detail },
  { name: "package.sdk_pin", ok: Boolean(pin), detail: pin ?? "missing @opencode-ai/plugin dependency" },
  {
    name: "sdk.installed",
    ok: Boolean(installedVersion),
    detail: installedVersion ?? "not installed (run bun install)",
  },
  {
    name: "sdk.matches_pin",
    ok: Boolean(pinVersion && installedVersion && pinVersion === installedVersion),
    detail: `${installedVersion ?? "?"} vs pin ${pinVersion ?? "?"}`,
  },
  { name: "lock.authoritative_bun", ok: locks.bun, detail: locks.bun ? "bun.lock" : "missing bun.lock" },
  {
    name: "lock.package_lock_not_tracked",
    ok: !packageLockTracked,
    detail: packageLockTracked ? "package-lock.json is tracked; remove it from git" : "not tracked",
  },
];

const runtimeMatchesSdk = Boolean(runtimeVersion && pinVersion && runtimeVersion === pinVersion);
const warnings: string[] = [];
if (locks.packageLock && !packageLockTracked) {
  warnings.push(
    "package-lock.json is present but gitignored (the runtime plugin installer may regenerate it); bun.lock remains authoritative",
  );
}
if (runtime.ok && pinVersion && !runtimeMatchesSdk) {
  warnings.push(
    `runtime ${runtimeVersion ?? "?"} does not exactly match SDK pin ${pinVersion}; verify compatibility and do not major-upgrade the runtime`,
  );
}
if (!bun.ok) {
  warnings.push("bun unavailable; `bun test` cannot run (install Bun 1.3+ or use a Node TS runner)");
}

// Optional parse-only config probe. Values are never printed or persisted.
const wantsConfig = process.argv.includes("--config");
let configFacts:
  | {
      parsed: true;
      top_level_keys: string[];
      has_compaction: boolean;
      has_subagent_depth: boolean;
      has_agent: boolean;
      has_provider: boolean;
      has_permission: boolean;
      has_plugin: boolean;
      has_experimental: boolean;
      compaction_keys: string[];
    }
  | undefined;

if (wantsConfig) {
  const raw = runRaw("opencode debug config", 16 * 1024 * 1024);
  if (!raw.ok) {
    warnings.push(`config probe failed: ${raw.detail}`);
  } else {
    try {
      const parsed = JSON.parse(raw.detail === "" ? "{}" : raw.detail) as Record<string, unknown>;
      configFacts = {
        parsed: true,
        top_level_keys: Object.keys(parsed).sort(),
        has_compaction: Object.hasOwn(parsed, "compaction"),
        has_subagent_depth: Object.hasOwn(parsed, "subagent_depth"),
        has_agent: Object.hasOwn(parsed, "agent"),
        has_provider: Object.hasOwn(parsed, "provider"),
        has_permission: Object.hasOwn(parsed, "permission"),
        has_plugin: Object.hasOwn(parsed, "plugin"),
        has_experimental: Object.hasOwn(parsed, "experimental"),
        compaction_keys: isRecord(parsed.compaction) ? Object.keys(parsed.compaction).sort() : [],
      };
    } catch (error) {
      warnings.push(`config probe parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const failed = checks.filter((check) => !check.ok);
const report = {
  ok: failed.length === 0,
  runtime: runtimeVersion ?? null,
  sdk_pin: pinVersion ?? null,
  sdk_installed: installedVersion ?? null,
  runtime_matches_sdk: runtimeMatchesSdk,
  toolchain: {
    bun: bun.ok ? bun.detail : null,
    node: node.ok ? node.detail : null,
  },
  locks,
  checks: Object.fromEntries(checks.map((check) => [check.name, { ok: check.ok, detail: check.detail }])),
  warnings,
  config: configFacts ?? "not probed (use --config for parse-only key presence)",
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
