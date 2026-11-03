import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { Info } from "@opencode/schema/config";

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

const raw = loadJsonc(join(root, "opencode.jsonc"));
const config = Schema.decodeUnknownSync(Info)(raw) as Record<string, any>;
const agents = config.agents as Record<string, any>;

function match(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", "s").test(normalized);
}

function evaluate(rules: any[], action: string, resource: string): string {
  return (
    [...rules]
      .reverse()
      .find((rule) => match(action, rule.action) && match(resource, rule.resource))?.effect ?? "ask"
  );
}

function decide(agent: Record<string, any>, action: string, resource = "*"): string {
  return evaluate([...(config.permissions ?? []), ...(agent.permissions ?? [])], action, resource);
}

const workers = ["code", "review", "explore", "fetch", "track", "composio"];

describe("global posture", () => {
  test("unknown tools and namespaces are denied for every agent", () => {
    for (const name of Object.keys(agents)) {
      expect(decide(agents[name], "new_namespace_search")).toBe("deny");
    }
  });

  test("read keeps the .env approval convention", () => {
    expect(decide(agents.build, "read", "src/main.ts")).toBe("allow");
    expect(decide(agents.build, "read", ".env")).toBe("ask");
    expect(decide(agents.build, "read", ".env.local")).toBe("ask");
    expect(decide(agents.build, "read", ".env.example")).toBe("allow");
  });

  test("per-agent allows override the global deny", () => {
    expect(decide(agents.build, "home_assistant_*")).toBe("allow");
    expect(decide(agents.build, "retrieval_control")).toBe("allow");
    expect(decide(agents.build, "composio_*")).toBe("deny");
    expect(decide(agents.plan, "home_assistant_*")).toBe("deny");
    expect(decide(agents.plan, "retrieval_control")).toBe("allow");
    expect(decide(agents.explore, "semble_*")).toBe("allow");
    expect(decide(agents.composio, "composio_*")).toBe("allow");
    expect(decide(agents.fetch, "webfetch")).toBe("allow");
  });
});

describe("main agents", () => {
  test("build and plan retain question/todo/skill/subagent tools", () => {
    for (const name of ["build", "plan"]) {
      expect(decide(agents[name], "question")).toBe("allow");
      expect(decide(agents[name], "todowrite")).toBe("allow");
      expect(decide(agents[name], "skill", "worktree-flow")).toBe("allow");
      expect(decide(agents[name], "skill", "review-flow")).toBe("allow");
      expect(decide(agents[name], "skill", "composio-google-sheets")).toBe("allow");
      expect(decide(agents[name], "skill", "customize-opencode")).toBe("allow");
      expect(decide(agents[name], "compress")).toBe("allow");
      expect(decide(agents[name], "subagent", "explore")).toBe("allow");
      expect(decide(agents[name], "subagent", "fetch")).toBe("allow");
      expect(decide(agents[name], "subagent", "track")).toBe("allow");
      expect(decide(agents[name], "subagent", "composio")).toBe("allow");
      expect(decide(agents[name], "sqz_sqz_read_file")).toBe("allow");
      expect(decide(agents[name], "sqz_expand")).toBe("allow");
      expect(decide(agents[name], "sqz_compress")).toBe("allow");
      expect(decide(agents[name], "sqz_passthrough")).toBe("allow");
    }
    expect(decide(agents.build, "subagent", "code")).toBe("allow");
    expect(decide(agents.plan, "subagent", "code")).toBe("deny");
    for (const name of ["build", "plan"]) {
      expect(decide(agents[name], "shell")).toBe("deny");
      expect(decide(agents[name], "edit")).toBe("deny");
      expect(decide(agents[name], "webfetch")).toBe("deny");
      expect(decide(agents[name], "websearch")).toBe("deny");
      expect(decide(agents[name], "plan_enter")).toBe("deny");
      expect(decide(agents[name], "plan_exit")).toBe("deny");
      expect(decide(agents[name], "canvas_x")).toBe("deny");
    }
  });

  test("build has the Home Assistant exception and Code Mode; plan does not", () => {
    expect(decide(agents.build, "execute")).toBe("allow");
    expect(decide(agents.build, "home_assistant_*")).toBe("allow");
    expect(decide(agents.plan, "execute")).toBe("deny");
    expect(decide(agents.plan, "home_assistant_*")).toBe("deny");
  });
});

