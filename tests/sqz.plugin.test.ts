import { describe, expect, test } from "bun:test";
import type { Tool } from "@opencode/schema/tool";
import pluginModule, * as moduleNamespace from "../plugins/sqz";
import {
  createMockSpawn,
  okResult,
  SAMPLE_COMMAND_OUTPUT,
  SOURCE_FIXTURE,
} from "../lib/sqz/testing";
import type { ExecuteAfterEvent } from "./helpers/events";

const COMPRESSED = "short compressed command output";
const sqzOnPath = Bun.which("sqz");

type HookCallback = (event: ExecuteAfterEvent) => Promise<void> | void;

type SetupResult = {
  invoke: (event: ExecuteAfterEvent) => Promise<void>;
  cleanup: () => Promise<void> | void;
  disposed: () => boolean;
  hookNames: string[];
};

/** Exercise the real inactive entrypoint with the real 2.x hook contract. */
async function setupPlugin(
  options: Record<string, unknown> = {},
): Promise<SetupResult> {
  let callback: HookCallback | undefined;
  let isDisposed = false;
  const hookNames: string[] = [];

  const context = {
    options,
    tool: {
      hook: async (name: string, cb: HookCallback) => {
        hookNames.push(name);
        callback = cb;
        return {
          dispose: async () => {
            isDisposed = true;
          },
        };
      },
    },
  };

  const cleanup = await pluginModule.setup(context as never);

  return {
    invoke: async (event) => {
      if (!callback) throw new Error("execute.after hook was not registered");
      await callback(event);
    },
    cleanup: cleanup as () => Promise<void> | void,
    disposed: () => isDisposed,
    hookNames,
  };
}

function shellResult(
  text: string,
  options: {
    metadata?: Record<string, unknown>;
    structured?: Record<string, unknown>;
    content?: Tool.Result["content"];
  } = {},
): Tool.Result {
  const structured = {
    output: text,
    truncated: false,
    exit: 0,
    status: "completed",
    ...options.structured,
  };
  const metadata = {
    status: "completed",
    truncated: false,
    exit: 0,
    shellID: "sh_1",
    ...options.metadata,
  };
  return {
    output: structured,
    content:
      options.content === undefined
        ? [{ type: "text", text }]
        : options.content,
    metadata,
  };
}

function completedEvent(
  result: Tool.Result,
  options: {
    command?: string;
    id?: string;
    tool?: string;
  } = {},
): ExecuteAfterEvent {
  return {
    tool: options.tool ?? "shell",
    sessionID: "ses_1" as never,
    agent: "code" as never,
    messageID: "msg_1" as never,
    id: (options.id ?? "call_1") as never,
    input: { command: options.command ?? "git status" },
    status: "completed",
    result,
  };
}

function errorEvent(error: Tool.Error, id = "call_err"): ExecuteAfterEvent {
  return {
    tool: "shell",
    sessionID: "ses_1" as never,
    agent: "code" as never,
    messageID: "msg_1" as never,
    id: id as never,
    input: { command: "false" },
    status: "error",
    error,
  };
}

function contentText(result: Tool.Result): string[] {
  const content = result.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

describe("inactive 2.x entrypoint", () => {
  test("exports exactly one Plugin.define entrypoint", () => {
    expect(Object.keys(moduleNamespace).sort()).toEqual(["default"]);
    expect(pluginModule.id).toBe("sqz");
    expect(typeof pluginModule.setup).toBe("function");
  });

  test("registers one execute.after hook and disposes it", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });

    expect(plugin.hookNames).toEqual(["execute.after"]);
    expect(plugin.disposed()).toBe(false);

    await plugin.cleanup();
    expect(plugin.disposed()).toBe(true);
  });
});

