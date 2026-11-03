import { Plugin } from "@opencode/plugin";
import type { Agent } from "@opencode/schema/agent";
import type { Permission } from "@opencode/schema/permission";
import type { Session } from "@opencode/schema/session";
import type { SessionMessage } from "@opencode/schema/session-message";
import type { Tool } from "@opencode/schema/tool";

type Assert<T extends true> = T;
type IsAssignable<A, B> = A extends B ? true : false;

// 2.x promise plugin shape: Plugin.define({ id, setup(context) })
const plugin = Plugin.define({
  id: "example",
  setup(context) {
    // Per-leaf tool middleware identity.
    context.tool.hook("execute.before", (event) => {
      const tool: string = event.tool;
      const sessionID: Session.ID = event.sessionID;
      const agent: Agent.ID = event.agent;
      const messageID: SessionMessage.ID = event.messageID;
      const callID: Tool.CallID = event.id;
      const input: unknown = event.input;
      void [tool, sessionID, agent, messageID, callID, input];
    });

    // Result/error middleware: completed carries Tool.Result, error carries Tool.Error.
    context.tool.hook("execute.after", (event) => {
      if (event.status === "error") {
        const error: Tool.Error = event.error;
        void error;
      } else {
        const result: Tool.Result = event.result;
        void result;
      }
    });

    // Permission policy hook and session identity hook.
    context.permission.hook("evaluate", (evaluation) => {
      const effect: Permission.Effect = evaluation.effect;
      const sessionID: Session.ID = evaluation.sessionID;
      const agent: Agent.ID | undefined = evaluation.agent;
      void [effect, sessionID, agent];
    });

    context.session.hook("context", (request) => {
      const sessionID: Session.ID = request.sessionID;
      const agent: Agent.ID = request.agent;
      void [sessionID, agent];
    });
  },
});

type PluginShape = Assert<IsAssignable<typeof plugin, Plugin.Plugin>>;
type SetupContext = Assert<IsAssignable<Parameters<typeof plugin.setup>[0], Plugin.Context>>;
type HasToolDomain = Assert<IsAssignable<Plugin.Context["tool"]["hook"], Plugin.Context["tool"]["hook"]>>;
type CallIDIsString = Assert<IsAssignable<Tool.CallID, string>>;
type SessionParent = Assert<IsAssignable<Session.Info["parentID"], string | undefined>>;
type PermissionEffect = Assert<IsAssignable<Permission.Effect, "allow" | "deny" | "ask">>;

export type {
  PluginShape,
  SetupContext,
  HasToolDomain,
  CallIDIsString,
  SessionParent,
  PermissionEffect,
};
