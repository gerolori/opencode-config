import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

type JsonObject = Record<string, unknown>;

type AgentConfig = {
  mode?: string;
  steps?: number;
  options?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  [key: string]: unknown;
};

type Config = {
  permission?: Record<string, unknown>;
  mcp?: Record<string, {
    enabled?: boolean;
    oauth?: boolean | JsonObject;
    command?: string[];
    headers?: Record<string, string>;
    environment?: Record<string, string>;
    url?: string;
  }>;
  agent: Record<string, AgentConfig>;
};

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function stringEntries(map: Record<string, unknown> | undefined): Array<[string, string]> {
  return Object.entries(map ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

function patternEntries(value: unknown): Array<[string, string]> {
  if (typeof value === "string") return [["*", value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

function decide(agent: AgentConfig, tool: string): string {
  const entries = [
    ...stringEntries(config.permission),
    ...stringEntries(agent.permission),
  ];
  let action = "deny";
  for (const [pattern, candidate] of entries) {
    if (globMatch(pattern, tool)) action = candidate;
  }
  return action;
}

function decideRead(agent: AgentConfig, path: string): string {
  const entries = [
    ...patternEntries(config.permission?.read),
    ...patternEntries(agent.permission?.read),
  ];
  let action = "deny";
  for (const [pattern, candidate] of entries) {
    if (globMatch(pattern, path)) action = candidate;
  }
  return action;
}

function decideBash(agent: AgentConfig, command: string): string {
  const entries = patternEntries(agent.permission?.bash);
  let action = "deny";
  for (const [pattern, candidate] of entries) {
    if (globMatch(pattern, command)) action = candidate;
  }
  return action;
}

function bashMap(agent: AgentConfig): Record<string, string> {
  return (agent.permission?.bash as Record<string, string> | undefined) ?? {};
}

function taskMap(agent: AgentConfig): Record<string, string> {
  return (agent.permission?.task as Record<string, string> | undefined) ?? {};
}

const config = loadJsonc(join(root, "opencode.jsonc")) as Config;
const agents = config.agent;
const workers = ["code", "review", "explore", "fetch", "track", "composio"];
const externalPatterns = [
  "websearch",
  "websearch_cited",
  "webfetch",
  "context7_*",
  "exa_*",
  "gh_grep_*",
  "duckduckgo_*",
  "semble_*",
  "composio_*",
  "ebay_*",
  "home_assistant_*",
  "tinyfish_search",
  "retrieval_control",
];

describe("global permission posture", () => {
  test("unknown tools are denied first", () => {
    expect(Object.keys(config.permission ?? {})[0]).toBe("*");
    expect(config.permission?.["*"]).toBe("deny");
  });

  test("external surfaces are denied by default", () => {
    for (const pattern of externalPatterns) {
      expect(config.permission?.[pattern]).toBe("deny");
    }
    expect(config.permission?.task).toBe("deny");
    expect(config.permission?.sqz).toBe("allow");
  });

  test("read keeps the .env approval convention", () => {
    const read = config.permission?.read as Record<string, string>;
    expect(read["*"]).toBe("allow");
    expect(read["*.env"]).toBe("ask");
    expect(read["*.env.*"]).toBe("ask");
    expect(read["*.env.example"]).toBe("allow");
  });

  test("unknown external namespaces are denied for every agent", () => {
    for (const name of Object.keys(agents)) {
      expect(decide(agents[name], "new_namespace_search")).toBe("deny");
    }
  });
});

describe("main agent tools", () => {
  test("build and plan retain read/question/task/skill/todos", () => {
    for (const name of ["build", "plan"]) {
      expect(decideRead(agents[name], "src/main.ts")).toBe("allow");
      expect(decideRead(agents[name], ".env")).toBe("ask");
      expect(decide(agents[name], "question")).toBe("allow");
      expect(decide(agents[name], "skill")).toBe("allow");
      expect(decide(agents[name], "todowrite")).toBe("allow");
      expect(decide(agents[name], "plan_enter")).toBe("allow");
      expect(decide(agents[name], "plan_exit")).toBe("allow");
      expect(decide(agents[name], "compress")).toBe("allow");
      expect(decide(agents[name], "sqz_sqz_read_file")).toBe("allow");
      expect(decide(agents[name], "sqz_sqz_list_dir")).toBe("allow");
      expect(decide(agents[name], "sqz_sqz_grep")).toBe("allow");
      expect(decide(agents[name], "sqz_expand")).toBe("allow");
      expect(taskMap(agents[name])["*"]).toBe("deny");
    }
  });

  test("per-agent allows override the global deny", () => {
    expect(decide(agents.build, "home_assistant_intent__HassTurnOn")).toBe("allow");
    expect(decide(agents.build, "retrieval_control")).toBe("allow");
    expect(decide(agents.build, "composio_search_tools")).toBe("deny");
    expect(decide(agents.plan, "home_assistant_intent__HassTurnOn")).toBe("deny");
    expect(decide(agents.plan, "retrieval_control")).toBe("allow");
    expect(decide(agents.explore, "semble_search")).toBe("allow");
    expect(decide(agents.composio, "composio_search_tools")).toBe("allow");
    expect(decide(agents.fetch, "webfetch")).toBe("allow");
  });
});

describe("worker least privilege", () => {
  test("code and review have no external web/MCP", () => {
    for (const name of ["code", "review"]) {
      for (const pattern of externalPatterns) {
        expect(decide(agents[name], pattern.replace("*", "x"))).toBe("deny");
      }
    }
  });

  test("fetch allows only its retrieval surfaces and no local read leak", () => {
    for (const pattern of [
      "websearch",
      "websearch_cited",
      "webfetch",
      "context7_query-docs",
      "exa_web_search_exa",
      "gh_grep_searchGitHub",
      "duckduckgo_search",
      "tinyfish_search",
      "retrieval_control",
    ]) {
      expect(decide(agents.fetch, pattern)).toBe("allow");
    }
    for (const pattern of ["semble_search", "composio_search_tools", "ebay_search", "home_assistant_intent__HassTurnOn"]) {
      expect(decide(agents.fetch, pattern)).toBe("deny");
    }
    expect(decideRead(agents.fetch, "src/main.ts")).toBe("deny");
    expect(decide(agents.fetch, "skill")).toBe("deny");
    expect(decide(agents.fetch, "sqz_sqz_read_file")).toBe("deny");
    expect(decide(agents.fetch, "sqz_sqz_list_dir")).toBe("deny");
    expect(decide(agents.fetch, "sqz_sqz_grep")).toBe("deny");
    expect(decide(agents.fetch, "sqz_expand")).toBe("deny");
    expect(agents.fetch.steps).toBe(10);
  });

  test("code keeps local edit/bash tools but denies obvious web fetches", () => {
    expect(decide(agents.code, "skill")).toBe("allow");
    expect(decide(agents.code, "sqz_sqz_read_file")).toBe("allow");
    expect(decide(agents.code, "sqz_expand")).toBe("allow");
    expect(decideRead(agents.code, ".env")).toBe("ask");
    expect(decideBash(agents.code, "bun test")).toBe("allow");
    expect(decideBash(agents.code, "npm install")).toBe("allow");
    expect(decideBash(agents.code, "curl https://example.com")).toBe("deny");
    expect(decideBash(agents.code, "wget https://example.com")).toBe("deny");
    expect(decideBash(agents.code, "Invoke-WebRequest https://example.com")).toBe("deny");
    expect(decideBash(agents.code, "Invoke-RestMethod https://example.com")).toBe("deny");
    expect(decideBash(agents.code, "git clone https://example.com/repo")).toBe("deny");
  });

  test("review and explore stay read-only", () => {
    expect(decideBash(agents.review, "git status")).toBe("allow");
    expect(decideBash(agents.review, "rm -rf src")).toBe("deny");
    expect(decideBash(agents.explore, "ls src")).toBe("allow");
    expect(decideBash(agents.explore, "curl https://example.com")).toBe("deny");
    expect(decide(agents.explore, "skill")).toBe("deny");
  });

  test("composio owns only the Composio surface", () => {
    expect(decide(agents.composio, "composio_search_tools")).toBe("allow");
    expect(decide(agents.composio, "webfetch")).toBe("deny");
    expect(decide(agents.composio, "bash")).toBe("deny");
    expect(decide(agents.composio, "skill")).toBe("allow");
    expect(decide(agents.composio, "sqz_sqz_read_file")).toBe("deny");
    expect(decide(agents.composio, "sqz_expand")).toBe("deny");
  });
});

describe("catchall-first shell maps", () => {
  test("review allows only read-only git inspection", () => {
    const map = bashMap(agents.review);
    expect(Object.keys(map)[0]).toBe("*");
    expect(map["*"]).toBe("deny");
    expect(map["git status*"]).toBe("allow");
    expect(map["git diff*"]).toBe("allow");
    expect(map["git log*"]).toBe("allow");
  });

  test("explore allows only local inspection and Semble", () => {
    const map = bashMap(agents.explore);
    expect(Object.keys(map)[0]).toBe("*");
    expect(map["*"]).toBe("deny");
    expect(map["ls *"]).toBe("allow");
    expect(map["tree *"]).toBe("allow");
    expect(map["cat *"]).toBe("allow");
    expect(map["grep *"]).toBe("allow");
    expect(map["rg *"]).toBe("allow");
    expect(decide(agents.explore, "semble_search")).toBe("allow");
  });

  test("track allows br queries and bv robot commands only", () => {
    const map = bashMap(agents.track);
    expect(Object.keys(map)[0]).toBe("*");
    expect(map["*"]).toBe("deny");
    expect(map["br *"]).toBe("allow");
    expect(map["bv --robot-*"]).toBe("allow");
    expect(map["bv *--no-db*"]).toBe("deny");
    expect(map["br delete*"]).toBe("ask");
    expect(map["br close*"]).toBe("ask");

    expect(decideBash(agents.track, "br list --no-db")).toBe("allow");
    expect(decideBash(agents.track, "br create --no-db --no-auto-flush --title=x")).toBe("allow");
    expect(decideBash(agents.track, "br close abc")).toBe("ask");
    expect(decideBash(agents.track, "br delete abc")).toBe("ask");
    expect(decideBash(agents.track, "bv --robot-triage")).toBe("allow");
    expect(decideBash(agents.track, "bv --robot-plan --label backend")).toBe("allow");
    expect(decideBash(agents.track, "bv install")).toBe("deny");
    expect(decideBash(agents.track, "bv")).toBe("deny");
    expect(decideBash(agents.track, "bv --no-db --robot-triage")).toBe("deny");
    expect(decideBash(agents.track, "bv --robot-triage --no-db")).toBe("deny");
    expect(decideBash(agents.track, "git status")).toBe("deny");
    expect(decide(agents.track, "sqz_expand")).toBe("deny");
  });
});

describe("portability", () => {
  test("MCP commands use PATH or env references, not Windows absolutes", () => {
    const text = readFileSync(join(root, "opencode.jsonc"), "utf8");
    expect(text).not.toContain("C:/Users");
    expect(text).not.toContain("C:\\Users");
    expect(config.mcp?.sqz?.command).toEqual(["sqz-mcp"]);
    expect(config.mcp?.duckduckgo?.command?.[0]).toBe("uvx");
    expect(config.mcp?.semble?.command?.join(" ")).toContain("{env:SEMBLE_MCP_DIR}");
    expect(config.mcp?.ebay?.command?.join(" ")).toContain("{env:EBAY_MCP_DIR}");
  });

  test("host-local servers are disabled in the base config", () => {
    expect(config.mcp?.semble?.enabled).toBe(false);
    expect(config.mcp?.ebay?.enabled).toBe(false);
    expect(config.mcp?.home_assistant?.enabled).toBe(false);
    expect(config.mcp?.home_assistant?.url).toBe("{env:HA_MCP_URL}");
  });

  test("Exa is disabled, non-OAuth, and key-gated", () => {
    expect(config.mcp?.exa?.enabled).toBe(false);
    expect(config.mcp?.exa?.oauth).toBe(false);
    expect(config.mcp?.exa?.headers?.["x-api-key"]).toBe("{env:EXA_API_KEY}");
  });

  test("Composio stays enabled and TinyFish stays a plugin tool", () => {
    expect(config.mcp?.composio?.enabled).toBe(true);
    expect(config.mcp?.tinyfish).toBeUndefined();
  });

  test("the tracked host example is valid and credential-free", () => {
    const exampleText = readFileSync(join(root, "opencode.host.example.jsonc"), "utf8");
    const example = loadJsonc(join(root, "opencode.host.example.jsonc")) as Config;
    expect(example.mcp?.semble?.enabled).toBe(true);
    expect(example.mcp?.semble?.command?.join(" ")).toContain("{env:SEMBLE_MCP_DIR}");
    expect(example.mcp?.ebay?.enabled).toBe(false);
    expect(exampleText).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(exampleText).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
  });
});

describe("commands", () => {
  test("triage and claim stay on plan and delegate to track", () => {
    for (const name of ["triage", "claim"]) {
      const markdown = readFileSync(join(root, "commands", `${name}.md`), "utf8");
      expect(markdown).toContain("agent: plan");
      expect(markdown).toContain("track");
      expect(markdown).not.toContain("agent: track");
    }
  });
});
