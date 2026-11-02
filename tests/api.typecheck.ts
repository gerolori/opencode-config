import type { Hooks, Plugin, PluginModule, ToolResult } from "@opencode-ai/plugin";
import type { Event, Session, ToolStateError } from "@opencode-ai/sdk";

type Assert<T extends true> = T;
type IsAssignable<A, B> = A extends B ? true : false;

// Loader-accepted export shape: { id?, server: Plugin }.
declare const server: Plugin;
const moduleShape = { id: "example", server } satisfies PluginModule;
void moduleShape;

type ModuleShape = Assert<IsAssignable<typeof moduleShape, PluginModule>>;
type EventHookShape = Assert<
  IsAssignable<NonNullable<Hooks["event"]>, (input: { event: Event }) => Promise<void>>
>;
type HasToolAfter = Assert<
  NonNullable<Hooks["tool.execute.after"]> extends (...args: never[]) => Promise<void> ? true : false
>;
type FailedStatus = Assert<IsAssignable<ToolStateError["status"], "error">>;
type ParentID = Assert<IsAssignable<Session["parentID"], string | undefined>>;
type ResultObject = Assert<IsAssignable<{ output: string }, ToolResult>>;
type ResultString = Assert<IsAssignable<string, ToolResult>>;

export type {
  ModuleShape,
  EventHookShape,
  HasToolAfter,
  FailedStatus,
  ParentID,
  ResultObject,
  ResultString,
};
