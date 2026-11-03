import type { Agent } from "@opencode/schema/agent";
import type { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { Tool } from "@opencode/schema/tool";

/** Per-call identity attached to every `tool.execute.before/after` event. */
export interface ToolCallIdentity {
  readonly tool: string;
  readonly sessionID: Session.ID;
  readonly agent: Agent.ID;
  readonly messageID: SessionMessage.ID;
  readonly id: Tool.CallID;
}

export type ExecuteBeforeEvent = ToolCallIdentity & {
  input: unknown;
};

export type ExecuteAfterEvent = ToolCallIdentity & {
  readonly input: unknown;
} & (
  | { readonly status: "completed"; result: Tool.Result }
  | { readonly status: "error"; error: Tool.Error }
);

export type ToolErrorOutcome = ToolCallIdentity & {
  readonly input: unknown;
  readonly status: "error";
  error: Tool.Error;
};

export function isToolErrorOutcome(event: ExecuteAfterEvent): event is ToolErrorOutcome {
  return event.status === "error";
}

export function toolErrorOf(event: ExecuteAfterEvent): Tool.Error | undefined {
  return event.status === "error" ? event.error : undefined;
}

export function callIdentity(event: ToolCallIdentity): ToolCallIdentity {
  return {
    tool: event.tool,
    sessionID: event.sessionID,
    agent: event.agent,
    messageID: event.messageID,
    id: event.id,
  };
}

/** Task/subagent sessions are child sessions with a `parentID`. */
export function sessionParentID(session: Session.Info): string | undefined {
  return session.parentID;
}

export function isChildTaskSession(session: Session.Info): boolean {
  return typeof session.parentID === "string" && session.parentID.length > 0;
}
