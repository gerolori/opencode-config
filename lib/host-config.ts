import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MCPDomain, MCPEditor } from "@opencode/plugin/promise/mcp";
import type { Registration } from "@opencode/plugin/promise/registration";

const EXA_URL = "https://mcp.exa.ai/mcp";

export type HostMcpServer = {
  type?: "local" | "remote";
  command?: string[];
  environment?: Record<string, string>;
  disabled?: boolean;
  codemode?: boolean;
  url?: string;
  headers?: Record<string, string>;
  oauth?: false | Record<string, unknown>;
};

export type HostConfig = {
  mcp?: {
    servers?: Record<string, HostMcpServer | undefined>;
  };
};

export type HostConfigOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
  isDirectory?: (path: string) => boolean;
  hasFile?: (path: string) => boolean;
};

export type HostConfigSummary = {
  added: string[];
  sqzCommand: string[];
};

export type HostConfigContext = {
  mcp: Pick<MCPDomain, "transform">;
};

type ResolvedOptions = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  isDirectory: (path: string) => boolean;
  hasFile: (path: string) => boolean;
};

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultHasFile(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function resolveOptions(options: HostConfigOptions): ResolvedOptions {
  return {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    home: options.homedir ?? homedir(),
    isDirectory: options.isDirectory ?? defaultIsDirectory,
    hasFile: options.hasFile ?? defaultHasFile,
  };
}

function isLocalAbsolute(value: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
  }
  return value.startsWith("/");
}

function isLocalDirectory(
  value: string,
  platform: NodeJS.Platform,
  isDirectory: (path: string) => boolean,
): boolean {
  if (!value) return false;
  // Reject URLs and UNC/network shares before touching the filesystem.
  if (value.includes("://")) return false;
  if (/^[\\/]{2}/.test(value)) return false;
  if (!isLocalAbsolute(value, platform)) return false;
  return isDirectory(value);
}

function isStandardSqzCommand(command: string[] | undefined): boolean {
  return Array.isArray(command) && command.length === 1 && command[0] === "sqz-mcp";
}

/**
 * Recognize the tracked/default eBay command after OpenCode's config loader may
 * have already replaced `{env:EBAY_MCP_DIR}` (a missing variable becomes "").
 *
 * The standard shape is managed when the directory is still the placeholder, is
 * empty, or equals the configured env override. A different absolute path is a
 * user override and is preserved.
 */
function isManagedEbayCommand(
  command: string[] | undefined,
  envEbayDir: string,
): boolean {
  if (
    !Array.isArray(command) ||
    command.length !== 5 ||
    command[0] !== "uv" ||
    command[1] !== "--directory" ||
    command[3] !== "run" ||
    command[4] !== "ebay-mcp"
  ) {
    return false;
  }
  const dir = command[2] ?? "";
  if (dir === "{env:EBAY_MCP_DIR}" || dir === "") return true;
  return envEbayDir.length > 0 && dir === envEbayDir;
}

function standardEbayCommand(dir: string): string[] {
  return ["uv", "--directory", dir, "run", "ebay-mcp"];
}

/**
 * Build the effective eBay child environment from the service environment.
 *
 * OpenCode 2.2.5 interpolates `{env:NAME}` in static config, but a missing
 * variable becomes an empty string and the post-config MCP transform may not be
 * re-interpolated. Writing the effective values here avoids a literal
 * placeholder and avoids depending on that ordering. Optional `EBAY_ENV` is
 * omitted when unset; the eBay server treats an absent/empty value as
 * `production`.
 */
function ebayEnvironment(
  env: Record<string, string | undefined>,
  existing: Record<string, string> = {},
): Record<string, string> {
  const out = { ...existing };
  const clientId = env.EBAY_CLIENT_ID?.trim();
  const clientSecret = env.EBAY_CLIENT_SECRET?.trim();
  if (clientId) out.EBAY_CLIENT_ID = clientId;
  if (clientSecret) out.EBAY_CLIENT_SECRET = clientSecret;
  const environment = env.EBAY_ENV?.trim();
  if (environment) out.EBAY_ENV = environment;
  else if (out.EBAY_ENV === "{env:EBAY_ENV}" || out.EBAY_ENV === "") {
    delete out.EBAY_ENV;
  }
  return out;
}

function isDisabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Apply host-local initialization to a plain resolved config.
 *
 * Optional Exa/Semble/eBay/Home Assistant servers are added only when absent
 * and their prerequisites are present. Existing entries are never re-enabled
 * or rewritten, with one exception: the tracked eBay entry uses an env
 * placeholder and is enabled only when both the local project and credentials
 * exist. SQZ only gets the Windows executable-name adjustment.
 */
export function applyHostConfig(
  config: HostConfig,
  options: HostConfigOptions = {},
): HostConfigSummary {
  const resolved = resolveOptions(options);
  config.mcp ??= {};
  config.mcp.servers ??= {};
  const servers = config.mcp.servers;
  const before = new Set(Object.keys(servers));

  const sqz = servers.sqz;
  if (sqz && resolved.platform === "win32" && isStandardSqzCommand(sqz.command)) {
    // Windows PATH shim: use the executable name, never an absolute path.
    sqz.command = ["sqz-mcp.exe"];
  }

  const envSembleDir = resolved.env.SEMBLE_MCP_DIR?.trim() ?? "";
  const sembleCandidate = envSembleDir || join(resolved.home, "mcp-servers", "semble");
  const disableSemble = isDisabled(resolved.env.OPENCODE_DISABLE_SEMBLE);
  if (servers.semble && disableSemble) {
    // One-way kill switch: disable an existing Semble entry, but preserve its
    // command and every other field.
    servers.semble.disabled = true;
  }
  const sembleValid =
    !disableSemble &&
    isLocalDirectory(sembleCandidate, resolved.platform, resolved.isDirectory) &&
    resolved.hasFile(join(sembleCandidate, "pyproject.toml"));
  if (!servers.semble && sembleValid) {
    servers.semble = {
      type: "local",
      command: ["uv", "--directory", sembleCandidate, "run", "semble"],
      disabled: false,
      codemode: true,
    };
  }

  const disableEbay = isDisabled(resolved.env.OPENCODE_DISABLE_EBAY);
  const envEbayDir = resolved.env.EBAY_MCP_DIR?.trim() ?? "";
  const ebayCandidate = envEbayDir || join(resolved.home, "mcp-servers", "ebay");
  const ebayProjectValid =
    isLocalDirectory(ebayCandidate, resolved.platform, resolved.isDirectory) &&
    resolved.hasFile(join(ebayCandidate, "pyproject.toml"));
  const ebayCredentialsPresent = Boolean(
    resolved.env.EBAY_CLIENT_ID?.trim() && resolved.env.EBAY_CLIENT_SECRET?.trim(),
  );
  const ebayValid = !disableEbay && ebayProjectValid && ebayCredentialsPresent;
  const ebay = servers.ebay;
  if (ebay && disableEbay) {
    // One-way kill switch, mirroring Semble: disable what exists but keep the
    // user's command and every other field.
    ebay.disabled = true;
  }
  if (ebay && ebayValid && isManagedEbayCommand(ebay.command, envEbayDir)) {
    // Resolve the tracked placeholder only when the project and both
    // credentials exist. Values stay in memory and are never written to source
    // or logs.
    ebay.command = standardEbayCommand(ebayCandidate);
    ebay.environment = ebayEnvironment(resolved.env, ebay.environment);
    ebay.disabled = false;
  }
  if (!ebay && ebayValid) {
    // Absent entry: add a portable default with effective values in memory.
    servers.ebay = {
      type: "local",
      command: standardEbayCommand(ebayCandidate),
      environment: ebayEnvironment(resolved.env),
      disabled: false,
      codemode: false,
    };
  }

  const exaKey = resolved.env.EXA_API_KEY?.trim();
  if (!servers.exa && exaKey) {
    // The post-config transform does not resolve {env:...}; interpolate the
    // credential in memory only. Never persist or log this value.
    servers.exa = {
      type: "remote",
      url: EXA_URL,
      headers: { "x-api-key": exaKey },
      oauth: false,
      disabled: false,
      codemode: true,
    };
  }

  const haUrl = resolved.env.HA_MCP_URL?.trim();
  const haToken = resolved.env.HA_BEARER_TOKEN?.trim();
  if (!servers.home_assistant && haUrl && haToken) {
    // Both URL and token are required. Interpolate the bearer token in memory
    // only; there is no hardcoded fallback host.
    servers.home_assistant = {
      type: "remote",
      url: haUrl,
      headers: { Authorization: `Bearer ${haToken}` },
      disabled: false,
      codemode: true,
    };
  }

  return {
    added: Object.keys(servers).filter((name) => !before.has(name)).sort(),
    sqzCommand: [...(servers.sqz?.command ?? [])],
  };
}