describe("2.x completed shell results", () => {
  test("compresses only model-visible content and preserves structured output", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const result = shellResult(SAMPLE_COMMAND_OUTPUT);
    const structured = result.output;
    const metadata = result.metadata;
    const event = completedEvent(result);
    const inputSnapshot = JSON.parse(JSON.stringify(event.input));

    await plugin.invoke(event);

    expect(contentText(result)).toEqual([COMPRESSED]);
    expect(result.output).toBe(structured);
    expect(result.output).toEqual({
      output: SAMPLE_COMMAND_OUTPUT,
      truncated: false,
      exit: 0,
      status: "completed",
    });
    expect(result.metadata).toBe(metadata);
    expect(result.metadata).toEqual({
      status: "completed",
      truncated: false,
      exit: 0,
      shellID: "sh_1",
    });
    expect(event.input).toEqual(inputSnapshot);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.args).toEqual([
      "compress",
      "--no-cache",
      "--cmd",
      "git",
    ]);
  });

  test("preserves notice text and file content parts", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const notice = { type: "text" as const, text: "notice stays exact" };
    const file = {
      type: "file" as const,
      uri: "data:text/plain;base64,eA==",
      mime: "text/plain",
      name: "out.txt",
    };
    const result = shellResult(SAMPLE_COMMAND_OUTPUT, {
      content: [{ type: "text", text: SAMPLE_COMMAND_OUTPUT }, notice, file],
    });

    await plugin.invoke(completedEvent(result));

    const content = result.content as Tool.Content[];
    expect(content[0]).toEqual({ type: "text", text: COMPRESSED });
    expect(content[1]).toBe(notice);
    expect(content[2]).toBe(file);
  });

  test("supports string content as the model-visible text", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const result = shellResult(SAMPLE_COMMAND_OUTPUT, {
      content: SAMPLE_COMMAND_OUTPUT,
    });

    await plugin.invoke(completedEvent(result));

    expect(result.content).toBe(COMPRESSED);
  });

  test("does not patch structured output when content is absent", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const result: Tool.Result = {
      output: {
        output: SAMPLE_COMMAND_OUTPUT,
        truncated: false,
        exit: 0,
        status: "completed",
      },
      metadata: { status: "completed", truncated: false, exit: 0 },
    };

    await plugin.invoke(completedEvent(result));

    expect(result.output).toEqual({
      output: SAMPLE_COMMAND_OUTPUT,
      truncated: false,
      exit: 0,
      status: "completed",
    });
    expect(mock.calls).toHaveLength(0);
  });

  test("multiline command input is never mutated", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const command = "echo one\necho two\nif ($?) { echo three }";
    const result = shellResult(SAMPLE_COMMAND_OUTPUT);
    const event = completedEvent(result, { command });
    const snapshot = JSON.parse(JSON.stringify(event.input));

    await plugin.invoke(event);

    expect(event.input).toEqual(snapshot);
    expect((event.input as { command: string }).command).toBe(command);
    expect(contentText(result)).toEqual([COMPRESSED]);
  });
});

