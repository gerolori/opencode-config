import { describe, expect, test } from "bun:test";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import pkg from "../package.json";
import type { Event, Session, ToolPart } from "@opencode-ai/sdk";
import { failedToolError, isFailedToolEvent, sessionParentID } from "./helpers/events";

const echo = tool({
  description: "Echo input",
  args: { text: z.string() },
  async execute(args) {
    return { title: "echo", output: args.text };
  },
});

describe("plugin tool harness", () => {
  test("tool() exposes description/args/execute", () => {
    expect(echo.description).toBe("Echo input");
    expect(typeof echo.execute).toBe("function");
  });

  test("execute returns a ToolResult object", async () => {
    const result = await echo.execute({ text: "hi" }, {} as never);
    expect(result).toEqual({ title: "echo", output: "hi" });
  });

  test("SDK pin is exact (no semver range)", () => {
    expect(pkg.dependencies["@opencode-ai/plugin"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("event shape helpers", () => {
  const failedToolPart = {
    id: "part_1",
    sessionID: "ses_child",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "task",
    state: { status: "error", input: {}, error: "boom", time: { start: 1, end: 2 } },
  } satisfies ToolPart;

  const failedEvent = {
    type: "message.part.updated",
    properties: { part: failedToolPart },
  } satisfies Event;

  test("failed tool outcomes are visible via message.part.updated", () => {
    expect(isFailedToolEvent(failedEvent)).toBe(true);
    if (isFailedToolEvent(failedEvent)) {
      expect(failedToolError(failedEvent.properties.part)).toBe("boom");
      expect(failedEvent.properties.part.sessionID).toBe("ses_child");
      expect(failedEvent.properties.part.callID).toBe("call_1");
    }
  });

  test("non-tool events are rejected", () => {
    const idle = { type: "session.idle", properties: { sessionID: "ses_1" } } satisfies Event;
    expect(isFailedToolEvent(idle)).toBe(false);
  });

  test("task-session parent lookup uses Session.parentID", () => {
    const child = { id: "ses_child", parentID: "ses_parent" } as Session;
    expect(sessionParentID(child)).toBe("ses_parent");
  });
});
