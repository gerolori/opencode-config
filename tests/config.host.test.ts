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
  editorOptions: { hiddenFromList?: string[]; cloneList?: boolean } = {},
) {
  const sets: string[] = [];
  const updates: string[] = [];
  const hidden = new Set(editorOptions.hiddenFromList ?? []);
  const cloneServer = (server: HostMcpServer): HostMcpServer => ({
    ...server,
    command: server.command ? [...server.command] : undefined,
    environment: server.environment ? { ...server.environment } : undefined,
    headers: server.headers ? { ...server.headers } : undefined,
  });
  const registration = { dispose: async () => {} };
  const context = {
    mcp: {
      transform: async (callback: (editor: any) => void) => {
        const editor = {
          // Simulates a 2.2.5 editor where list() omits a disabled entry but
          // get() still returns the real existing entry. With cloneList, list()
          // also returns copies so get() and update() are the only source of
          // truth for the stored entry.
          list: () =>
            [...servers.entries()]
              .filter(([name]) => !hidden.has(name))
              .map(
                ([name, server]) =>
                  [name, editorOptions.cloneList ? cloneServer(server) : server] as const,
              ),

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

describe("host config: eBay defaults", () => {
  const creds = {
    EBAY_CLIENT_ID: "ebay-client-id-value",
    EBAY_CLIENT_SECRET: "ebay-client-secret-value",
  };

  test("valid project and credentials enable the placeholder entry", () => {
    const config = baseConfig();
    const dir = "C:/work/ebay";
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      ...validDir(dir),
    });
    expect(summary.added).not.toContain("ebay");
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      dir,
      "run",
      "ebay-mcp",
    ]);
    // Effective values are set in memory so the child process does not depend
    // on re-interpolation; optional EBAY_ENV is omitted when unset.
    expect(config.mcp?.servers?.ebay?.environment).toEqual({
      EBAY_CLIENT_ID: creds.EBAY_CLIENT_ID,
      EBAY_CLIENT_SECRET: creds.EBAY_CLIENT_SECRET,
    });
    expect(config.mcp?.servers?.ebay?.environment?.EBAY_ENV).toBeUndefined();
    // No literal placeholder reaches the child environment.
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("{env:EBAY_CLIENT_ID}");
    expect(serialized).not.toContain("{env:EBAY_CLIENT_SECRET}");
    expect(serialized).not.toContain("{env:EBAY_ENV}");
  });

  test("defaults to HOME/mcp-servers/ebay when EBAY_MCP_DIR is absent", () => {
    const config = baseConfig();
    const dir = "C:/Users/me/mcp-servers/ebay";
    applyHostConfig(config, {
      platform: "win32",
      env: creds,
      homedir: "C:/Users/me",
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(normalize(config.mcp?.servers?.ebay?.command?.[2] ?? "")).toBe(dir);
  });

  test("optional EBAY_ENV is passed through and never left as a literal placeholder", () => {
    const config = baseConfig();
    const dir = "C:/work/ebay";
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.environment = {
        EBAY_CLIENT_ID: "{env:EBAY_CLIENT_ID}",
        EBAY_CLIENT_SECRET: "{env:EBAY_CLIENT_SECRET}",
        EBAY_ENV: "{env:EBAY_ENV}",
      };
    }
    applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, EBAY_ENV: "sandbox", ...creds },
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.ebay?.environment).toEqual({
      EBAY_CLIENT_ID: creds.EBAY_CLIENT_ID,
      EBAY_CLIENT_SECRET: creds.EBAY_CLIENT_SECRET,
      EBAY_ENV: "sandbox",
    });

    const unset = baseConfig();
    if (unset.mcp?.servers?.ebay) {
      unset.mcp.servers.ebay.environment = {
        EBAY_CLIENT_ID: "{env:EBAY_CLIENT_ID}",
        EBAY_CLIENT_SECRET: "{env:EBAY_CLIENT_SECRET}",
        EBAY_ENV: "{env:EBAY_ENV}",
      };
    }
    applyHostConfig(unset, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      ...validDir(dir),
    });
    expect(unset.mcp?.servers?.ebay?.environment?.EBAY_ENV).toBeUndefined();
  });

  test("enables a command already resolved from EBAY_MCP_DIR at config load", () => {
    const config = baseConfig();
    const dir = "C:/work/ebay";
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.command = ["uv", "--directory", dir, "run", "ebay-mcp"];
    }
    applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      dir,
      "run",
      "ebay-mcp",
    ]);
    expect(config.mcp?.servers?.ebay?.environment?.EBAY_CLIENT_ID).toBe(creds.EBAY_CLIENT_ID);
  });

  test("uses the default directory when the loader turned a missing placeholder into empty", () => {
    const config = baseConfig();
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.command = ["uv", "--directory", "", "run", "ebay-mcp"];
    }
    const dir = "C:/Users/me/mcp-servers/ebay";
    applyHostConfig(config, {
      platform: "win32",
      env: creds,
      homedir: "C:/Users/me",
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(normalize(config.mcp?.servers?.ebay?.command?.[2] ?? "")).toBe(dir);
  });

  test("a second transform recognizes a resolved default path and disables it when prerequisites disappear", () => {
    const config = baseConfig();
    const dir = "C:/Users/me/mcp-servers/ebay";
    const firstOptions = {
      platform: "win32" as const,
      env: creds,
      homedir: "C:/Users/me",
      ...validDir(dir),
    };
    applyHostConfig(config, firstOptions);
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(normalize(config.mcp?.servers?.ebay?.command?.[2] ?? "")).toBe(dir);

    // EBAY_MCP_DIR stays unset, so the command now contains the concrete
    // default path. A later transform with missing credentials/project must
    // still recognize it as managed and disable it rather than launching uv
    // with a path that no longer exists.
    applyHostConfig(config, {
      platform: "win32",
      env: {},
      homedir: "C:/Users/me",
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    expect(normalize(config.mcp?.servers?.ebay?.command?.[2] ?? "")).toBe(dir);
  });

  test("a second transform leaves a genuinely custom path alone when prerequisites disappear", () => {
    const config = baseConfig();
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.command = ["uv", "--directory", "C:/custom/ebay", "run", "ebay-mcp"];
      config.mcp.servers.ebay.disabled = false;
    }
    applyHostConfig(config, {
      platform: "win32",
      env: creds,
      homedir: "C:/Users/me",
      ...validDir("C:/custom/ebay"),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);

    applyHostConfig(config, {
      platform: "win32",
      env: {},
      homedir: "C:/Users/me",
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      "C:/custom/ebay",
      "run",
      "ebay-mcp",
    ]);
  });

  test("does not rewrite a user-edited eBay path when EBAY_MCP_DIR is unset", () => {
    const config = baseConfig();
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.command = ["uv", "--directory", "C:/custom/ebay", "run", "ebay-mcp"];
    }
    const defaultDir = "C:/Users/me/mcp-servers/ebay";
    applyHostConfig(config, {
      platform: "win32",
      env: creds,
      homedir: "C:/Users/me",
      ...validDir(defaultDir),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      "C:/custom/ebay",
      "run",
      "ebay-mcp",
    ]);
  });

  test("missing credentials leave the placeholder entry disabled", () => {
    const config = baseConfig();
    const dir = "C:/work/ebay";
    applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir },
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      "{env:EBAY_MCP_DIR}",
      "run",
      "ebay-mcp",
    ]);
  });

  test("missing credentials disable an already enabled managed placeholder", () => {
    const config = baseConfig();
    if (config.mcp?.servers?.ebay) config.mcp.servers.ebay.disabled = false;
    const dir = "C:/work/ebay";
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir },
      ...validDir(dir),
    });
    expect(summary.added).not.toContain("ebay");
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    // The placeholder command is preserved so a later valid environment can
    // resolve it; it is never launched while prerequisites are missing.
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      "{env:EBAY_MCP_DIR}",
      "run",
      "ebay-mcp",
    ]);
    expect(config.mcp?.servers?.ebay?.environment).toBeUndefined();
  });

  test("an enabled empty placeholder at the default path is disabled without credentials", () => {
    const config = baseConfig();
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.command = ["uv", "--directory", "", "run", "ebay-mcp"];
      config.mcp.servers.ebay.disabled = false;
    }
    const dir = "C:/Users/me/mcp-servers/ebay";
    applyHostConfig(config, {
      platform: "win32",
      env: {},
      homedir: "C:/Users/me",
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      "",
      "run",
      "ebay-mcp",
    ]);
  });

  test("both credentials are required to activate an enabled managed entry", () => {
    const dir = "C:/work/ebay";
    for (const env of [
      { EBAY_MCP_DIR: dir, EBAY_CLIENT_ID: creds.EBAY_CLIENT_ID },
      { EBAY_MCP_DIR: dir, EBAY_CLIENT_SECRET: creds.EBAY_CLIENT_SECRET },
    ]) {
      const config = baseConfig();
      if (config.mcp?.servers?.ebay) config.mcp.servers.ebay.disabled = false;
      applyHostConfig(config, {
        platform: "win32",
        env,
        ...validDir(dir),
      });
      expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
      expect(config.mcp?.servers?.ebay?.environment).toBeUndefined();
    }
  });

  test("an enabled managed placeholder is disabled when the project path is invalid", () => {
    const dir = "C:/work/not-ebay";
    const config = baseConfig();
    if (config.mcp?.servers?.ebay) config.mcp.servers.ebay.disabled = false;
    applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      isDirectory: () => true,
      hasFile: () => false,
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
  });

  test("an explicit custom enabled entry is preserved when prerequisites are missing", () => {
    const config = baseConfig();
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.command = ["custom-ebay", "--sandbox"];
      config.mcp.servers.ebay.disabled = false;
    }
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: {},
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(summary.added).not.toContain("ebay");
    expect(config.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(config.mcp?.servers?.ebay?.command).toEqual(["custom-ebay", "--sandbox"]);
  });

  test("invalid, remote, UNC, and non-project directories do not enable eBay", () => {
    for (const dir of [
      "https://example.com/ebay",
      "\\\\server\\share\\ebay",
      "mcp-servers/ebay",
    ]) {
      const config = baseConfig();
      applyHostConfig(config, {
        platform: "win32",
        env: { EBAY_MCP_DIR: dir, ...creds },
        isDirectory: () => true,
        hasFile: () => true,
      });
      expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    }
    const config = baseConfig();
    applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: "C:/work/not-ebay", ...creds },
      isDirectory: () => true,
      hasFile: () => false,
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
  });

  test("OPENCODE_DISABLE_EBAY is a one-way kill switch", () => {
    const config = baseConfig();
    const dir = "C:/work/ebay";
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.disabled = false;
      config.mcp.servers.ebay.command = ["uv", "--directory", dir, "run", "ebay-mcp"];
    }
    applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, OPENCODE_DISABLE_EBAY: "1", ...creds },
      ...validDir(dir),
    });
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    expect(config.mcp?.servers?.ebay?.command).toEqual([
      "uv",
      "--directory",
      dir,
      "run",
      "ebay-mcp",
    ]);
  });

  test("a user-defined eBay command is never rewritten or re-enabled", () => {
    const config = baseConfig();
    const dir = "C:/work/ebay";
    if (config.mcp?.servers?.ebay) {
      config.mcp.servers.ebay.command = ["custom-ebay", "--sandbox"];
      config.mcp.servers.ebay.disabled = true;
    }
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      ...validDir(dir),
    });
    expect(summary.added).not.toContain("ebay");
    expect(config.mcp?.servers?.ebay?.disabled).toBe(true);
    expect(config.mcp?.servers?.ebay?.command).toEqual(["custom-ebay", "--sandbox"]);
  });

  test("an absent entry is added only when project and credentials are valid", () => {
    const absent = baseConfig();
    if (absent.mcp?.servers) delete absent.mcp.servers.ebay;
    const dir = "C:/work/ebay";
    const summary = applyHostConfig(absent, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      ...validDir(dir),
    });
    expect(summary.added).toContain("ebay");
    expect(absent.mcp?.servers?.ebay?.disabled).toBe(false);
    expect(absent.mcp?.servers?.ebay?.environment).toEqual({
      EBAY_CLIENT_ID: creds.EBAY_CLIENT_ID,
      EBAY_CLIENT_SECRET: creds.EBAY_CLIENT_SECRET,
    });

    const noCreds = baseConfig();
    if (noCreds.mcp?.servers) delete noCreds.mcp.servers.ebay;
    applyHostConfig(noCreds, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir },
      ...validDir(dir),
    });
    expect(noCreds.mcp?.servers?.ebay).toBeUndefined();
  });

  test("registration enables only the resolved placeholder state", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["uv", "--directory", "{env:EBAY_MCP_DIR}", "run", "ebay-mcp"],
          disabled: true,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(servers, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      ...validDir(dir),
    });
    expect(sets).toEqual([]);
    expect(updates).toEqual(["ebay"]);
    expect(servers.get("ebay")?.disabled).toBe(false);
    expect(servers.get("ebay")?.command).toEqual([
      "uv",
      "--directory",
      dir,
      "run",
      "ebay-mcp",
    ]);
    expect(servers.get("ebay")?.environment).toEqual({
      EBAY_CLIENT_ID: creds.EBAY_CLIENT_ID,
      EBAY_CLIENT_SECRET: creds.EBAY_CLIENT_SECRET,
    });
  });

  test("registration is idempotent: a resolved default path stays managed across transforms", async () => {
    const dir = "C:/Users/me/mcp-servers/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["uv", "--directory", "{env:EBAY_MCP_DIR}", "run", "ebay-mcp"],
          disabled: true,
          codemode: false,
        },
      ],
    ]);
    const first = await runRegistration(servers, {
      platform: "win32",
      env: creds,
      homedir: "C:/Users/me",
      ...validDir(dir),
    });
    expect(first.updates).toEqual(["ebay"]);
    expect(servers.get("ebay")?.disabled).toBe(false);
    expect(normalize(servers.get("ebay")?.command?.[2] ?? "")).toBe(dir);

    // EBAY_MCP_DIR is still unset; the stored command now has the concrete
    // default path. Missing prerequisites must still disable it safely.
    const second = await runRegistration(servers, {
      platform: "win32",
      env: {},
      homedir: "C:/Users/me",
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(second.sets).toEqual([]);
    expect(second.updates).toEqual(["ebay"]);
    expect(servers.get("ebay")?.disabled).toBe(true);
    expect(normalize(servers.get("ebay")?.command?.[2] ?? "")).toBe(dir);
  });

  test("registration disables an enabled managed placeholder when credentials are missing", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["uv", "--directory", "{env:EBAY_MCP_DIR}", "run", "ebay-mcp"],
          disabled: false,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(servers, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir },
      ...validDir(dir),
    });
    expect(sets).toEqual([]);
    expect(updates).toEqual(["ebay"]);
    expect(servers.get("ebay")?.disabled).toBe(true);
    expect(servers.get("ebay")?.command).toEqual([
      "uv",
      "--directory",
      "{env:EBAY_MCP_DIR}",
      "run",
      "ebay-mcp",
    ]);
  });

  test("registration disables a get()-only enabled placeholder when the path is invalid", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["uv", "--directory", "", "run", "ebay-mcp"],
          disabled: false,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(
      servers,
      {
        platform: "win32",
        env: { EBAY_MCP_DIR: dir, ...creds },
        isDirectory: () => true,
        hasFile: () => false,
      },
      { hiddenFromList: ["ebay"] },
    );
    // The hidden entry is discovered through get(), then disabled in place.
    expect(sets).toEqual([]);
    expect(updates).toEqual(["ebay"]);
    expect(servers.get("ebay")?.disabled).toBe(true);
  });

  test("registration preserves an enabled custom eBay entry when prerequisites are missing", async () => {
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["custom-ebay", "--sandbox"],
          disabled: false,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(servers, {
      platform: "win32",
      env: {},
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(sets).toEqual([]);
    expect(updates).toEqual([]);
    expect(servers.get("ebay")?.disabled).toBe(false);
    expect(servers.get("ebay")?.command).toEqual(["custom-ebay", "--sandbox"]);
  });

  test("registration applies resolved command and environment when list() returns copies", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["uv", "--directory", "{env:EBAY_MCP_DIR}", "run", "ebay-mcp"],
          environment: {
            EBAY_CLIENT_ID: "{env:EBAY_CLIENT_ID}",
            EBAY_CLIENT_SECRET: "{env:EBAY_CLIENT_SECRET}",
          },
          disabled: true,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(
      servers,
      {
        platform: "win32",
        env: { EBAY_MCP_DIR: dir, ...creds },
        ...validDir(dir),
      },
      { cloneList: true },
    );
    expect(sets).toEqual([]);
    expect(updates).toEqual(["ebay"]);
    // list() copies do not share identity with get()/update(); the transform
    // must still write the resolved command, credentials, and enabled state.
    expect(servers.get("ebay")?.disabled).toBe(false);
    expect(servers.get("ebay")?.command).toEqual([
      "uv",
      "--directory",
      dir,
      "run",
      "ebay-mcp",
    ]);
    expect(servers.get("ebay")?.environment).toEqual({
      EBAY_CLIENT_ID: creds.EBAY_CLIENT_ID,
      EBAY_CLIENT_SECRET: creds.EBAY_CLIENT_SECRET,
    });
  });

  test("registration disables through update() when list() returns copies and credentials are missing", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["uv", "--directory", "{env:EBAY_MCP_DIR}", "run", "ebay-mcp"],
          disabled: false,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(
      servers,
      {
        platform: "win32",
        env: { EBAY_MCP_DIR: dir },
        ...validDir(dir),
      },
      { cloneList: true },
    );
    expect(sets).toEqual([]);
    expect(updates).toEqual(["ebay"]);
    // The disabled mutation happens on the get()/update() object, not the
    // list() copy that applyHostConfig saw.
    expect(servers.get("ebay")?.disabled).toBe(true);
    expect(servers.get("ebay")?.command).toEqual([
      "uv",
      "--directory",
      "{env:EBAY_MCP_DIR}",
      "run",
      "ebay-mcp",
    ]);
  });

  test("registration uses get() as source of truth when list() hides a disabled eBay entry", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["uv", "--directory", "{env:EBAY_MCP_DIR}", "run", "ebay-mcp"],
          environment: {
            EBAY_CLIENT_ID: "{env:EBAY_CLIENT_ID}",
            EBAY_CLIENT_SECRET: "{env:EBAY_CLIENT_SECRET}",
            EBAY_ENV: "{env:EBAY_ENV}",
          },
          disabled: true,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(
      servers,
      {
        platform: "win32",
        env: { EBAY_MCP_DIR: dir, ...creds },
        ...validDir(dir),
      },
      { hiddenFromList: ["ebay"] },
    );
    // Never treat the hidden entry as absent and overwrite it via set().
    expect(sets).toEqual([]);
    expect(updates).toEqual(["ebay"]);
    expect(servers.get("ebay")?.disabled).toBe(false);
    // The actual entry's placeholder command is replaced, not left unresolved.
    expect(servers.get("ebay")?.command).toEqual([
      "uv",
      "--directory",
      dir,
      "run",
      "ebay-mcp",
    ]);
    expect(servers.get("ebay")?.environment?.EBAY_CLIENT_ID).toBe(creds.EBAY_CLIENT_ID);
    expect(servers.get("ebay")?.environment?.EBAY_ENV).toBeUndefined();
  });

  test("a get()-only custom eBay entry is preserved even when credentials exist", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["custom-ebay", "--sandbox"],
          disabled: true,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(
      servers,
      {
        platform: "win32",
        env: { EBAY_MCP_DIR: dir, ...creds },
        ...validDir(dir),
      },
      { hiddenFromList: ["ebay"] },
    );
    expect(sets).toEqual([]);
    expect(updates).toEqual([]);
    expect(servers.get("ebay")?.disabled).toBe(true);
    expect(servers.get("ebay")?.command).toEqual(["custom-ebay", "--sandbox"]);
  });

  test("a get()-only Semble entry is not overwritten by set()", async () => {
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
    ]);
    const dir = "C:/work/semble";
    const { sets, updates } = await runRegistration(
      servers,
      {
        platform: "win32",
        env: { SEMBLE_MCP_DIR: dir },
        ...validDir(dir),
      },
      { hiddenFromList: ["semble"] },
    );
    expect(sets).toEqual([]);
    expect(updates).toEqual([]);
    expect(servers.get("semble")?.command).toEqual(["custom-semble"]);
    expect(servers.get("semble")?.disabled).toBe(true);
  });

  test("registration leaves a custom eBay entry untouched", async () => {
    const dir = "C:/work/ebay";
    const servers = new Map<string, HostMcpServer>([
      [
        "ebay",
        {
          type: "local",
          command: ["custom-ebay", "--sandbox"],
          disabled: true,
          codemode: false,
        },
      ],
    ]);
    const { sets, updates } = await runRegistration(servers, {
      platform: "win32",
      env: { EBAY_MCP_DIR: dir, ...creds },
      ...validDir(dir),
    });
    expect(sets).toEqual([]);
    expect(updates).toEqual([]);
    expect(servers.get("ebay")?.disabled).toBe(true);
    expect(servers.get("ebay")?.command).toEqual(["custom-ebay", "--sandbox"]);
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

describe("host config: Composio consumer key", () => {
  const composioUrl = "https://connect.composio.dev/mcp";

  function withComposio(server?: HostMcpServer): HostConfig {
    const config = baseConfig();
    if (server) config.mcp!.servers!.composio = server;
    return config;
  }

  test("present key injects x-consumer-api-key and disables OAuth", () => {
    const config = withComposio({
      type: "remote",
      url: composioUrl,
      oauth: {},
      disabled: false,
      codemode: true,
    });
    applyHostConfig(config, {
      platform: "win32",
      env: { COMPOSIO_CONSUMER_API_KEY: "consumer-key-value" },
    });
    const server = config.mcp?.servers?.composio;
    expect(server?.headers?.["x-consumer-api-key"]).toBe("consumer-key-value");
    expect(server?.oauth).toBe(false);
    expect(server?.disabled).toBe(false);
    expect(server?.url).toBe(composioUrl);
  });

  test("absent key preserves the existing OAuth flow", () => {
    const config = withComposio({
      type: "remote",
      url: composioUrl,
      oauth: {},
      disabled: false,
      codemode: true,
    });
    applyHostConfig(config, { platform: "win32", env: {} });
    const server = config.mcp?.servers?.composio;
    expect(server?.oauth).toEqual({});
    expect(server?.headers).toBeUndefined();
  });

  test("an absent entry is added only when the consumer key exists", () => {
    const config = withComposio();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { COMPOSIO_CONSUMER_API_KEY: "consumer-key-value" },
    });
    expect(summary.added).toContain("composio");
    expect(config.mcp?.servers?.composio?.headers?.["x-consumer-api-key"]).toBe(
      "consumer-key-value",
    );
    expect(config.mcp?.servers?.composio?.oauth).toBe(false);
  });

  test("a custom URL or extra header is treated as an explicit host override", () => {
    const config = withComposio({
      type: "remote",
      url: "https://custom.example/mcp",
      headers: { "x-tenant": "tenant-value" },
      oauth: {},
      disabled: false,
      codemode: true,
    });
    applyHostConfig(config, {
      platform: "win32",
      env: { COMPOSIO_CONSUMER_API_KEY: "consumer-key-value" },
    });
    const server = config.mcp?.servers?.composio;
    expect(server?.url).toBe("https://custom.example/mcp");
    expect(server?.headers).toEqual({ "x-tenant": "tenant-value" });
    expect(server?.oauth).toEqual({});
  });

  test("a configured OAuth object is preserved as an explicit override", () => {
    const config = withComposio({
      type: "remote",
      url: composioUrl,
      oauth: { client_id: "custom-client" },
      disabled: false,
      codemode: true,
    });
    applyHostConfig(config, {
      platform: "win32",
      env: { COMPOSIO_CONSUMER_API_KEY: "consumer-key-value" },
    });
    const server = config.mcp?.servers?.composio;
    expect(server?.oauth).toEqual({ client_id: "custom-client" });
    expect(server?.headers).toBeUndefined();
  });

  test("a disabled entry is not re-enabled or rewritten", () => {
    const config = withComposio({
      type: "remote",
      url: composioUrl,
      oauth: {},
      disabled: true,
      codemode: true,
    });
    applyHostConfig(config, {
      platform: "win32",
      env: { COMPOSIO_CONSUMER_API_KEY: "consumer-key-value" },
    });
    const server = config.mcp?.servers?.composio;
    expect(server?.disabled).toBe(true);
    expect(server?.headers).toBeUndefined();
    expect(server?.oauth).toEqual({});
  });

  test("registration applies the header in place", async () => {
    const servers = new Map<string, HostMcpServer>([
      [
        "composio",
        {
          type: "remote",
          url: composioUrl,
          oauth: {},
          disabled: false,
          codemode: true,
        },
      ],
    ]);
    const { updates } = await runRegistration(servers, {
      platform: "win32",
      env: { COMPOSIO_CONSUMER_API_KEY: "consumer-key-value" },
    });
    expect(updates).toContain("composio");
    expect(servers.get("composio")?.headers?.["x-consumer-api-key"]).toBe(
      "consumer-key-value",
    );
    expect(servers.get("composio")?.oauth).toBe(false);
  });

  test("the summary does not include the consumer key", () => {
    const config = withComposio();
    const summary = applyHostConfig(config, {
      platform: "win32",
      env: { COMPOSIO_CONSUMER_API_KEY: "super-secret-consumer-key" },
    });
    expect(JSON.stringify(summary)).not.toContain("super-secret-consumer-key");
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
