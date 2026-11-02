/**
 * sqz - OpenCode plugin for transparent context compression.
 *
 * The shell tool runs exactly as requested. Its already-captured output is
 * compressed in `tool.execute.after`, so exit codes and stdout/stderr
 * metadata are preserved and no shell command is ever rewritten.
 *
 * Discovery is automatic; do not also list this file in opencode.json.
 */

import { createSqzPlugin } from "../lib/sqz/plugin";

export default {
  id: "sqz",
  server: createSqzPlugin(),
};
