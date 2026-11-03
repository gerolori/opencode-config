import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyHostConfig,
  registerHostConfig,
  type HostConfig,
  type HostConfigContext,
  type HostConfigOptions,
  type HostMcpServer,
} from "../lib/host-config";

const root = join(import.meta.dir, "..");

function baseConfig(): HostConfig {
  return {
    mcp: {
      servers: {
        sqz: {
          type: "local",
          command: ["sqz-mcp"],
          disabled: false,
          codemode: false,
        },
        ebay: {
          type: "local",
          command: ["uv", "--directory", "{env:EBAY_MCP_DIR}", "run", "ebay-mcp"],
          disabled: true,
          codemode: false,
        },
      },
    },
  };
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function validDir(dir: string) {
  const normalized = normalize(dir);
  return {
    isDirectory: (path: string) => normalize(path) === normalized,
    hasFile: (path: string) => normalize(path) === `${normalized}/pyproject.toml`,
  };
}

async function runRegistration(
  servers: Map<string, HostMcpServer>,
  options: HostConfigOptions,
) {
  const sets: string[] = [];
  const updates: string[] = [];
  const registration = { dispose: async () => {} };
  const context = {
    mcp: {
      transform: async (callback: (editor: any) => void) => {
        const editor = {
          list: () => [...servers.entries()],
          get: (name: string) => servers.get(name),
          set: (name: string, server: HostMcpServer) => {
            sets.push(name);
            servers.set(name, server);
          },
          update: (name: string, update: (server: HostMcpServer) => void) => {
            updates.push(name);
            const server = servers.get(name);
            if (server) update(server);
          },
        };
        callback(editor);
        return registration;
      },
    },
  } as HostConfigContext;
  const result = await registerHostConfig(context, options);
  return { result, registration, sets, updates };
}

describe("host config: SQZ", () => {
  test("Windows standard command selects the executable name", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "win32", env: {} });
    expect(config.mcp?.servers?.sqz?.command).toEqual(["sqz-mcp.exe"]);
  });

  test("POSIX leaves the standard command unchanged", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "linux", env: {} });
    expect(config.mcp?.servers?.sqz?.command).toEqual(["sqz-mcp"]);
  });

  test("custom commands and explicit disabled state are preserved", () => {
    const config = baseConfig();
    if (config.mcp?.servers?.sqz) {
      config.mcp.servers.sqz.command = ["custom-sqz"];
      config.mcp.servers.sqz.disabled = true;
    }
    applyHostConfig(config, { platform: "win32", env: {} });
    expect(config.mcp?.servers?.sqz?.command).toEqual(["custom-sqz"]);
    expect(config.mcp?.servers?.sqz?.disabled).toBe(true);
  });
});

describe("host config: Semble defaults", () => {
  test("valid SEMBLE_MCP_DIR adds Semble", () => {
    const config = baseConfig();
    const dir = "C:/work/semble";
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: dir },
      ...validDir(dir),
    });
    expect(summary.added).toContain("semble");
    expect(config.mcp?.servers?.semble?.disabled).toBe(false);
    expect(config.mcp?.servers?.semble?.command).toEqual([
      "uv",
      "--directory",
      dir,
      "run",
      "semble",
    ]);
  });

  test("valid HOME/mcp-servers/semble adds Semble", () => {
    const config = baseConfig();
    const dir = "C:/Users/me/mcp-servers/semble";
    applyHostConfig(config, {
      platform: "win32",
      env: {},
      homedir: "C:/Users/me",
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.semble?.disabled).toBe(false);
    expect(normalize(config.mcp?.servers?.semble?.command?.[2] ?? "")).toBe(dir);
  });

  test("missing or invalid directories do not add Semble", () => {
    const config = baseConfig();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: "C:/missing/semble" },
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(summary.added).not.toContain("semble");
    expect(config.mcp?.servers?.semble).toBeUndefined();
  });

  test("remote, UNC, relative, and non-project directories are rejected", () => {
    for (const dir of [
      "https://example.com/semble",
      "\\\\server\\share\\semble",
      "mcp-servers/semble",
    ]) {
      const config = baseConfig();
      applyHostConfig(config, {
        platform: "win32",
        env: { SEMBLE_MCP_DIR: dir },
        isDirectory: () => true,
        hasFile: () => true,
      });
      expect(config.mcp?.servers?.semble).toBeUndefined();
    }
    const config = baseConfig();
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: "C:/work/not-semble" },
      isDirectory: () => true,
      hasFile: () => false,
    });
    expect(config.mcp?.servers?.semble).toBeUndefined();
  });

  test("OPENCODE_DISABLE_SEMBLE prevents adding Semble", () => {
    const config = baseConfig();
    const dir = "C:/work/semble";
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: dir, OPENCODE_DISABLE_SEMBLE: "1" },
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.semble).toBeUndefined();
  });

  test("an explicit disabled Semble entry is preserved", () => {
    const config = baseConfig();
    const dir = "C:/work/semble";
    if (config.mcp?.servers) {
      config.mcp.servers.semble = {
        type: "local",
        command: ["custom-semble"],
        disabled: true,
        codemode: true,
      };
    }
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: dir },
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.semble?.disabled).toBe(true);
    expect(config.mcp?.servers?.semble?.command).toEqual(["custom-semble"]);
  });
});

