import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_HOME_ASSISTANT_URL = "https://homeassistant.gerosalorenzo.com/api/mcp";

export type HostMcpConfig = {
  type?: string;
  command?: string[];
  enabled?: boolean;
  url?: string;
  oauth?: boolean | Record<string, unknown>;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
};

export type HostConfig = {
  mcp?: Record<string, HostMcpConfig | undefined>;
};

export type HostConfigOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homedir?: string;
  isDirectory?: (path: string) => boolean;
  hasFile?: (path: string) => boolean;
};

export type HostConfigSummary = {
  sqzCommand: string[];
  sembleEnabled: boolean;
  sembleCommand: string[];
  homeAssistantEnabled: boolean;
  exaEnabled: boolean;
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

function isStandardSembleCommand(command: string[] | undefined, envDir: string): boolean {
  if (!command || command.length !== 5) return false;
  return (
    command[0] === "uv" &&
    command[1] === "--directory" &&
    command[3] === "run" &&
    command[4] === "semble" &&
    (command[2] === "{env:SEMBLE_MCP_DIR}" || command[2] === envDir || command[2] === "")
  );
}

function isDisabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Apply host-local initialization to the resolved opencode config.
 *
 * This function never reads, prints, or persists secrets. It only checks for
 * presence of environment keys and local directories, and it leaves explicitly
 * custom MCP commands/paths untouched.
 */
export function applyHostConfig(
  config: HostConfig,
  options: HostConfigOptions = {},
): HostConfigSummary {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? homedir();
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const hasFile = options.hasFile ?? defaultHasFile;
  const mcp = config.mcp ?? {};

  const sqz = mcp.sqz;
  if (
    sqz &&
    platform === "win32" &&
    Array.isArray(sqz.command) &&
    sqz.command.length === 1 &&
    sqz.command[0] === "sqz-mcp"
  ) {
    // Windows PATH shim: use the executable name, never an absolute path.
    sqz.command = ["sqz-mcp.exe"];
  }

  const envSembleDir = env.SEMBLE_MCP_DIR?.trim() ?? "";
  const sembleCandidate = envSembleDir || join(home, "mcp-servers", "semble");
  const sembleValid =
    isLocalDirectory(sembleCandidate, platform, isDirectory) &&
    hasFile(join(sembleCandidate, "pyproject.toml"));

  const semble = mcp.semble;
  if (semble && isStandardSembleCommand(semble.command, envSembleDir)) {
    if (isDisabled(env.OPENCODE_DISABLE_SEMBLE)) {
      semble.enabled = false;
    } else if (sembleValid) {
      semble.command = ["uv", "--directory", sembleCandidate, "run", "semble"];
      semble.enabled = true;
    } else {
      semble.enabled = false;
    }
  }

  const homeAssistant = mcp.home_assistant;
  if (homeAssistant) {
    const tokenPresent = Boolean(env.HA_BEARER_TOKEN?.trim());
    const envUrl = env.HA_MCP_URL?.trim();
    const standardUrl =
      !homeAssistant.url ||
      homeAssistant.url === "{env:HA_MCP_URL}" ||
      homeAssistant.url === (env.HA_MCP_URL ?? "");
    if (standardUrl) {
      homeAssistant.url = envUrl || DEFAULT_HOME_ASSISTANT_URL;
    }
    homeAssistant.enabled = tokenPresent;
  }

  const exa = mcp.exa;
  if (exa) {
    exa.oauth = false;
    exa.enabled = Boolean(env.EXA_API_KEY?.trim());
  }

  return {
    sqzCommand: [...(sqz?.command ?? [])],
    sembleEnabled: Boolean(semble?.enabled),
    sembleCommand: [...(semble?.command ?? [])],
    homeAssistantEnabled: Boolean(homeAssistant?.enabled),
    exaEnabled: Boolean(exa?.enabled),
  };
}
