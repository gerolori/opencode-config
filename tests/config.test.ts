import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

type JsonObject = Record<string, unknown>;

type ModelConfig = {
  id?: string;
  reasoning?: boolean;
  options?: Record<string, unknown>;
  [key: string]: unknown;
};

type McpConfig = {
  type?: string;
  url?: string;
  command?: string[];
  enabled?: boolean;
  oauth?: boolean | JsonObject;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
};

type AgentConfig = {
  mode?: string;
  model?: string;
  hidden?: boolean;
  steps?: number;
  options?: { reasoningEffort?: string; reasoningSummary?: string };
  reasoningEffort?: string;
  permission?: Record<string, unknown>;
  description?: string;
  temperature?: number;
  [key: string]: unknown;
};

type Config = {
  autoupdate?: boolean;
  model?: string;
  small_model?: string;
  compaction?: {
    auto?: boolean;
    preserve_recent_tokens?: number;
    reserved?: number;
    keep?: unknown;
    buffer?: unknown;
  };
  subagent_depth?: number;
  default_agent?: string;
  plugin?: string[];
  command?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  provider?: {
    openrouter?: {
      options?: Record<string, unknown>;
      models?: Record<string, ModelConfig>;
    };
  };
  mcp?: Record<string, McpConfig>;
  agent: Record<string, AgentConfig>;
};