describe("host config: Exa defaults", () => {
  test("missing key does not add Exa", () => {
    const config = baseConfig();
    const summary = applyHostConfig(config, { platform: "win32", env: {} });
    expect(summary.added).not.toContain("exa");
    expect(config.mcp?.servers?.exa).toBeUndefined();
  });

  test("present key adds Exa with an in-memory header", () => {
    const config = baseConfig();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { EXA_API_KEY: "exa-key-value" },
    });
    expect(summary.added).toContain("exa");
    expect(config.mcp?.servers?.exa?.disabled).toBe(false);
    expect(config.mcp?.servers?.exa?.oauth).toBe(false);
    expect(config.mcp?.servers?.exa?.headers?.["x-api-key"]).toBe("exa-key-value");
  });

  test("an explicit disabled Exa entry is preserved", () => {
    const config = baseConfig();
    if (config.mcp?.servers) {
      config.mcp.servers.exa = {
        type: "remote",
        url: "https://custom.example/mcp",
        headers: { "x-api-key": "custom-key" },
        oauth: false,
        disabled: true,
        codemode: true,
      };
    }
    applyHostConfig(config, {
      platform: "win32",
      env: { EXA_API_KEY: "exa-key-value" },
    });
    expect(config.mcp?.servers?.exa?.disabled).toBe(true);
    expect(config.mcp?.servers?.exa?.url).toBe("https://custom.example/mcp");
    expect(config.mcp?.servers?.exa?.headers?.["x-api-key"]).toBe("custom-key");
  });
});

describe("host config: Home Assistant defaults", () => {
  test("token only does not add Home Assistant", () => {
    const config = baseConfig();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { HA_BEARER_TOKEN: "token-value" },
    });
    expect(summary.added).not.toContain("home_assistant");
    expect(config.mcp?.servers?.home_assistant).toBeUndefined();
  });

  test("URL only does not add Home Assistant", () => {
    const config = baseConfig();
    applyHostConfig(config, {
      platform: "win32",
      env: { HA_MCP_URL: "https://ha.example/api/mcp" },
    });
    expect(config.mcp?.servers?.home_assistant).toBeUndefined();
  });

  test("both URL and token add Home Assistant with an in-memory header", () => {
    const config = baseConfig();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: {
        HA_MCP_URL: "https://ha.example/api/mcp",
        HA_BEARER_TOKEN: "token-value",
      },
    });
    expect(summary.added).toContain("home_assistant");
    expect(config.mcp?.servers?.home_assistant?.disabled).toBe(false);
    expect(config.mcp?.servers?.home_assistant?.url).toBe("https://ha.example/api/mcp");
    expect(config.mcp?.servers?.home_assistant?.headers?.Authorization).toBe(
      "Bearer token-value",
    );
  });

  test("an explicit disabled Home Assistant entry is preserved", () => {
    const config = baseConfig();
    if (config.mcp?.servers) {
      config.mcp.servers.home_assistant = {
        type: "remote",
        url: "https://custom.example/mcp",
        headers: { Authorization: "Bearer custom-token" },
        disabled: true,
        codemode: true,
      };
    }
    applyHostConfig(config, {
      platform: "win32",
      env: {
        HA_MCP_URL: "https://ha.example/api/mcp",
        HA_BEARER_TOKEN: "token-value",
      },
    });
    expect(config.mcp?.servers?.home_assistant?.disabled).toBe(true);
    expect(config.mcp?.servers?.home_assistant?.url).toBe("https://custom.example/mcp");
    expect(config.mcp?.servers?.home_assistant?.headers?.Authorization).toBe(
      "Bearer custom-token",
    );
  });

  test("no hardcoded personal Home Assistant URL remains in source", () => {
    const source = readFileSync(join(root, "lib", "host-config.ts"), "utf8");
    expect(source).not.toContain("homeassistant.gerosalorenzo.com");
  });
});

