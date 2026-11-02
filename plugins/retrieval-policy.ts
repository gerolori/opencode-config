import { tool, type Hooks, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { z } from "zod";
import {
  RetrievalEngine,
  TinyFishClient,
  type ControlCaller,
  type PolicyDecision,
  type SessionInfo,
} from "../lib/retrieval";
import { applyHostConfig, type HostConfig } from "../lib/host-config";

const PLUGIN_ID = "retrieval-policy";

function formatDecision(decision: PolicyDecision): string {
  const parts = [`retrieval-policy: ${decision.reason}`];
  if (decision.message) parts.push(decision.message);
  if (decision.allowedNextProviders && decision.allowedNextProviders.length > 0) {
    parts.push(`allowed next providers: ${decision.allowedNextProviders.join(", ")}`);
  }
  return parts.join(" — ");
}

function asSessionInfo(value: unknown): SessionInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return undefined;
  return {
    id: v.id,
    parentID: typeof v.parentID === "string" ? v.parentID : undefined,
    agent: typeof v.agent === "string" ? v.agent : undefined,
  };
}

function lastAssistantAgent(value: unknown): string | undefined {
  const rows = Array.isArray(value) ? value : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    const info = (row as Record<string, unknown>).info;
    if (!info || typeof info !== "object") continue;
    const message = info as Record<string, unknown>;
    if (message.role === "assistant" && typeof message.mode === "string") {
      return message.mode;
    }
  }
  return undefined;
}

export const RetrievalPolicyPlugin: Plugin = async (input): Promise<Hooks> => {
  const engine = new RetrievalEngine({
    env: process.env,
    sessionLookup: {
      async get(sessionID: string): Promise<SessionInfo | undefined> {
        let info: SessionInfo | undefined;
        try {
          const response = await input.client.session.get({ path: { id: sessionID } });
          const data = (response as { data?: unknown }).data ?? response;
          info = asSessionInfo(data);
        } catch {
          return undefined;
        }
        if (!info || info.agent) return info;
        // Real SDK sessions do not carry `agent`; recover it safely from the
        // latest assistant message when available. Never assume it exists.
        try {
          const response = await input.client.session.messages({
            path: { id: sessionID },
            query: { limit: 20 },
          });
          const data = (response as { data?: unknown }).data ?? response;
          const agent = lastAssistantAgent(data);
          if (agent) return { ...info, agent };
        } catch {
          // Agent discovery is best-effort; the caller remains fail-closed.
        }
        return info;
      },
    },
  });
  await engine.init();

  const tinyfish = new TinyFishClient({
    bridge: engine.tinyfishBridge(),
    env: process.env,
  });

  const retrievalControl = tool({
    description:
      "Inspect or extend retrieval budgets, or reset a blocked provider circuit. status returns remaining search/read budget and eligible providers. extend is build/plan-only, targets a direct child session, and grants +3 search/+3 read once. reset_provider is root build/plan-only and clears auth/circuit state without resetting rate caps or budgets.",
    args: {
      action: z.enum(["status", "extend", "reset_provider"]),
      session_id: z.string().optional(),
      provider: z
        .enum([
          "duckduckgo",
          "tinyfish",
          "exa",
          "gh_grep",
          "context7",
          "builtin_webfetch",
          "semble",
        ])
        .optional(),
    },
    async execute(args, context) {
      engine.noteAgent(context.sessionID, context.agent);
      const caller: ControlCaller = {
        sessionID: context.sessionID,
        agent: context.agent,
      };
      const result =
        args.action === "status"
          ? await engine.status(args, caller)
          : args.action === "extend"
            ? await engine.extend(args, caller)
            : await engine.resetProvider({ provider: args.provider }, caller);
      const body = result.ok
        ? {
            ok: true,
            report: result.report,
            provider: result.provider,
            reset: result.reset,
          }
        : {
            ok: false,
            reason: result.reason,
            message: result.message,
            report: result.report,
          };
      return {
        title: `retrieval ${args.action}`,
        output: JSON.stringify(body),
        metadata: {
          retrieval_control: true,
          action: args.action,
          ok: result.ok,
          reason: result.reason,
          provider: result.provider,
          reset: result.reset,
        },
      };
    },
  });

  const tinyfishSearch = tool({
    description:
      "Bounded direct TinyFish Search API adapter. Returns at most five URL/title/snippet results with evidence_type=snippet; it never fetches full pages and never invokes MCP, Agent, Browser, or wallet APIs. External retrieval is restricted to the fetch agent.",
    args: {
      query: z.string().min(1).max(2000),
      max_results: z.number().int().min(1).max(5).optional(),
    },
    async execute(args, context) {
      engine.noteAgent(context.sessionID, context.agent);
      if (context.agent !== "fetch") {
        throw new Error(
          "retrieval-policy: external retrieval is only allowed for the fetch agent",
        );
      }
      const outcome = await tinyfish.search({
        query: args.query,
        max_results: args.max_results,
      });
      if (outcome.ok) {
        return {
          title: `tinyfish: ${outcome.results.length} snippets`,
          output: JSON.stringify({
            provider: outcome.provider,
            evidence_type: outcome.evidence_type,
            results: outcome.results,
          }),
          metadata: {
            retrieval_outcome: "success",
            result_count: outcome.results.length,
            latency_ms: outcome.latency_ms,
            evidence_type: "snippet",
          },
        };
      }
      return {
        title: "tinyfish unavailable",
        output: JSON.stringify({
          provider: outcome.provider,
          evidence_type: outcome.evidence_type,
          unavailable: {
            code: outcome.code,
            message: outcome.message,
            retry_after_ms: outcome.retry_after_ms,
          },
        }),
        metadata: {
          retrieval_outcome: "unavailable",
          code: outcome.code,
          error_category: outcome.error_category,
          retry_after_ms: outcome.retry_after_ms,
          latency_ms: outcome.latency_ms,
        },
      };
    },
  });

  return {
    tool: {
      retrieval_control: retrievalControl,
      tinyfish_search: tinyfishSearch,
    },
    async config(config) {
      applyHostConfig(config as HostConfig, {
        env: process.env,
        platform: process.platform,
      });
    },
    async event({ event }) {
      await engine.handleEvent(event);
    },
    async "chat.message"(message) {
      engine.noteAgent(message.sessionID, message.agent);
    },
    async "chat.params"(params) {
      engine.noteAgent(params.sessionID, params.agent);
    },
    async "tool.execute.before"(beforeInput, output) {
      const decision = await engine.before(beforeInput, output);
      if (!decision.allowed) throw new Error(formatDecision(decision));
    },
    async "tool.execute.after"(afterInput, output) {
      await engine.after(afterInput, output);
    },
  };
};

const pluginModule: PluginModule = {
  id: PLUGIN_ID,
  server: RetrievalPolicyPlugin,
};

export default pluginModule;
