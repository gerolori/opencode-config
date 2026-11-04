import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Portable secret-vault support.
 *
 * The vault is a SOPS-encrypted YAML document. Only a small, fixed allowlist of
 * service environment variables is accepted. Decrypted content is kept in
 * memory only: no temp files, no shell interpolation, no logging of values.
 */

export const SECRET_KEYS = [
  "EXA_API_KEY",
  "TINYFISH_API_KEY",
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "EBAY_ENV",
  "HA_MCP_URL",
  "HA_BEARER_TOKEN",
  "COMPOSIO_CONSUMER_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
export type SecretValues = Partial<Record<SecretKey, string>>;

const SECRET_KEY_SET: ReadonlySet<string> = new Set(SECRET_KEYS);

export function isSecretKey(value: string): value is SecretKey {
  return SECRET_KEY_SET.has(value);
}

export type SecretVaultErrorCode =
  | "invalid-vault"
  | "invalid-identity"
  | "decrypt-failed"
  | "launch-failed"
  /** The process runner could not find the executable (for example ENOENT). */
  | "executable-not-found"
  /** The process runner failed to start the executable for another reason. */
  | "spawn-failed"
  /** A bounded non-interactive runner exceeded its timeout. */
  | "timeout";

/** Errors are deliberately generic: they never carry secret values or stderr. */
export class SecretVaultError extends Error {
  readonly code: SecretVaultErrorCode;

  constructor(code: SecretVaultErrorCode, message: string) {
    super(message);
    this.name = "SecretVaultError";
    this.code = code;
  }
}

/**
 * Parse the strict YAML subset emitted for an OpenCode vault.
 *
 * Accepted: top-level `KEY: scalar` pairs, blank lines, full-line comments, and
 * the YAML document markers `---` / `...`. Rejected: nesting, lists, block
 * scalars, duplicate keys, unknown keys, empty values, and non-string shapes.
 * The parser never evaluates or shells out.
 */
export function parseVaultYaml(text: string): SecretValues {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const values: SecretValues = {};
  let seen = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("#")) continue;
    if (line === "---" || line === "...") continue;

    if (/^\s/.test(line)) {
      throw new SecretVaultError(
        "invalid-vault",
        `line ${index + 1}: indented or nested content is not supported`,
      );
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!match) {
      throw new SecretVaultError(
        "invalid-vault",
        `line ${index + 1}: expected a top-level KEY: value pair`,
      );
    }

    const key = match[1];
    const raw = match[2];
    if (!isSecretKey(key)) {
      throw new SecretVaultError(
        "invalid-vault",
        `line ${index + 1}: key is not in the allowed secret list`,
      );
    }
    if (Object.hasOwn(values, key)) {
      throw new SecretVaultError("invalid-vault", `duplicate key: ${key}`);
    }
    if (raw === undefined) {
      throw new SecretVaultError("invalid-vault", `${key}: value must be a string`);
    }

    const value = parseScalar(raw.trim(), key);
    if (value.length === 0) {
      throw new SecretVaultError("invalid-vault", `${key}: value must not be empty`);
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
      throw new SecretVaultError("invalid-vault", `${key}: value contains control characters`);
    }
    values[key] = value;
    seen += 1;
  }

  if (seen === 0) {
    throw new SecretVaultError("invalid-vault", "vault contains no allowed fields");
  }
  return values;
}

