import type { Event, Session, ToolPart, ToolStateError } from "@opencode-ai/sdk";

/** A tool part whose execution failed (`state.status === "error"`). */
export type FailedToolPart = ToolPart & { state: ToolStateError };

export type MessagePartUpdatedEvent = Extract<Event, { type: "message.part.updated" }>;

export type FailedToolEvent = MessagePartUpdatedEvent & {
  properties: { part: FailedToolPart };
};

export function isFailedToolPart(part: ToolPart): part is FailedToolPart {
  return part.type === "tool" && part.state.status === "error";
}

/**
 * Failed tool calls have no dedicated event. Observe them through
 * `message.part.updated`; `part.state.status === "error"` carries
 * `state.error` (string), plus `tool`, `callID`, and `sessionID` on the part.
 */
export function isFailedToolEvent(event: Event): event is FailedToolEvent {
  if (event.type !== "message.part.updated") return false;
  const part = event.properties.part;
  return part.type === "tool" && part.state.status === "error";
}

export function failedToolError(part: FailedToolPart): string {
  return part.state.error;
}

/**
 * Task/subagent sessions are child sessions: `Session.parentID` points at the
 * parent session. Arrives via `session.created` / `session.updated`
 * (`properties.info`) or via `client.session.get` / `client.session.children`.
 */
export function sessionParentID(session: Session): string | undefined {
  return session.parentID;
}

export function isChildTaskSession(session: Session): boolean {
  return typeof session.parentID === "string" && session.parentID.length > 0;
}
