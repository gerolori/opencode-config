import { describe, expect, test } from "bun:test";
import { Plugin } from "@opencode/plugin";
import type { Agent } from "@opencode/schema/agent";
import type { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { Tool } from "@opencode/schema/tool";
import pkg from "../package.json";
import {
  callIdentity,
  isToolErrorOutcome,
  sessionParentID,
  toolErrorOf,
  type ExecuteAfterEvent,
} from "./helpers/events";

const PINNED = ["@opencode/client", "@opencode/plugin", "@opencode/schema"] as const;

describe("2.2.5 toolchain pins", () => {
  test("pins the actual 2.2.5 packages exactly", () => {
    for (const name of PINNED) {
      expect(pkg.devDependencies[name]).toMatch(/^2\.2\.5$/);
    }
  });

  test("obsolete 1.x SDK is absent", () => {
    const deps = pkg.devDependencies as Record<string, string | undefined>;
    expect(deps["@opencode-ai/plugin"]).toBeUndefined();
  });

  test("Plugin.define is available", () => {
    expect(typeof Plugin.define).toBe("function");
  });
});

describe("tool hook contracts", () => {
  const identity = {
    tool: "task",
    sessionID: "ses_child" as Session.ID,
    agent: "code" as Agent.ID,
    messageID: "msg_1" as SessionMessage.ID,
    id: "call_1" as Tool.CallID,
    input: { prompt: "x" },
  };

  const completed: ExecuteAfterEvent = {
    ...identity,
    status: "completed",
    result: { output: "ok" },
  };

  const failed: ExecuteAfterEvent = {
    ...identity,
    status: "error",
    error: { message: "boom" } as unknown as Tool.Error,
  };

  test("per-leaf identity is preserved", () => {
    expect(callIdentity(identity)).toEqual({
      tool: "task",
      sessionID: "ses_child",
      agent: "code",
      messageID: "msg_1",
      id: "call_1",
    } as unknown as typeof identity);
  });

  test("status:error is detected and carries Tool.Error", () => {
    expect(isToolErrorOutcome(failed)).toBe(true);
    expect(toolErrorOf(failed)?.message).toBe("boom");
    expect(String(failed.id)).toBe("call_1");
  });

  test("status:completed is not an error outcome", () => {
    expect(isToolErrorOutcome(completed)).toBe(false);
    expect(toolErrorOf(completed)).toBeUndefined();
  });
});

describe("session parent identity", () => {
  test("Session.Info.parentID identifies child/task sessions", () => {
    const child = { id: "ses_child", parentID: "ses_parent" } as Session.Info;
    expect(sessionParentID(child)).toBe("ses_parent");
  });
});