describe("leaf workers", () => {
  test("all workers are denied subagent spawning", () => {
    for (const name of workers) {
      expect(decide(agents[name], "subagent")).toBe("deny");
    }
  });

  test("workers do not inherit primary compress or customize-opencode", () => {
    for (const name of workers) {
      expect(decide(agents[name], "compress")).toBe("deny");
      expect(decide(agents[name], "skill", "customize-opencode")).toBe("deny");
    }
  });

  test("code can edit and run shell but not fetch or execute", () => {
    expect(decide(agents.code, "edit")).toBe("allow");
    expect(decide(agents.code, "shell", "bun test")).toBe("allow");
    expect(decide(agents.code, "shell", "npm install")).toBe("allow");
    expect(decide(agents.code, "shell", "curl https://example.com")).toBe("deny");
    expect(decide(agents.code, "shell", "wget https://example.com")).toBe("deny");
    expect(decide(agents.code, "shell", "Invoke-WebRequest https://example.com")).toBe("deny");
    expect(decide(agents.code, "shell", "git clone https://example.com/repo")).toBe("deny");
    expect(decide(agents.code, "webfetch")).toBe("deny");
    expect(decide(agents.code, "websearch")).toBe("deny");
    expect(decide(agents.code, "execute")).toBe("deny");
    expect(decide(agents.code, "skill", "worktree-flow")).toBe("allow");
    expect(decide(agents.code, "sqz_sqz_read_file")).toBe("allow");
    expect(decide(agents.code, "sqz_compress")).toBe("allow");
    expect(decide(agents.code, "sqz_passthrough")).toBe("allow");
  });

  test("review is read-only and shell-git-only", () => {
    expect(decide(agents.review, "shell", "git status")).toBe("allow");
    expect(decide(agents.review, "shell", "git diff")).toBe("allow");
    expect(decide(agents.review, "shell", "rm -rf src")).toBe("deny");
    expect(decide(agents.review, "edit")).toBe("deny");
    expect(decide(agents.review, "skill", "review-flow")).toBe("allow");
    expect(decide(agents.review, "sqz_sqz_read_file")).toBe("allow");
    expect(decide(agents.review, "sqz_compress")).toBe("allow");
    expect(decide(agents.review, "sqz_passthrough")).toBe("allow");
  });

  test("explore is local-only and uses Code Mode for Semble", () => {
    expect(decide(agents.explore, "execute")).toBe("allow");
    expect(decide(agents.explore, "semble_*")).toBe("allow");
    expect(decide(agents.explore, "shell", "ls src")).toBe("allow");
    expect(decide(agents.explore, "shell", "curl https://example.com")).toBe("deny");
    expect(decide(agents.explore, "skill")).toBe("deny");
    expect(decide(agents.explore, "sqz_sqz_read_file")).toBe("allow");
    expect(decide(agents.explore, "sqz_compress")).toBe("allow");
    expect(decide(agents.explore, "sqz_passthrough")).toBe("allow");
  });

  test("fetch gets native search/fetch and Code Mode providers only", () => {
    expect(decide(agents.fetch, "websearch")).toBe("allow");
    expect(decide(agents.fetch, "webfetch")).toBe("allow");
    expect(decide(agents.fetch, "execute")).toBe("allow");
    expect(decide(agents.fetch, "context7_query_docs")).toBe("allow");
    expect(decide(agents.fetch, "exa_web_search")).toBe("allow");
    expect(decide(agents.fetch, "gh_grep_search")).toBe("allow");
    expect(decide(agents.fetch, "duckduckgo_search")).toBe("allow");
    expect(decide(agents.fetch, "retrieval_control")).toBe("allow");
    expect(decide(agents.fetch, "read", "src/main.ts")).toBe("deny");
    expect(decide(agents.fetch, "glob")).toBe("deny");
    expect(decide(agents.fetch, "grep")).toBe("deny");
    expect(decide(agents.fetch, "skill")).toBe("deny");
    expect(decide(agents.fetch, "sqz_sqz_read_file")).toBe("deny");
    expect(decide(agents.fetch, "sqz_compress")).toBe("deny");
    expect(decide(agents.fetch, "sqz_passthrough")).toBe("deny");
    expect(decide(agents.fetch, "sqz_expand")).toBe("deny");
    expect(decide(agents.fetch, "shell")).toBe("deny");
    expect(decide(agents.fetch, "edit")).toBe("deny");
    expect(decide(agents.fetch, "new_namespace_search")).toBe("deny");
  });

  test("track is scoped to br and bv --robot-*", () => {
    expect(decide(agents.track, "skill", "beads-br")).toBe("allow");
    expect(decide(agents.track, "skill", "beads-bv")).toBe("allow");
    expect(decide(agents.track, "shell", "br list --no-db")).toBe("allow");
    expect(decide(agents.track, "shell", "br create --no-db --no-auto-flush --title=x")).toBe("allow");
    expect(decide(agents.track, "shell", "br close abc")).toBe("ask");
    expect(decide(agents.track, "shell", "br delete abc")).toBe("ask");
    expect(decide(agents.track, "shell", "bv --robot-triage")).toBe("allow");
    expect(decide(agents.track, "shell", "bv --robot-plan --label backend")).toBe("allow");
    expect(decide(agents.track, "shell", "bv install")).toBe("deny");
    expect(decide(agents.track, "shell", "bv")).toBe("deny");
    expect(decide(agents.track, "shell", "bv --no-db --robot-triage")).toBe("deny");
    expect(decide(agents.track, "shell", "bv --robot-triage --no-db")).toBe("deny");
    expect(decide(agents.track, "shell", "git status")).toBe("deny");
    expect(decide(agents.track, "sqz_sqz_read_file")).toBe("deny");
    expect(decide(agents.track, "sqz_compress")).toBe("deny");
    expect(decide(agents.track, "sqz_passthrough")).toBe("deny");
  });

  test("composio owns the Composio namespace through Code Mode", () => {
    expect(decide(agents.composio, "execute")).toBe("allow");
    expect(decide(agents.composio, "composio_search_tools")).toBe("allow");
    expect(decide(agents.composio, "skill", "composio-google-sheets")).toBe("allow");
    expect(decide(agents.composio, "webfetch")).toBe("deny");
    expect(decide(agents.composio, "websearch")).toBe("deny");
    expect(decide(agents.composio, "shell")).toBe("deny");
    expect(decide(agents.composio, "edit")).toBe("deny");
    expect(decide(agents.composio, "sqz_sqz_read_file")).toBe("deny");
    expect(decide(agents.composio, "sqz_compress")).toBe("deny");
    expect(decide(agents.composio, "sqz_passthrough")).toBe("deny");
  });
});