export function stripJsonComments(input: string): string {
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

export function loadJsonc(path: string): unknown {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

function taskMap(agent: AgentConfig): Record<string, string> {
  return (agent.permission?.task as Record<string, string> | undefined) ?? {};
}

const config = loadJsonc(join(root, "opencode.jsonc")) as Config;
const agents = config.agent;
const workers = ["code", "review", "explore", "fetch", "track", "composio"];

describe("top-level config", () => {
  test("runtime drift is disabled and the depth is one", () => {
    expect(config.autoupdate).toBe(false);
    expect(config.subagent_depth).toBe(1);
    expect(config.default_agent).toBe("build");
  });

  test("main and small models are explicit and usable", () => {
    expect(config.model).toBe("openrouter/gpt-6-luna");
    expect(config.small_model).toBe("openrouter/deepseek-v4.1-flash");
    expect(config.provider?.openrouter?.models?.["deepseek-v4.1-flash"]).toBeDefined();
  });

  test("every model reference resolves to a declared custom key", () => {
    const models = config.provider?.openrouter?.models ?? {};
    const refs = [
      config.model,
      config.small_model,
      ...Object.values(agents).map((agent) => agent.model),
    ].filter((ref): ref is string => typeof ref === "string");
    for (const ref of refs) {
      const [provider, ...rest] = ref.split("/");
      expect(provider).toBe("openrouter");
      expect(models[rest.join("/")]).toBeDefined();
    }
  });

  test("compaction keeps the validated thresholds in canonical keys", () => {
    expect(config.compaction).toEqual({
      auto: true,
      preserve_recent_tokens: 40000,
      reserved: 100000,
    });
    expect(config.compaction?.keep).toBeUndefined();
    expect(config.compaction?.buffer).toBeUndefined();
  });

  test("the plugin list is pinned to locally cached versions", () => {
    expect(config.plugin).toEqual([
      "@tarquinen/opencode-dcp@3.1.9",
      "@franlol/opencode-md-table-formatter@0.0.3",
      "cc-safety-net@0.8.2",
      "@tarquinen/opencode-smart-title@0.1.7",
      "@bastiangx/opencode-unmoji@0.3.12",
      "opencode-ntfy.sh@1.1.0",
    ]);
    expect(config.plugin?.some((entry) => entry.endsWith("@latest"))).toBe(false);
    expect(config.plugin?.filter((entry) => entry.toLowerCase().includes("sqz"))).toEqual([]);
  });

  test("the nonexistent mystatus command is removed", () => {
    expect(config.command?.mystatus).toBeUndefined();
  });

  test("DCP auto-update is disabled without changing compression knobs", () => {
    const dcp = loadJsonc(join(root, "dcp.jsonc")) as {
      autoUpdate?: boolean;
      compress?: { maxContextLimit?: number; minContextLimit?: number; permission?: string };
    };
    expect(dcp.autoUpdate).toBe(false);
    expect(dcp.compress?.maxContextLimit).toBe(800000);
    expect(dcp.compress?.minContextLimit).toBe(500000);
    expect(dcp.compress?.permission).toBe("allow");
  });
});

describe("agent topology", () => {
  test("exactly two primaries: build and plan", () => {
    expect(Object.keys(agents).sort()).toEqual([
      "build",
      "code",
      "composio",
      "explore",
      "fetch",
      "plan",
      "review",
      "track",
    ]);
    const primaries = Object.entries(agents)
      .filter(([, agent]) => agent.mode === "primary")
      .map(([name]) => name)
      .sort();
    expect(primaries).toEqual(["build", "plan"]);
  });

  test("all six workers are subagents with explicit task deny", () => {
    for (const name of workers) {
      expect(agents[name].mode).toBe("subagent");
      expect(taskMap(agents[name])).toEqual({ "*": "deny" });
    }
  });

  test("research is retired", () => {
    expect(agents.research).toBeUndefined();
    expect(existsSync(join(root, "agents", "research.md"))).toBe(false);
  });

  test("build delegates only the approved workers", () => {
    const map = taskMap(agents.build);
    expect(Object.keys(map)[0]).toBe("*");
    expect(map["*"]).toBe("deny");
    expect(Object.keys(map).filter((key) => key !== "*").sort()).toEqual([
      "code",
      "composio",
      "explore",
      "fetch",
      "review",
      "track",
    ]);
  });

  test("plan delegates explore/fetch/track/composio but not code", () => {
    const map = taskMap(agents.plan);
    expect(Object.keys(map)[0]).toBe("*");
    expect(map["*"]).toBe("deny");
    expect(Object.keys(map).filter((key) => key !== "*").sort()).toEqual([
      "composio",
      "explore",
      "fetch",
      "track",
    ]);
    expect(map.code).toBeUndefined();
  });

  test("track is callable from both primaries", () => {
    expect(taskMap(agents.build).track).toBe("allow");
    expect(taskMap(agents.plan).track).toBe("allow");
    expect(agents.track.mode).toBe("subagent");
  });
});

describe("models", () => {
  test("worker weights are explicit and canonical", () => {
    const models = config.provider?.openrouter?.models ?? {};
    expect(models["deepseek-v4.1-flash-1017"]?.id).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(models["deepseek-v4.1-flash"]?.id).toBe("deepseek/deepseek-v4.1-flash");
    expect(models["deepseek-v4.1-flash-1017"]?.reasoning).toBe(true);
    expect(models["deepseek-v4.1-flash"]?.reasoning).toBe(true);
  });

  test("main model key and expected wire ids are explicit", () => {
    const models = config.provider?.openrouter?.models ?? {};
    expect(models["gpt-6-luna"]?.id).toBe("openai/gpt-6-luna");
    expect(models["gpt-5.6-luna"]?.id).toBe("openai/gpt-5.6-luna");
    expect(config.model).toBe("openrouter/gpt-6-luna");
    expect(agents.build.model).toBe("openrouter/gpt-6-luna");
    expect(agents.plan.model).toBe("openrouter/gpt-6-luna");
  });

  test("code/review/composio keep 1017; fetch/explore/track keep old Flash", () => {
    for (const name of ["code", "review", "composio"]) {
      expect(agents[name].model).toBe("openrouter/deepseek-v4.1-flash-1017");
    }
    for (const name of ["fetch", "explore", "track"]) {
      expect(agents[name].model).toBe("openrouter/deepseek-v4.1-flash");
    }
  });

  test("reasoning effort uses supported public levels in options only", () => {
    for (const name of workers) {
      expect(agents[name].options?.reasoningEffort).toBe("low");
      expect(agents[name].reasoningEffort).toBeUndefined();
    }
    for (const name of ["build", "plan"]) {
      expect(agents[name].options?.reasoningEffort).toBe("high");
      expect(agents[name].reasoningEffort).toBeUndefined();
    }
  });

  test("no provider price/order pin is added", () => {
    expect(config.provider?.openrouter?.options).toEqual({});
  });
});

describe("instructions and agent prompts", () => {
  test("BEADS is a lazy pointer, not the heavy reference", () => {
    const beads = readFileSync(join(root, "instructions", "BEADS.md"), "utf8");
    expect(beads.length).toBeLessThan(2000);
    expect(beads).toContain("beads-br");
    expect(beads).toContain("beads-bv");
    expect(beads).toContain("On Windows only");
    expect(beads).not.toContain("br create --no-db");
  });

  test("agent markdown declares the same mode as the config", () => {
    for (const name of ["build", "plan"]) {
      const markdown = readFileSync(join(root, "agents", `${name}.md`), "utf8");
      expect(markdown).toContain("mode: primary");
    }
    for (const name of workers) {
      const markdown = readFileSync(join(root, "agents", `${name}.md`), "utf8");
      expect(markdown).toContain("mode: subagent");
    }
  });
});