describe("2.x failure and metadata guards", () => {
  test("non-zero exit is untouched and never compressed", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const result = shellResult(SAMPLE_COMMAND_OUTPUT, {
      metadata: { exit: 1 },
      structured: { exit: 1 },
    });
    const metadata = result.metadata;
    const structured = result.output;

    await plugin.invoke(completedEvent(result, { command: "cargo test" }));

    expect(contentText(result)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(result.metadata).toBe(metadata);
    expect(result.output).toBe(structured);
    expect(mock.calls).toHaveLength(0);
  });

  test("structured-output non-zero exit is also skipped", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const result = shellResult(SAMPLE_COMMAND_OUTPUT, {
      // Metadata says 0, but the structured output reports failure.
      structured: { exit: 2 },
    });

    await plugin.invoke(completedEvent(result));

    expect(contentText(result)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(mock.calls).toHaveLength(0);
  });

  test("signal and timeout completions are untouched", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });

    const signalled = shellResult(SAMPLE_COMMAND_OUTPUT, {
      metadata: { signal: "SIGTERM" },
      structured: { signal: "SIGTERM", exit: undefined },
    });
    const timedOut = shellResult(SAMPLE_COMMAND_OUTPUT, {
      metadata: { timeout: true },
      structured: { timeout: true },
    });

    await plugin.invoke(completedEvent(signalled, { id: "call_signal" }));
    await plugin.invoke(completedEvent(timedOut, { id: "call_timeout" }));

    expect(contentText(signalled)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(contentText(timedOut)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(mock.calls).toHaveLength(0);
  });

  test("status:error preserves the Tool.Error object verbatim", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const error = { message: "boom" } as Tool.Error;
    const event = errorEvent(error);
    if (event.status !== "error") throw new Error("expected error event");

    await plugin.invoke(event);

    expect(event.status).toBe("error");
    expect(event.error).toBe(error);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("2.x duplicate and scope guards", () => {
  test("already SQZ-marked content is not compressed again", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const already = `[sqz] 27/181 tokens (85% reduction)\n${SAMPLE_COMMAND_OUTPUT}`;
    const result = shellResult(already);

    await plugin.invoke(completedEvent(result));

    expect(contentText(result)).toEqual([already]);
    expect(mock.calls).toHaveLength(0);
  });

  test("same call ID and same result object are compressed only once", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const result = shellResult(SAMPLE_COMMAND_OUTPUT);
    const event = completedEvent(result, { id: "call_duplicate" });

    await plugin.invoke(event);
    await plugin.invoke(event);

    const secondResult = shellResult(SAMPLE_COMMAND_OUTPUT);
    await plugin.invoke(completedEvent(secondResult, { id: "call_duplicate" }));

    expect(mock.calls).toHaveLength(1);
    expect(contentText(secondResult)).toEqual([SAMPLE_COMMAND_OUTPUT]);
  });

  test("native Code Mode outer execute never re-compresses leaf output", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });

    const leaf = shellResult(SAMPLE_COMMAND_OUTPUT);
    await plugin.invoke(completedEvent(leaf, { id: "call_leaf", command: "git log" }));
    expect(mock.calls).toHaveLength(1);

    const leafText = contentText(leaf)[0]!;
    const outer: Tool.Result = {
      output: { output: leafText, toolCalls: [], files: [] },
      content: [{ type: "text", text: leafText }],
      metadata: { toolCalls: [] },
    };
    const outerMetadata = outer.metadata;
    const outerOutput = outer.output;

    await plugin.invoke(
      completedEvent(outer, { id: "call_outer", tool: "execute", command: "execute" }),
    );

    expect(contentText(outer)).toEqual([leafText]);
    expect(outer.metadata).toBe(outerMetadata);
    expect(outer.output).toBe(outerOutput);
    expect(mock.calls).toHaveLength(1);
  });

  test("non-shell and MCP SQZ tools are untouched", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const sqzResult = shellResult(SAMPLE_COMMAND_OUTPUT);
    const readResult = shellResult(SAMPLE_COMMAND_OUTPUT);

    await plugin.invoke(
      completedEvent(sqzResult, { tool: "sqz_compress", command: "compress" }),
    );
    await plugin.invoke(
      completedEvent(readResult, { tool: "read", command: "read" }),
    );

    expect(contentText(sqzResult)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(contentText(readResult)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(mock.calls).toHaveLength(0);
  });

  test("shell commands invoking SQZ are skipped", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const direct = shellResult(SAMPLE_COMMAND_OUTPUT);
    const pipeline = shellResult(SAMPLE_COMMAND_OUTPUT);

    await plugin.invoke(
      completedEvent(direct, { command: "sqz compress --cmd git" }),
    );
    await plugin.invoke(
      completedEvent(pipeline, {
        id: "call_pipeline",
        command: "cat log.txt | sqz compress --cmd cat",
      }),
    );

    expect(contentText(direct)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(contentText(pipeline)).toEqual([SAMPLE_COMMAND_OUTPUT]);
    expect(mock.calls).toHaveLength(0);
  });

  test("raw source, tiny, and cryptic outputs are skipped", async () => {
    const mock = createMockSpawn(() => okResult(COMPRESSED));
    const plugin = await setupPlugin({ spawn: mock.spawn });
    const source = shellResult(SOURCE_FIXTURE);
    const tiny = shellResult("ok");
    const cryptic = shellResult(
      Array.from(
        { length: 12 },
        (_, index) =>
          `aaaaaaaa.bbbbbbbb.cccccccc.dddddddd.eeeeeeee${String(index).padStart(2, "0")}`,
      ).join(" "),
    );

    await plugin.invoke(completedEvent(source, { id: "call_source" }));
    await plugin.invoke(completedEvent(tiny, { id: "call_tiny" }));
    await plugin.invoke(completedEvent(cryptic, { id: "call_cryptic" }));

    expect(contentText(source)).toEqual([SOURCE_FIXTURE]);
    expect(contentText(tiny)).toEqual(["ok"]);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("real PATH compressor through the 2.x entrypoint", () => {
  test.skipIf(!sqzOnPath)(
    "compresses model-visible content and leaves exit metadata intact",
    async () => {
      const plugin = await setupPlugin({});
      const result = shellResult(SAMPLE_COMMAND_OUTPUT);
      const structured = result.output;
      const metadata = result.metadata;

      await plugin.invoke(
        completedEvent(result, { id: "call_real", command: "git log" }),
      );

      const text = contentText(result)[0]!;
      expect(text.length).toBeLessThan(SAMPLE_COMMAND_OUTPUT.length);
      expect(text).not.toContain("[sqz]");
      expect(text).not.toContain("§ref:");
      expect(result.output).toBe(structured);
      expect(result.metadata).toBe(metadata);
      expect(result.metadata).toEqual({
        status: "completed",
        truncated: false,
        exit: 0,
        shellID: "sh_1",
      });
    },
  );
});