function parseScalar(raw: string, key: string): string {
  if (raw.length === 0) {
    throw new SecretVaultError("invalid-vault", `${key}: value must be a string`);
  }

  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
      throw new SecretVaultError(
        "invalid-vault",
        `${key}: unterminated or malformed double-quoted value`,
      );
    }
    try {
      // JSON string syntax is a strict subset of YAML double-quoted escapes.
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "string") {
        throw new Error("not a string");
      }
      return parsed;
    } catch {
      throw new SecretVaultError(
        "invalid-vault",
        `${key}: malformed escape sequence in double-quoted value`,
      );
    }
  }

  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) {
      throw new SecretVaultError(
        "invalid-vault",
        `${key}: unterminated or malformed single-quoted value`,
      );
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }

  if (/^[|>{[&*!%@`#]/.test(raw)) {
    throw new SecretVaultError(
      "invalid-vault",
      `${key}: block scalars, lists, and mappings are not supported`,
    );
  }
  if (/\s#/.test(raw)) {
    throw new SecretVaultError(
      "invalid-vault",
      `${key}: inline comments are not supported; quote the value or use a full-line comment`,
    );
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(raw)) {
    throw new SecretVaultError("invalid-vault", `${key}: value contains control characters`);
  }
  return raw;
}

export type AgeIdentity =
  | { kind: "age-key-file"; path: string }
  | { kind: "age-encrypted-identity"; path: string };

function normalizedExistingPath(path: string): string {
  let full: string;
  try {
    full = realpathSync(path);
  } catch {
    full = resolve(path);
  }
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function findPackageRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return normalizedExistingPath(current);
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function pathIsInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  // `..foo` is a filename inside the root; only `..` or `..<separator>` exits.
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

/**
 * Collect the config/package root(s) and any Git root(s). The package root is
 * enforced even when Git is unavailable. Symlinks are resolved with realpath
 * when possible; otherwise the lexical absolute path is used.
 */
function moduleDirectory(): string {
  if (typeof import.meta.dir === "string") return import.meta.dir;
  return dirname(fileURLToPath(import.meta.url));
}

function checkoutRoots(): string[] {
  const roots = new Set<string>();
  const moduleDir = moduleDirectory();

  // This module's package root is the stable config root even without Git.
  // Do not walk up from an arbitrary cwd: an unrelated parent package.json
  // (for example the home directory) must not become a containment boundary.
  const packageRoot = findPackageRoot(moduleDir);
  if (packageRoot) roots.add(packageRoot);

  for (const start of [process.cwd(), moduleDir]) {
    try {
      const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: start,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 5000,
      }).trim();
      if (toplevel) roots.add(normalizedExistingPath(toplevel));
    } catch {
      // Git may be unavailable; the package-root check still applies.
    }
  }
  return [...roots];
}

function isInsideGitCheckout(path: string): boolean {
  const target = normalizedExistingPath(path);
  return checkoutRoots().some((root) => pathIsInside(root, target));
}

export function validateAgeIdentity(identity: AgeIdentity): void {
  if (identity.path.trim() === "") {
    throw new SecretVaultError("invalid-identity", "age identity path is empty");
  }
  try {
    if (!statSync(identity.path).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new SecretVaultError(
      "invalid-identity",
      "age identity file is missing or is not a regular file",
    );
  }
  if (isInsideGitCheckout(identity.path)) {
    throw new SecretVaultError(
      "invalid-identity",
      "age identity file must be outside the Git checkout",
    );
  }
}

/** Build the SOPS environment without ambient identity variables. */
export function buildSopsEnv(
  baseEnv: Record<string, string | undefined>,
  identity: AgeIdentity,
  inlineIdentity?: string,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  delete env.SOPS_AGE_KEY;
  delete env.SOPS_AGE_KEY_FILE;
  delete env.SOPS_AGE_KEY_CMD;
  delete env.SOPS_AGE_RECIPIENTS;

  if (identity.kind === "age-key-file") {
    env.SOPS_AGE_KEY_FILE = identity.path;
  } else {
    if (!inlineIdentity) {
      throw new SecretVaultError(
        "invalid-identity",
        "encrypted age identity was not decrypted",
      );
    }
    env.SOPS_AGE_KEY = inlineIdentity;
  }
  return env;
}

export type ProcessResult = { code: number; stdout: string };
export type ProcessOptions = {
  captureStdout: boolean;
  /** Inherit stdin/stderr so a passphrase prompt can reach the user's terminal. */
  interactive?: boolean;
  /** Ignore stdin/stdout/stderr entirely (used for the service restart). */
  silent?: boolean;
  /** Inherit stdout too (used for an interactive SOPS editor). */
  inheritStdout?: boolean;
  /** Bounded non-interactive runtime. Never used for a passphrase prompt. */
  timeoutMs?: number;
  /**
   * Resolve a bare Windows service name to a concrete `.exe`/`.cmd` shim before
   * spawning. Set only for the fixed `opencode service restart` command; never
   * for sops/age or commands that receive user-controlled vault paths.
   */
  resolveWindowsExecutable?: boolean;
};
export type ProcessRunner = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  options: ProcessOptions,
) => Promise<ProcessResult>;

const MAX_CAPTURE_BYTES = 1024 * 1024;

function compactEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Default runner. Bun's spawn resolves Windows npm shims; Node is the fallback
 * for environments that run this module directly. stderr is drained and
 * discarded, never returned to callers.
 */
function stdioModes(options: ProcessOptions): {
  stdin: "inherit" | "ignore";
  stdout: "inherit" | "ignore" | "pipe";
  stderr: "inherit" | "ignore" | "pipe";
} {
  const interactive = options.interactive === true;
  const silent = options.silent === true;
  return {
    stdin: interactive ? "inherit" : "ignore",
    stdout: options.inheritStdout ? "inherit" : silent ? "ignore" : "pipe",
    stderr: interactive ? "inherit" : silent ? "ignore" : "pipe",
  };
}

const WINDOWS_SERVICE_BASENAME = "opencode";

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the native binary wrapped by a standard npm shim directory. The
 * conventional layout is `<shimDir>/node_modules/@opencode/cli/bin/opencode.exe`.
 * The path is constructed locally (never from user input) and must be a regular
 * file. This "direct native" strategy avoids cmd.exe entirely when available.
 */
function findNpmNativeSibling(directory: string): string | undefined {
  const candidate = join(
    directory,
    "node_modules",
    "@opencode",
    "cli",
    "bin",
    "opencode.exe",
  );
  return isRegularFile(candidate) ? candidate : undefined;
}

/**
 * Resolve a bare allowed service name on Windows to a concrete executable.
 *
 * PATH directory order is honored: the first directory that yields a regular
 * file wins. Within a directory a native `.exe` is preferred over `.cmd`
 * (matching PATHEXT order). When a `.cmd` npm shim is found, a native sibling
 * binary in that shim's own `node_modules/@opencode/cli/bin/opencode.exe` is
 * preferred as a safer direct-native strategy, so cmd.exe is not needed.
 *
 * Explicit paths (containing a separator) are returned unchanged and never
 * rewritten. Candidates must be regular files; directories named `opencode.exe`
 * are ignored. Non-Windows platforms are returned unchanged. This resolver is
 * used only for the fixed `opencode service restart` command, never sops/age.
 */
export function resolveServiceExecutable(
  command: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return command;
  if (command === "" || /[\\/]/.test(command)) return command;

  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const rawPath = pathKey ? env[pathKey] : undefined;
  if (typeof rawPath !== "string" || rawPath === "") return command;

  const lower = command.toLowerCase();
  const hasExe = lower.endsWith(".exe");
  const hasCmd = lower.endsWith(".cmd");
  const base = hasExe || hasCmd ? command.slice(0, -4) : command;
  const extensions: readonly string[] = hasExe
    ? [".exe"]
    : hasCmd
      ? [".cmd"]
      : [".exe", ".cmd"];
  const isServiceName = base.toLowerCase() === WINDOWS_SERVICE_BASENAME;

  for (const entry of rawPath.split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, base + extension);
      if (!isRegularFile(candidate)) continue;
      if (extension.toLowerCase() === ".cmd" && isServiceName) {
        const native = findNpmNativeSibling(directory);
        if (native) return native;
      }
      return candidate;
    }
    if (isServiceName) {
      const native = findNpmNativeSibling(directory);
      if (native) return native;
    }
  }
  return command;
}

export type RuntimeName = "bun" | "node";

export function activeRuntime(): RuntimeName {
  const bun = (globalThis as { Bun?: { spawn?: unknown } }).Bun;
  return bun && typeof bun.spawn === "function" ? "bun" : "node";
}

/**
 * Select the service executable for the active runtime. `.cmd` shims run safely
 * under Bun. The Node fallback cannot start a `.cmd` without a shell, so a
 * `.cmd` selection is rejected there with an actionable message recommending a
 * trusted absolute `.exe` via `--opencode`.
 */
export function selectServiceExecutable(
  command: string,
  env: Record<string, string | undefined>,
  runtime: RuntimeName = activeRuntime(),
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = resolveServiceExecutable(command, env, platform);
  if (platform === "win32" && runtime === "node" && /\.cmd$/i.test(resolved)) {
    throw new SecretVaultError(
      "launch-failed",
      "the Node fallback cannot start a .cmd shim without a shell; " +
        "pass --opencode with a trusted absolute opencode.exe path",
    );
  }
  return resolved;
}

/**
 * Convert a raw spawn failure into a typed, path-free error. Callers (including
 * the service launcher) can branch on the code without echoing the executable
 * path or child output to the terminal.
 */
export function spawnError(error: unknown): SecretVaultError {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "ENOENT") {
    return new SecretVaultError("executable-not-found", "executable not found");
  }
  return new SecretVaultError("spawn-failed", "could not start process");
}

export const defaultRunner: ProcessRunner = async (command, args, env, options) => {
  const modes = stdioModes(options);
  const resolved =
    options.resolveWindowsExecutable === true
      ? selectServiceExecutable(command, env)
      : command;
  const bun = (globalThis as { Bun?: { spawn: Function } }).Bun;

  if (bun && typeof bun.spawn === "function") {
    let proc;
    try {
      proc = bun.spawn([resolved, ...args], {
        env: compactEnv(env),
        stdin: modes.stdin,
        stdout: modes.stdout,
        stderr: modes.stderr,
        windowsHide: true,
      });
    } catch (error) {
      throw spawnError(error);
    }
    const execute = async (): Promise<ProcessResult> => {
      const stdoutPromise =
        modes.stdout === "pipe"
          ? options.captureStdout
            ? readBunStreamCapped(proc.stdout)
            : drainBunStream(proc.stdout).then(() => "")
          : Promise.resolve("");
      const stderrPromise =
        modes.stderr === "pipe" ? drainBunStream(proc.stderr) : Promise.resolve();
      const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
      const code = (await proc.exited) as number;
      return { code, stdout };
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.timeoutMs && options.timeoutMs > 0) {
        const timeout = new Promise<ProcessResult>((_, reject) => {
          timer = setTimeout(() => {
            try {
              proc.kill();
            } catch {
              // The process may already be gone.
            }
            reject(new SecretVaultError("timeout", "process timed out"));
          }, options.timeoutMs);
        });
        return await Promise.race([execute(), timeout]);
      }
      return await execute();
    } catch (error) {
      try {
        proc.kill();
      } catch {
        // The process may already be gone.
      }
      throw error instanceof SecretVaultError ? error : spawnError(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const { spawn } = await import("node:child_process");
  return await new Promise<ProcessResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(resolved, args, {
        env: compactEnv(env),
        stdio: [modes.stdin, modes.stdout, modes.stderr],
        windowsHide: true,
      });
    } catch (error) {
      reject(spawnError(error));
      return;
    }
    const chunks: Buffer[] = [];
    let captured = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: SecretVaultError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    child.on("error", (error) => fail(spawnError(error)));
    if (modes.stdout === "pipe") {
      child.stdout?.on("data", (chunk: Buffer) => {
        if (!options.captureStdout) return;
        captured += chunk.length;
        if (captured > MAX_CAPTURE_BYTES) {
          child.kill();
          fail(new SecretVaultError("decrypt-failed", "process output exceeded the safe limit"));
          return;
        }
        chunks.push(chunk);
      });
    }
    if (modes.stderr === "pipe") {
      // Drain stderr so the child cannot block; bytes are deliberately dropped.
      child.stderr?.on("data", () => {});
    }
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        fail(new SecretVaultError("timeout", "process timed out"));
      }, options.timeoutMs);
    }
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
};

async function readBunStreamCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CAPTURE_BYTES) {
        throw new SecretVaultError("decrypt-failed", "process output exceeded the safe limit");
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    reader.releaseLock();
  }
}

async function drainBunStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain and discard.
    }
  } finally {
    reader.releaseLock();
  }
}

export type DecryptOptions = {
  vaultPath: string;
  identity: AgeIdentity;
  baseEnv?: Record<string, string | undefined>;
  runner?: ProcessRunner;
};

/**
 * Parse age identity output line-by-line. Comments and blank lines are ignored;
 * every other line must be a complete native age identity. Multiple identities
 * are preserved, matching identity-file semantics. A public key or comment that
 * merely looks like an identity is never selected.
 */
export function parseAgeIdentities(text: string): string[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const identities: string[] = [];
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!/^AGE-SECRET-KEY-(?:PQ-)?[A-Z0-9-]+$/.test(trimmed)) {
      throw new SecretVaultError(
        "invalid-identity",
        "age output contains an unrecognized identity line",
      );
    }
    identities.push(trimmed);
  }
  if (identities.length === 0) {
    throw new SecretVaultError("invalid-identity", "age did not return a valid identity");
  }
  return identities;
}

/**
 * Ask age for a passphrase-protected identity. stdout is captured in memory;
 * stdin/stderr stay attached to the terminal so the user sees and answers the
 * prompt. Only complete AGE-SECRET-KEY lines are retained.
 */
async function decryptAgeIdentity(
  path: string,
  baseEnv: Record<string, string | undefined>,
  runner: ProcessRunner,
): Promise<string> {
  let result: ProcessResult;
  try {
    result = await runner("age", ["--decrypt", path], { ...baseEnv }, {
      captureStdout: true,
      interactive: true,
    });
  } catch (error) {
    if (error instanceof SecretVaultError) throw error;
    throw new SecretVaultError("invalid-identity", "could not run age");
  }
  if (result.code !== 0) {
    result.stdout = "";
    throw new SecretVaultError("invalid-identity", "age identity decryption failed");
  }

  try {
    return parseAgeIdentities(result.stdout).join("\n");
  } finally {
    result.stdout = "";
  }
}

/** Decrypt a SOPS vault into memory. Never returns or throws decrypted stderr. */
export async function decryptVault(options: DecryptOptions): Promise<SecretValues> {
  const vaultPath = options.vaultPath;
  if (typeof vaultPath !== "string" || vaultPath.trim() === "") {
    throw new SecretVaultError("decrypt-failed", "vault path is empty");
  }
  const runner = options.runner ?? defaultRunner;
  const baseEnv = options.baseEnv ?? process.env;

  let inlineIdentity: string | undefined;
  try {
    if (options.identity.kind === "age-encrypted-identity") {
      inlineIdentity = await decryptAgeIdentity(options.identity.path, baseEnv, runner);
    }
    const env = buildSopsEnv(baseEnv, options.identity, inlineIdentity);

    let result: ProcessResult;
    try {
      result = await runner("sops", ["--decrypt", vaultPath], env, {
        captureStdout: true,
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof SecretVaultError) throw error;
      throw new SecretVaultError("decrypt-failed", "could not run sops");
    }

    if (result.code !== 0) {
      result.stdout = "";
      throw new SecretVaultError("decrypt-failed", "sops decryption failed");
    }
    const secrets = parseVaultYaml(result.stdout);
    result.stdout = "";
    return secrets;
  } finally {
    inlineIdentity = "";
  }
}

export type EditOptions = {
  vaultPath: string;
  identity: AgeIdentity;
  baseEnv?: Record<string, string | undefined>;
  runner?: ProcessRunner;
};

/**
 * Open the SOPS editor with the identity material supplied in memory. The
 * editor gets the terminal, so it may display plaintext and create its own
 * temp/swap files; the launcher itself never prints the identity.
 */
export async function editVault(options: EditOptions): Promise<{ code: number }> {
  if (options.vaultPath.trim() === "") {
    throw new SecretVaultError("invalid-vault", "vault path is empty");
  }
  const runner = options.runner ?? defaultRunner;
  const baseEnv = options.baseEnv ?? process.env;
  let inlineIdentity: string | undefined;
  try {
    if (options.identity.kind === "age-encrypted-identity") {
      inlineIdentity = await decryptAgeIdentity(options.identity.path, baseEnv, runner);
    }
    const env = buildSopsEnv(baseEnv, options.identity, inlineIdentity);
    let result: ProcessResult;
    try {
      result = await runner("sops", [options.vaultPath], env, {
        captureStdout: false,
        interactive: true,
        inheritStdout: true,
      });
    } catch (error) {
      if (error instanceof SecretVaultError) throw error;
      throw new SecretVaultError("launch-failed", "could not run the sops editor");
    }
    return { code: result.code };
  } finally {
    inlineIdentity = "";
  }
}

const IDENTITY_ENV_KEYS = [
  "SOPS_AGE_KEY",
  "SOPS_AGE_KEY_FILE",
  "SOPS_AGE_KEY_CMD",
  "SOPS_AGE_RECIPIENTS",
] as const;

/**
 * Build the service environment: allowlisted values are authoritative, stale
 * values for allowlisted keys are removed, and SOPS identity variables are not
 * forwarded to the service.
 *
 * Every other ambient variable is deliberately preserved so the service keeps
 * PATH, locale, and user settings. That means the launch is not a clean-room
 * environment: other ambient credentials or host overrides in the caller's
 * environment are inherited. This is a documented residual risk, not an
 * accidental allowlist bypass.
 */
export function buildServiceEnv(
  baseEnv: Record<string, string | undefined>,
  secrets: SecretValues,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  for (const key of SECRET_KEYS) delete env[key];
  for (const key of IDENTITY_ENV_KEYS) delete env[key];
  for (const key of SECRET_KEYS) {
    const value = secrets[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The only subcommand this launcher will execute. */
export const SERVICE_ARGS = ["service", "restart"] as const;
export const SERVICE_COMMAND = ["opencode", ...SERVICE_ARGS] as const;

const WINDOWS_SERVICE_EXECUTABLES: ReadonlySet<string> = new Set([
  "opencode",
  "opencode.exe",
  "opencode.cmd",
]);
const POSIX_SERVICE_EXECUTABLES: ReadonlySet<string> = new Set(["opencode"]);

/**
 * Check the executable name without trusting its contents. Windows also accepts
 * an explicit path to an `opencode.exe`/`opencode.cmd` shim; POSIX accepts an
 * `opencode` path. This is a name check, not integrity verification: a malicious
 * binary or earlier PATH entry can still be named `opencode`. Use a trusted
 * absolute path and a trusted PATH when the environment is not trustworthy.
 */
export function isAllowedServiceExecutable(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof binary !== "string" || binary === "" || binary !== binary.trim()) {
    return false;
  }
  if (/[\u0000\r\n]/.test(binary)) return false;

  // Check both separators so a Windows path is not mistaken for a filename on
  // POSIX (or vice versa) when the platform is overridden in a test.
  const name = binary.split(/[\\/]/).pop() ?? "";
  if (name === "" || name === "." || name === "..") return false;
  if (platform === "win32") {
    return WINDOWS_SERVICE_EXECUTABLES.has(name.toLowerCase());
  }
  return POSIX_SERVICE_EXECUTABLES.has(name);
}

export type LaunchResult = { code: number };

export type LaunchOptions = {
  baseEnv?: Record<string, string | undefined>;
  secrets: SecretValues;
  runner?: ProcessRunner;
  command?: readonly string[];
};

/**
 * Launch the allowed service command with the secret environment. Output is
 * discarded so an unexpected status/credential line cannot reach the terminal.
 *
 * The executable is restricted to an `opencode` basename (plus Windows
 * `.exe`/`.cmd` shims). That prevents an arbitrary absolute executable from
 * receiving the vault, but it does not authenticate the binary: a malicious
 * file named `opencode` on PATH passes. Prefer a trusted absolute path.
 */
export async function launchService(options: LaunchOptions): Promise<LaunchResult> {
  const command = options.command ?? SERVICE_COMMAND;
  const binary = command[0] ?? "";
  if (
    !isAllowedServiceExecutable(binary) ||
    command.length !== 1 + SERVICE_ARGS.length ||
    command[1] !== SERVICE_ARGS[0] ||
    command[2] !== SERVICE_ARGS[1]
  ) {
    throw new SecretVaultError("launch-failed", "only the approved service command may run");
  }

  const runner = options.runner ?? defaultRunner;
  const env = buildServiceEnv(options.baseEnv ?? process.env, options.secrets);
  let result: ProcessResult;
  try {
    result = await runner(command[0], command.slice(1), env, {
      captureStdout: false,
      silent: true,
      timeoutMs: 60_000,
      resolveWindowsExecutable: true,
    });
  } catch (error) {
    if (error instanceof SecretVaultError) {
      if (error.code === "executable-not-found") {
        throw new SecretVaultError(
          "launch-failed",
          "the service executable was not found; check that OpenCode is installed, " +
            "or pass --opencode with a trusted absolute path",
        );
      }
      if (error.code === "spawn-failed") {
        throw new SecretVaultError("launch-failed", "could not start the service process");
      }
      if (error.code === "timeout") {
        throw new SecretVaultError("launch-failed", "the service command timed out");
      }
      throw error;
    }
    throw new SecretVaultError("launch-failed", "could not start the service process");
  }
  return { code: result.code };
}

/** Best-effort removal of secret references held by this process. */
export function clearSecretsFromProcessEnv(): void {
  for (const key of SECRET_KEYS) delete process.env[key];
  for (const key of IDENTITY_ENV_KEYS) delete process.env[key];
}
