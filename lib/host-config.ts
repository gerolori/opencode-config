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

function isDisabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Apply host-local initialization to a plain resolved config.
 *
 * Optional Exa/Semble/Home Assistant servers are added only when absent and
 * their prerequisites are present. Existing entries are never re-enabled or
 * rewritten; SQZ only gets the Windows executable-name adjustment.
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
export async function registerHostConfig(
  context: HostConfigContext,
  options: HostConfigOptions = {},
): Promise<Registration> {
  const disableSemble = isDisabled((options.env ?? process.env).OPENCODE_DISABLE_SEMBLE);
  return context.mcp.transform((editor: MCPEditor) => {
    const current: HostConfig = {
      mcp: { servers: Object.fromEntries(editor.list()) },
    };
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
      }
    }
  });
}