describe("host config: registration", () => {
  test("registerHostConfig sets absent defaults and updates only SQZ", async () => {
    const servers = new Map<string, HostMcpServer>([
      ["sqz", { type: "local", command: ["sqz-mcp"], disabled: false, codemode: false }],
      [
        "exa",
        {
          type: "remote",
          url: "https://custom.example/mcp",
          headers: { "x-api-key": "custom-key" },
          oauth: false,
          disabled: true,
          codemode: true,
        },
      ],
    ]);
    const registration = { dispose: async () => {} };
    const sets: string[] = [];
    const updates: string[] = [];
    const context = {
      mcp: {
        transform: async (callback: (editor: any) => void) => {
          const editor = {
            list: () => [...servers.entries()],
            get: (name: string) => servers.get(name),
            set: (name: string, server: HostMcpServer) => {
              sets.push(name);
              servers.set(name, server);
            },
            update: (name: string, update: (server: HostMcpServer) => void) => {
              updates.push(name);
              const server = servers.get(name);
              if (server) update(server);
            },
          };
          callback(editor);
          return registration;
        },
      },
    } as HostConfigContext;

    const result = await registerHostConfig(context, {
      platform: "win32",
      env: {
        EXA_API_KEY: "exa-key-value",
        HA_MCP_URL: "https://ha.example/api/mcp",
        HA_BEARER_TOKEN: "token-value",
        OPENCODE_DISABLE_SEMBLE: "1",
      },
    });
    expect(result).toBe(registration);
    expect(sets.sort()).toEqual(["home_assistant"]);
    expect(updates).toEqual(["sqz"]);
    expect(servers.get("sqz")?.command).toEqual(["sqz-mcp.exe"]);
    expect(servers.get("exa")?.disabled).toBe(true);
    expect(servers.get("exa")?.headers?.["x-api-key"]).toBe("custom-key");
    expect(servers.get("home_assistant")?.disabled).toBe(false);
  });

  test("existing disabled Semble and Home Assistant entries stay disabled", async () => {
    const dir = "C:/work/semble";
    const servers = new Map<string, HostMcpServer>([
      [
        "semble",
        {
          type: "local",
          command: ["custom-semble"],
          disabled: true,
          codemode: true,
        },
      ],
      [
        "home_assistant",
        {
          type: "remote",
          url: "https://custom.example/mcp",
          headers: { Authorization: "Bearer custom-token" },
          disabled: true,
          codemode: true,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(servers, {
      platform: "win32",
      env: {
        SEMBLE_MCP_DIR: dir,
        HA_MCP_URL: "https://ha.example/api/mcp",
        HA_BEARER_TOKEN: "token-value",
      },
      ...validDir(dir),
    });
    expect(sets).toEqual([]);
    expect(updates).toEqual([]);
    expect(servers.get("semble")?.disabled).toBe(true);
    expect(servers.get("semble")?.command).toEqual(["custom-semble"]);
    expect(servers.get("home_assistant")?.disabled).toBe(true);
    expect(servers.get("home_assistant")?.url).toBe("https://custom.example/mcp");
    expect(servers.get("home_assistant")?.headers?.Authorization).toBe(
      "Bearer custom-token",
    );
  });

  test("OPENCODE_DISABLE_SEMBLE disables an explicit enabled custom Semble entry", async () => {
    const servers = new Map<string, HostMcpServer>([
      [
        "semble",
        {
          type: "local",
          command: ["custom-semble", "--flag"],
          disabled: false,
          codemode: true,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(servers, {
      platform: "win32",
      env: { OPENCODE_DISABLE_SEMBLE: "1" },
    });
    expect(sets).toEqual([]);
    expect(updates).toEqual(["semble"]);
    expect(servers.get("semble")?.disabled).toBe(true);
    expect(servers.get("semble")?.command).toEqual(["custom-semble", "--flag"]);
    expect(servers.get("semble")?.codemode).toBe(true);
  });

  test("summary does not include tokens or keys", () => {
    const config = baseConfig();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: {
        HA_MCP_URL: "https://ha.example/api/mcp",
        HA_BEARER_TOKEN: "super-secret-token",
        EXA_API_KEY: "super-secret-exa-key",
      },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("super-secret-exa-key");
  });
});
