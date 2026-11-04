import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { Info } from "@opencode/schema/config";
import { applyHostConfig, type HostConfig } from "../lib/host-config";

const root = join(import.meta.dir, "..");

function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += char;
  }

  return out;
}

function loadJsonc(path: string): unknown {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

const rawText = readFileSync(join(root, "opencode.jsonc"), "utf8");
const raw = loadJsonc(join(root, "opencode.jsonc"));
const config = Schema.decodeUnknownSync(Info)(raw) as Record<string, any>;
const agents = config.agents as Record<string, any>;
const servers = config.mcp.servers as Record<string, any>;
const workers = ["code", "review", "explore", "fetch", "track", "composio"];

function allowedSubagents(agent: Record<string, any>): string[] {
  return (agent.permissions ?? [])
    .filter((rule: any) => rule.action === "subagent" && rule.effect === "allow")
    .map((rule: any) => rule.resource)
    .sort();
}

describe("native schema", () => {
  test("the config decodes with the installed 2.2.5 schema", () => {
    expect(config).toBeDefined();
    expect(config.$schema).toBe("https://opencode.ai/config.json");
  });

  test("legacy top-level keys are gone before schema decoding", () => {
    const rawConfig = raw as Record<string, any>;
    for (const key of [
      "autoupdate",
      "agent",
      "provider",
      "permission",
      "plugin",
      "small_model",
      "subagent_depth",
      "command",
    ]) {
      expect(rawConfig[key]).toBeUndefined();
    }
  });

  test("native update, model, compaction, websearch, plugins, depth, and todo", () => {
    expect(config.update).toBe("disable");
    expect(config.model).toEqual({ providerID: "openrouter", model: "gpt-6-luna", variant: "high" });
    expect(config.compaction).toEqual({ auto: true, keep: { tokens: 40000 }, buffer: 100000 });
    expect(config.websearch).toEqual({ provider: "tinyfish" });
    expect(config.plugins).toEqual([
      "@tarquinen/opencode-dcp@3.2.0",
      "cc-safety-net@2.7.2",
    ]);
    expect(config.default_agent).toBe("build");
    expect(config.experimental.subagent_depth).toBe(1);
    expect(config.experimental.todo).toBe(true);
  });
});

describe("providers and reasoning", () => {
  test("OpenRouter wire IDs and reasoning effort capabilities are explicit", () => {
    const models = config.providers.openrouter.models;
    expect(config.providers.openrouter.package).toBe("@opencode/ai/providers/openrouter");
    expect(models["gpt-6-luna"].modelID).toBe("openai/gpt-6-luna");
    expect(models["gpt-5.6-luna"].modelID).toBe("openai/gpt-5.6-luna");
    expect(models["deepseek-v4.1-flash"].modelID).toBe("deepseek/deepseek-v4.1-flash:floor");
    expect(models["gpt-6-luna"].capabilities.reasoning).toEqual({
      supported: true,
      effort: ["low", "high", "max"],
    });
    expect(models["deepseek-v4.1-flash"].capabilities.reasoning.effort).toContain("low");
  });

  test("agent model selections use declared custom keys and variants", () => {
    expect(agents.build.model).toEqual({ providerID: "openrouter", model: "gpt-6-luna", variant: "high" });
    expect(agents.plan.model).toEqual(agents.build.model);
    for (const name of ["code", "review", "composio", "fetch", "explore", "track"]) {
      expect(agents[name].model.model).toBe("deepseek-v4.1-flash");
      expect(agents[name].model.variant).toBe("low");
    }
    for (const name of Object.keys(agents)) {
      if (agents[name].disabled) continue;
      const ref = agents[name].model;
      expect(config.providers.openrouter.models[ref.model]).toBeDefined();
      expect(ref.providerID).toBe("openrouter");
    }
  });

  test("request bodies preserve per-agent temperatures", () => {
    expect(agents.build.request.body.temperature).toBe(0.2);
    expect(agents.plan.request.body.temperature).toBe(0.25);
    expect(agents.code.request.body.temperature).toBe(0.35);
    expect(agents.fetch.request.body.temperature).toBe(0.1);
  });
});

describe("agents", () => {
  test("two primaries and six enabled subagents, with general disabled", () => {
    expect(Object.keys(agents).sort()).toEqual([
      "build",
      "code",
      "composio",
      "explore",
      "fetch",
      "general",
      "plan",
      "review",
      "track",
    ]);
    expect(agents.general.disabled).toBe(true);
    const enabled = Object.entries(agents)
      .filter(([, agent]) => !(agent as any).disabled)
      .map(([name]) => name)
      .sort();
    expect(enabled).toEqual(["build", "code", "composio", "explore", "fetch", "plan", "review", "track"]);
    expect(agents.build.mode).toBe("primary");
    expect(agents.plan.mode).toBe("primary");
    for (const name of workers) expect(agents[name].mode).toBe("subagent");
    expect(agents.research).toBeUndefined();
  });

  test("subagent allowlists preserve the build/plan boundary", () => {
    expect(allowedSubagents(agents.build)).toEqual([
      "code",
      "composio",
      "explore",
      "fetch",
      "review",
      "track",
    ]);
    expect(allowedSubagents(agents.plan)).toEqual(["composio", "explore", "fetch", "track"]);
    for (const name of workers) expect(allowedSubagents(agents[name])).toEqual([]);
  });

  test("fetch has a modest step budget", () => {
    expect(agents.fetch.steps).toBe(10);
  });

  test("the resolved agent list excludes general and preserves internal helpers", () => {
    const command = process.platform === "win32" ? "opencode.cmd" : "opencode";
    const result = spawnSync(command, ["debug", "agents"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const resolved = JSON.parse(result.stdout) as Array<{ id: string }>;
    const ids = resolved.map((agent) => agent.id).sort();
    expect(ids).not.toContain("general");
    expect(ids).toEqual(
      expect.arrayContaining([
        "build",
        "code",
        "composio",
        "explore",
        "fetch",
        "plan",
        "review",
        "track",
        "compaction",
        "summary",
        "title",
      ]),
    );
  });
});

describe("MCP native shape", () => {
  test("servers use disabled/codemode and no legacy enabled flag", () => {
    expect(Object.keys(servers).sort()).toEqual([
      "composio",
      "context7",
      "duckduckgo",
      "ebay",
      "gh_grep",
      "sqz",
    ]);
    for (const server of Object.values(servers)) {
      expect((server as any).enabled).toBeUndefined();
    }
    // `disabled` is a user-mutable UI/config toggle. Rather than asserting the
    // current working-copy value, verify the safety invariant the host
    // transform owns: a managed eBay entry is disabled when prerequisites are
    // absent, regardless of the toggle the user currently has.
    const ebayMissingPrereqs: HostConfig = {
      mcp: { servers: { ebay: structuredClone(servers.ebay) } },
    };
    applyHostConfig(ebayMissingPrereqs, {
      platform: "win32",
      env: {},
      homedir: "C:/Users/example",
      isDirectory: () => false,
      hasFile: () => false,
    });
    expect(ebayMissingPrereqs.mcp?.servers?.ebay?.disabled).toBe(true);
    for (const name of ["context7", "gh_grep", "sqz", "duckduckgo", "composio"]) {
      expect(servers[name].disabled).toBe(false);
    }
    for (const name of ["exa", "semble", "home_assistant"]) {
      expect(servers[name]).toBeUndefined();
    }
  });

  test("Code Mode is explicit for MCP providers and direct for SQZ/eBay", () => {
    for (const name of ["context7", "gh_grep", "duckduckgo", "composio"]) {
      expect(servers[name].codemode).toBe(true);
    }
    expect(servers.sqz.codemode).toBe(false);
    expect(servers.ebay.codemode).toBe(false);
  });

  test("portable base commands; conditional servers are host-added", () => {
    expect(servers.sqz.command).toEqual(["sqz-mcp"]);
    expect(servers.ebay.command.join(" ")).toContain("{env:EBAY_MCP_DIR}");
    expect(rawText).not.toContain("homeassistant.gerosalorenzo.com");
  });

  test("custom TinyFish search is superseded by native websearch", () => {
    expect(rawText).not.toContain("tinyfish_search");
    expect(config.websearch.provider).toBe("tinyfish");
  });
});

describe("DCP and public CLI config", () => {
  test("DCP keeps thresholds and protects native subagent", () => {
    const dcp = loadJsonc(join(root, "dcp.jsonc")) as Record<string, any>;
    expect(dcp.autoUpdate).toBe(false);
    expect(dcp.compress.maxContextLimit).toBe(800000);
    expect(dcp.compress.minContextLimit).toBe(500000);
    expect(dcp.compress.nudgeForce).toBe("soft");
    expect(dcp.compress.protectedTools).toEqual(
      expect.arrayContaining(["task", "subagent", "skill", "read", "glob", "grep", "edit", "write"]),
    );
    expect(dcp.strategies.deduplication.protectedTools).toEqual(
      expect.arrayContaining(["task", "subagent", "skill", "edit", "write"]),
    );
  });

  test("public cli.json is a UI-only configuration", () => {
    const cli = loadJsonc(join(root, "cli.json")) as Record<string, any>;
    expect(cli.$schema).toBe("https://opencode.ai/v2/cli.json");
    expect(cli.theme.name).toBe("system");
    expect(cli.diffs.wrap).toBe("word");
    expect(cli.session.sidebar).toBe("auto");
    expect(cli.session.scrollbar).toBe(false);
    expect(cli.session.thinking).toBe("show");
    expect(cli.animations).toBe(true);
  });
});

describe("permission actions", () => {
  test("native action names are used instead of legacy aliases", () => {
    const actions = new Set<string>();
    const collect = (rules: any[]) => rules.forEach((rule) => actions.add(rule.action));
    collect(config.permissions);
    for (const name of Object.keys(agents)) collect(agents[name].permissions ?? []);
    for (const action of ["subagent", "shell", "edit"]) expect(actions.has(action)).toBe(true);
    for (const action of ["task", "bash", "write", "patch", "apply_patch", "canvas_*", "plan_enter", "plan_exit"]) {
      expect(actions.has(action)).toBe(false);
    }
  });

  test("eBay is fetch-only and Semble is explore-only", () => {
    const allows = (agent: string, action: string) =>
      (agents[agent].permissions ?? []).some(
        (rule: any) =>
          rule.action === action && rule.resource === "*" && rule.effect === "allow",
      );

    expect(config.permissions).toContainEqual({
      action: "ebay_*",
      resource: "*",
      effect: "deny",
    });
    expect(allows("fetch", "ebay_*")).toBe(true);
    for (const name of ["build", "plan", "code", "review", "explore", "track", "composio"]) {
      expect(allows(name, "ebay_*")).toBe(false);
    }

    expect(config.permissions).toContainEqual({
      action: "semble_*",
      resource: "*",
      effect: "deny",
    });
    expect(allows("explore", "semble_*")).toBe(true);
    for (const name of ["build", "plan", "code", "review", "fetch", "track", "composio"]) {
      expect(allows(name, "semble_*")).toBe(false);
    }
  });

  test("the global deny is first and read keeps the .env approval convention", () => {
    expect(config.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    const readRules = config.permissions.filter((rule: any) => rule.action === "read");
    expect(readRules).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]);
  });
});

describe("prompts, commands, and host example", () => {
  test("research is retired and worker markdown matches native modes", () => {
    expect(agents.research).toBeUndefined();
    expect(existsSync(join(root, "agents", "research.md"))).toBe(false);
    for (const name of ["build", "plan"]) {
      expect(readFileSync(join(root, "agents", `${name}.md`), "utf8")).toContain("mode: primary");
    }
    for (const name of workers) {
      expect(readFileSync(join(root, "agents", `${name}.md`), "utf8")).toContain("mode: subagent");
    }
  });

  test("commands stay on plan/build and use the subagent tool", () => {
    for (const name of ["claim", "triage"]) {
      const markdown = readFileSync(join(root, "commands", `${name}.md`), "utf8");
      expect(markdown).toContain("agent: plan");
      expect(markdown).toContain("`subagent` tool");
      expect(markdown).not.toContain("task tool");
    }
    const worktree = readFileSync(join(root, "commands", "worktree.md"), "utf8");
    expect(worktree).toContain("agent: build");
    expect(worktree).toContain("`subagent` tool");
  });

  test("the tracked host example decodes and contains no credentials", () => {
    const exampleText = readFileSync(join(root, "opencode.host.example.jsonc"), "utf8");
    const example = Schema.decodeUnknownSync(Info)(loadJsonc(join(root, "opencode.host.example.jsonc"))) as Record<string, any>;
    expect(example.mcp.servers.semble.disabled).toBe(true);
    // eBay is host-added only when its prerequisites exist; a pinned disabled
    // entry would suppress that activation.
    expect(example.mcp.servers.ebay).toBeUndefined();
    expect(exampleText).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(exampleText).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
  });
});