/**
 * Register the host-local MCP transform with the OpenCode 2.x plugin context.
 *
 * The retrieval extension owner calls this once during setup. The returned
 * Registration can be disposed with the extension's own lifecycle.
 */
const HOST_MANAGED_SERVERS = ["sqz", "semble", "ebay", "exa", "home_assistant"] as const;

export async function registerHostConfig(
  context: HostConfigContext,
  options: HostConfigOptions = {},
): Promise<Registration> {
  const env = options.env ?? process.env;
  const disableSemble = isDisabled(env.OPENCODE_DISABLE_SEMBLE);
  const envEbayDir = env.EBAY_MCP_DIR?.trim() ?? "";
  return context.mcp.transform((editor: MCPEditor) => {
    // `list()` may omit a disabled entry that `get()` still returns. Seed the
    // resolved view from `get()` for every host-managed name so an existing
    // entry is never treated as absent and overwritten by `set()`.
    const listed: Record<string, HostMcpServer | undefined> = Object.fromEntries(
      editor.list(),
    );
    for (const name of HOST_MANAGED_SERVERS) {
      if (listed[name] !== undefined) continue;
      const existing = editor.get(name);
      if (existing !== undefined) listed[name] = existing as HostMcpServer;
    }
    // The editor may expose live objects. Capture the pre-transform state so
    // updates are still reported when applyHostConfig mutates in place.
    const prior = new Map<string, { disabled?: boolean; command?: string[] }>();
    for (const [name, server] of Object.entries(listed)) {
      if (!server) continue;
      const command = (server as HostMcpServer).command;
      prior.set(name, {
        disabled: server.disabled,
        command: Array.isArray(command) ? [...command] : undefined,
      });
    }
    const current: HostConfig = { mcp: { servers: listed } };
    applyHostConfig(current, options);
    for (const [name, server] of Object.entries(current.mcp?.servers ?? {})) {
      if (!server) continue;
      if (editor.get(name) === undefined) {
        editor.set(name, server as Parameters<MCPEditor["set"]>[1]);
      } else if (name === "sqz") {
        editor.update(name, (target) => {
          if (target.type === "local" && server.command !== undefined) {
            target.command = server.command;
          }
        });
      } else if (name === "semble" && disableSemble) {
        editor.update(name, (target) => {
          target.disabled = true;
        });
      } else if (name === "ebay") {
        // Only the resolved placeholder state is written back. A custom eBay
        // command keeps its user-defined disabled flag and path.
        const existing = editor.get(name);
        if (!existing || existing.type !== "local") continue;
        const original = prior.get(name);
        const commandChanged =
          original?.command !== undefined &&
          isManagedEbayCommand(original.command, envEbayDir) &&
          server.command !== undefined &&
          original.command.join("\u0000") !== server.command.join("\u0000");
        const disabledChanged = original?.disabled !== server.disabled;
        if (!commandChanged && !disabledChanged) continue;
        editor.update(name, (target) => {
          if (target.type !== "local") return;
          target.disabled = server.disabled;
          if (commandChanged && server.command !== undefined) {
            target.command = server.command;
          }
        });
      }
    }
  });
}
