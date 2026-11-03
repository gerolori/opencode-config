import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Probe = { ok: boolean; detail: string };
type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type ConfigProbe = {
  found: boolean;
  path?: string;
  parsed?: boolean;
  keys?: string[];
  modern?: string[];
  legacy?: string[];
  has_mcp_servers?: boolean;
  has_websearch?: boolean;
  has_compaction?: boolean;
  has_experimental_subagent_depth?: boolean;
  error?: string;
};
type ServiceProbe = {
  attempted: boolean;
  reachable: boolean;
  version?: string;
  pid?: number;
  detail?: string;
};

const PACKAGES = ["@opencode/plugin", "@opencode/schema", "@opencode/client"] as const;
const ROOT = process.cwd();

function runRaw(cmd: string, maxBuffer = 1024 * 1024, timeout = 30_000): Probe {
  try {
    const out = execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer,
      timeout,
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
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Remove JSONC comments without touching quoted strings (URLs keep their `//`). */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Remove trailing commas outside strings so JSON.parse accepts JSONC. */
function removeTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (input[j] === "}" || input[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function probeConfig(): ConfigProbe {
  const candidates = ["opencode.jsonc", "opencode.json"].map((name) => join(ROOT, name));
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return { found: false };

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(removeTrailingCommas(stripJsonComments(raw))) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    const has = (key: string) => Object.hasOwn(parsed, key);
    const modern = ["providers", "agents", "permissions", "plugins"].filter(has);
    const legacy = ["provider", "agent", "permission", "plugin"].filter(has);
    const mcp = isRecord(parsed.mcp) ? parsed.mcp : undefined;
    const experimental = isRecord(parsed.experimental) ? parsed.experimental : undefined;

    return {
      found: true,
      path: path.slice(ROOT.length + 1),
      parsed: true,
      keys,
      modern,
      legacy,
      has_mcp_servers: Boolean(mcp && isRecord(mcp.servers)),
      has_websearch: has("websearch"),
      has_compaction: has("compaction"),
      has_experimental_subagent_depth: Boolean(
        experimental && Object.hasOwn(experimental, "subagent_depth"),
      ),
    };
  } catch (error) {
    return {
      found: true,
      path: path.slice(ROOT.length + 1),
      parsed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function probeService(): ServiceProbe {
  const status = runRaw("opencode service status", 64 * 1024, 15_000);
  if (!status.ok || !/https?:\/\//i.test(status.detail)) {
    return { attempted: true, reachable: false, detail: "service status did not report a running URL" };
  }

  const raw = runRaw("opencode api server.info", 256 * 1024, 30_000);
  if (!raw.ok) {
    return { attempted: true, reachable: false, detail: "server.info request failed" };
  }

  try {
    const parsed = JSON.parse(raw.detail) as Record<string, unknown>;
    const version = typeof parsed.version === "string" ? parsed.version : undefined;
    const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
    if (!version) return { attempted: true, reachable: false, detail: "server.info had no version" };
    return { attempted: true, reachable: true, version, pid };
  } catch {
    return { attempted: true, reachable: false, detail: "server.info was not valid JSON" };
  }
}

const pkg = readJson<PackageJson>(join(ROOT, "package.json"));
const pins = PACKAGES.map((name) => {
  const pin = pkg?.devDependencies?.[name];
  const installed = readJson<{ version?: string }>(
    join(ROOT, "node_modules", ...name.split("/"), "package.json"),
  )?.version;
  return { name, pin, pinVersion: pin ? parseSemver(pin) : undefined, installed };
});

const runtime = run("opencode --version");
const bun = run("bun --version");
const node = run("node --version");

const runtimeVersion = runtime.ok ? parseSemver(runtime.detail) : undefined;
const pinVersions = pins.map((item) => item.pinVersion);
const commonPin = pinVersions[0];
const pinsSame = pinVersions.every((version) => Boolean(version) && version === commonPin);
const runtimeMatchesPins = Boolean(runtimeVersion && commonPin && runtimeVersion === commonPin);

const locks = {
  bun: existsSync(join(ROOT, "bun.lock")),
  packageLock: existsSync(join(ROOT, "package-lock.json")),
};
const packageLockTracked = isTracked("package-lock.json");

const checks: Array<{ name: string; ok: boolean; detail: string }> = [
  { name: "runtime.present", ok: runtime.ok, detail: runtime.detail },
  { name: "bun.present", ok: bun.ok, detail: bun.detail },
  { name: "node.present", ok: node.ok, detail: node.detail },
  {
    name: "packages.pinned",
    ok: pins.every((item) => Boolean(item.pinVersion)),
    detail: pins.map((item) => `${item.name}@${item.pin ?? "missing"}`).join(", "),
  },
  {
    name: "packages.same_version",
    ok: pinsSame,
    detail: pins.map((item) => item.pinVersion ?? "?").join(", "),
  },
  {
    name: "packages.installed",
    ok: pins.every((item) => Boolean(item.installed)),
    detail: pins.map((item) => `${item.name}@${item.installed ?? "missing"}`).join(", "),
  },
  {
    name: "packages.match_pins",
    ok: pins.every((item) => item.pinVersion && item.installed === item.pinVersion),
    detail: pins.map((item) => `${item.installed ?? "?"} vs ${item.pinVersion ?? "?"}`).join(", "),
  },
  {
    name: "packages.no_obsolete_1x",
    ok:
      !pkg?.dependencies?.["@opencode-ai/plugin"] &&
      !pkg?.devDependencies?.["@opencode-ai/plugin"],
    detail: "obsolete @opencode-ai/plugin removed",
  },
  {
    name: "runtime.matches_packages",
    ok: runtimeMatchesPins,
    detail: `runtime ${runtimeVersion ?? "?"} vs packages ${commonPin ?? "?"}`,
  },
  { name: "lock.authoritative_bun", ok: locks.bun, detail: locks.bun ? "bun.lock" : "missing bun.lock" },
  {
    name: "lock.package_lock_not_tracked",
    ok: !packageLockTracked,
    detail: packageLockTracked ? "package-lock.json is tracked; remove it from git" : "not tracked",
  },
];

const warnings: string[] = [];
if (locks.packageLock && !packageLockTracked) {
  warnings.push("package-lock.json is present but gitignored; bun.lock remains authoritative");
}
if (runtime.ok && !runtimeMatchesPins) {
  warnings.push(
    `runtime ${runtimeVersion ?? "?"} does not match pinned packages ${commonPin ?? "?"}; do not upgrade or downgrade the global runtime here`,
  );
}
if (!bun.ok) {
  warnings.push("bun unavailable; `bun test` cannot run");
}

const wantsConfig = process.argv.includes("--config");
const wantsService = process.argv.includes("--service");

let config: ConfigProbe | undefined;
if (wantsConfig) {
  config = probeConfig();
  if (!config.found) {
    warnings.push("no opencode.jsonc/opencode.json found; config shape not checked");
  } else if (!config.parsed) {
    checks.push({ name: "config.parses", ok: false, detail: "config did not parse as JSONC" });
  } else {
    checks.push({ name: "config.parses", ok: true, detail: `${config.path} parsed` });
    if (config.legacy && config.legacy.length > 0) {
      warnings.push(
        `legacy top-level keys still present during 2.x migration: ${config.legacy.join(", ")}`,
      );
    }
    if (config.modern && config.modern.length === 0) {
      warnings.push("no 2.x top-level keys found yet (providers/agents/permissions/plugins)");
    }
    if (!config.has_mcp_servers) {
      warnings.push("mcp.servers not present yet (2.x expected shape)");
    }
    if (!config.has_websearch) {
      warnings.push("websearch not present yet (2.x expected shape)");
    }
  }
}

let service: ServiceProbe | undefined;
if (wantsService) {
  service = probeService();
  checks.push({
    name: "service.reachable",
    ok: service.reachable,
    detail: service.reachable ? "attached to the existing service" : service.detail ?? "unreachable",
  });
  if (service.reachable) {
    if (service.version === runtimeVersion) {
      checks.push({
        name: "service.version_matches_cli",
        ok: true,
        detail: `service ${service.version}, pid ${service.pid ?? "?"}`,
      });
    } else {
      checks.push({
        name: "service.version_matches_cli",
        ok: false,
        detail: `service ${service.version ?? "?"} vs CLI ${runtimeVersion ?? "?"}`,
      });
    }
  }
}

const failed = checks.filter((check) => !check.ok);
const report = {
  ok: failed.length === 0,
  runtime: runtimeVersion ?? null,
  packages: Object.fromEntries(
    pins.map((item) => [item.name, { pin: item.pinVersion ?? null, installed: item.installed ?? null }]),
  ),
  service: service ?? "not probed (use --service to attach to the running service)",
  locks,
  config: config ?? "not probed (use --config for structural checks)",
  checks: Object.fromEntries(checks.map((check) => [check.name, { ok: check.ok, detail: check.detail }])),
  warnings,
  toolchain: {
    bun: bun.ok ? bun.detail : null,
    node: node.ok ? node.detail : null,
  },
};

console.log(JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
