import { describe, expect, test } from "bun:test";
import { applyHostConfig, DEFAULT_HOME_ASSISTANT_URL, type HostConfig } from "../lib/host-config";

function baseConfig(): HostConfig {
  return {
    mcp: {
      sqz: {
        type: "local",
        command: ["sqz-mcp"],
        enabled: true,
      },
      semble: {
        type: "local",
        command: ["uv", "--directory", "{env:SEMBLE_MCP_DIR}", "run", "semble"],
        enabled: false,
      },
      home_assistant: {
        type: "remote",
        url: "{env:HA_MCP_URL}",
        enabled: false,
        headers: { Authorization: "Bearer {env:HA_BEARER_TOKEN}" },
      },
      exa: {
        type: "remote",
        url: "https://mcp.exa.ai/mcp",
        enabled: false,
        oauth: false,
        headers: { "x-api-key": "{env:EXA_API_KEY}" },
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

describe("host config: sqz", () => {
  test("Windows standard command selects the executable name", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "win32", env: {} });
    expect(config.mcp?.sqz?.command).toEqual(["sqz-mcp.exe"]);
  });

  test("POSIX leaves the standard command unchanged", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "linux", env: {} });
    expect(config.mcp?.sqz?.command).toEqual(["sqz-mcp"]);
  });

  test("custom commands are not rewritten", () => {
    const config = baseConfig();
    if (config.mcp?.sqz) config.mcp.sqz.command = ["custom-sqz"];
    applyHostConfig(config, { platform: "win32", env: {} });
    expect(config.mcp?.sqz?.command).toEqual(["custom-sqz"]);
  });
});

describe("host config: Semble", () => {
  test("valid SEMBLE_MCP_DIR enables the local project", () => {
    const config = baseConfig();
    const dir = "C:/work/semble";
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: dir },
      ...validDir(dir),
    });
    expect(config.mcp?.semble?.enabled).toBe(true);
    expect(config.mcp?.semble?.command).toEqual(["uv", "--directory", dir, "run", "semble"]);
  });

  test("valid HOME/mcp-servers/semble enables the local project", () => {
    const config = baseConfig();
    const dir = "C:/Users/me/mcp-servers/semble";
    applyHostConfig(config, {
      platform: "win32",
      env: {},
      homedir: "C:/Users/me",
      ...validDir(dir),
    });
    expect(config.mcp?.semble?.enabled).toBe(true);
    expect(normalize(config.mcp?.semble?.command?.[2] ?? "")).toBe(dir);
  });

  test("missing or invalid directories disable Semble", () => {
    const config = baseConfig();
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: "C:/missing/semble" },
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(config.mcp?.semble?.enabled).toBe(false);
  });

  test("remote, UNC, and relative env directories are rejected", () => {
    for (const dir of ["https://example.com/semble", "\\\\server\\share\\semble", "mcp-servers/semble"]) {
      const config = baseConfig();
      applyHostConfig(config, {
        platform: "win32",
        env: { SEMBLE_MCP_DIR: dir },
        isDirectory: () => true,
        hasFile: () => true,
      });
      expect(config.mcp?.semble?.enabled).toBe(false);
    }
  });

  test("a directory without pyproject.toml is not a valid project", () => {
    const config = baseConfig();
    const dir = "C:/work/not-semble";
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: dir },
      isDirectory: () => true,
      hasFile: () => false,
    });
    expect(config.mcp?.semble?.enabled).toBe(false);
  });

  test("OPENCODE_DISABLE_SEMBLE disables an otherwise valid project", () => {
    const config = baseConfig();
    const dir = "C:/work/semble";
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: dir, OPENCODE_DISABLE_SEMBLE: "1" },
      ...validDir(dir),
    });
    expect(config.mcp?.semble?.enabled).toBe(false);
  });

  test("custom commands are left unchanged", () => {
    const config = baseConfig();
    if (config.mcp?.semble) {
      config.mcp.semble.command = ["custom-semble"];
      config.mcp.semble.enabled = true;
    }
    applyHostConfig(config, {
      platform: "win32",
      env: { SEMBLE_MCP_DIR: "C:/missing" },
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(config.mcp?.semble?.enabled).toBe(true);
    expect(config.mcp?.semble?.command).toEqual(["custom-semble"]);
  });
});

describe("host config: Home Assistant", () => {
  test("missing token disables Home Assistant", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "win32", env: {} });
    expect(config.mcp?.home_assistant?.enabled).toBe(false);
    expect(config.mcp?.home_assistant?.url).toBe(DEFAULT_HOME_ASSISTANT_URL);
  });

  test("present token enables Home Assistant with the fallback URL", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "win32", env: { HA_BEARER_TOKEN: "token-value" } });
    expect(config.mcp?.home_assistant?.enabled).toBe(true);
    expect(config.mcp?.home_assistant?.url).toBe(DEFAULT_HOME_ASSISTANT_URL);
  });

  test("HA_MCP_URL overrides the fallback", () => {
    const config = baseConfig();
    applyHostConfig(config, {
      platform: "win32",
      env: { HA_BEARER_TOKEN: "token-value", HA_MCP_URL: "https://ha.example/api/mcp" },
    });
    expect(config.mcp?.home_assistant?.enabled).toBe(true);
    expect(config.mcp?.home_assistant?.url).toBe("https://ha.example/api/mcp");
  });

  test("an explicit custom URL is preserved", () => {
    const config = baseConfig();
    if (config.mcp?.home_assistant) config.mcp.home_assistant.url = "https://custom.example/mcp";
    applyHostConfig(config, {
      platform: "win32",
      env: { HA_BEARER_TOKEN: "token-value", HA_MCP_URL: "https://ignored.example/mcp" },
    });
    expect(config.mcp?.home_assistant?.url).toBe("https://custom.example/mcp");
  });

  test("offline configuration does not perform a network check", () => {
    const config = baseConfig();
    applyHostConfig(config, {
      platform: "win32",
      env: { HA_BEARER_TOKEN: "token-value", HA_MCP_URL: "https://offline.invalid/api/mcp" },
    });
    expect(config.mcp?.home_assistant?.enabled).toBe(true);
    expect(config.mcp?.home_assistant?.url).toBe("https://offline.invalid/api/mcp");
  });
});

describe("host config: Exa", () => {
  test("missing key keeps Exa disabled and non-OAuth", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "win32", env: {} });
    expect(config.mcp?.exa?.enabled).toBe(false);
    expect(config.mcp?.exa?.oauth).toBe(false);
  });

  test("present key enables Exa", () => {
    const config = baseConfig();
    applyHostConfig(config, { platform: "win32", env: { EXA_API_KEY: "exa-key-value" } });
    expect(config.mcp?.exa?.enabled).toBe(true);
    expect(config.mcp?.exa?.oauth).toBe(false);
  });

  test("an explicit enabled flag without a key is not kept", () => {
    const config = baseConfig();
    if (config.mcp?.exa) config.mcp.exa.enabled = true;
    applyHostConfig(config, { platform: "win32", env: {} });
    expect(config.mcp?.exa?.enabled).toBe(false);
  });
});

describe("host config: no secret leakage", () => {
  test("summary does not include tokens or keys", () => {
    const config = baseConfig();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: {
        HA_BEARER_TOKEN: "super-secret-token",
        EXA_API_KEY: "super-secret-exa-key",
      },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("super-secret-exa-key");
  });
});
