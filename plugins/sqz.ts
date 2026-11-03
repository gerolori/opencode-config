/**
 * SQZ 2.x active entrypoint.
 *
 * This file lives in the auto-discovered `plugins/` directory and must not be
 * listed again in opencode.jsonc. The relative import to `../lib/sqz/v2` stays
 * valid because both locations are one level below the config root.
 *
 * Safety at a glance:
 * - runs only after a completed shell tool call;
 * - never rewrites commands or pipelines;
 * - skips errors, non-zero exits, signals, timeouts, Code Mode outer execute,
 *   MCP SQZ tools, source/config-like output, cryptic walls, and tiny or
 *   oversized output;
 * - invokes PATH-resolved `sqz compress --no-cache` with an argv array and no
 *   shell;
 * - compresses only the model-visible text part of Tool.Result; structured
 *   output and all exit/failure metadata remain untouched.
 */

import { Plugin } from "@opencode/plugin";
import { createSqzAfterHandler } from "../lib/sqz/v2";

export default Plugin.define({
  id: "sqz",
  async setup(context) {
    const registration = await context.tool.hook(
      "execute.after",
      createSqzAfterHandler(context.options),
    );

    return async () => {
      await registration.dispose();
    };
  },
});
