/**
 * sqz ÔÇö OpenCode plugin for transparent context compression.
 *
 * Intercepts shell commands and pipes output through sqz for token savings.
 * Install: copy to ~/.config/opencode/plugins/sqz.ts
 * Discovery is automatic ÔÇö no opencode.json entry needed (and in fact
 * including one causes the plugin to load twice, per issue #10).
 */

const SqzPluginFactory = async (ctx: any) => {
  // Detect the host platform first — used to pick the sqz path and for
  // stderr-redirect dedup (see hasStderrRedirect below). OpenCode Desktop
  // on Windows routes bash-tool commands through PowerShell (or cmd.exe);
  // elsewhere a POSIX shell. process.platform is available in the Bun/Node
  // plugin runtime.
  const isWindows = process.platform === "win32";

  // On Windows use the full absolute path to sqz.exe; on POSIX rely on PATH.
  const SQZ_PATH = isWindows
    ? "C:\\Users\\hermes\\.cargo\\bin\\sqz.exe"
    : "sqz";

  // Does `cmd` already contain a standalone stderr redirect (`2>&1`,
  // `2 >&1`, `2 >& 1`, or `2>/dev/null`-style `2>target`)?
  // If so, preserve it and never append another — the duplicate
  // `2>&1 2>&1` is a PowerShell parse error on Windows (isWindows)
  // and silently overrides the first redirect on POSIX.
  //
  // The regex accounts for Windows PowerShell allowing optional spaces
  // around the redirect operator (e.g. `2 >&1`, `2 >& 1`).
  function hasStderrRedirect(cmd: string): boolean {
    // 2>&1 or 2 >&1 or 2 >& 1 (PowerShell-style)
    if (/\b2\s*>\s*&1\b/.test(cmd)) return true;
    // 2>file, 2>>file, 2>/dev/null, 2>| etc. (POSIX/PowerShell)
    if (/\b2\s*>\s*\S+/.test(cmd)) return true;
    return false;
  }

  // Commands that should not be intercepted.
  const INTERACTIVE = new Set([
    "vim", "vi", "nano", "emacs", "less", "more", "top", "htop",
    "ssh", "python", "python3", "node", "irb", "ghci",
    "psql", "mysql", "sqlite3", "mongo", "redis-cli",
  ]);

  function isInteractive(cmd: string): boolean {
    const base = cmd.split(/\s+/)[0]?.split("/").pop() ?? "";
    if (INTERACTIVE.has(base)) return true;
    if (cmd.includes("--watch") || cmd.includes("run dev") ||
        cmd.includes("run start") || cmd.includes("run serve")) return true;
    return false;
  }

  function shouldIntercept(tool: string): boolean {
    return ["bash", "shell", "terminal", "run_shell_command"].includes(tool.toLowerCase());
  }

  // Detect that a command has already been wrapped by sqz. Before this
  // guard was in place OpenCode could call the hook twice on the same
  // command (for retried tool calls, or when a previous rewrite was
  // echoed back to the agent and the agent re-submitted it) and each
  // pass would prepend another `SQZ_CMD=$base` prefix, producing monsters
  // like `SQZ_CMD=SQZ_CMD=ddev SQZ_CMD=ddev ddev exec ...` (reported as
  // a follow-up to issue #5). We skip if any of these markers appear:
  //   * the regex /sqz(?:\.exe)?\s+compress/ — catches any form of the
  //     actual rewritten pipeline regardless of path prefix, covering
  //     both POSIX (`| sqz compress`) and Windows
  //     (`| C:\path\to\sqz.exe compress`). This is the primary guard.
  //   * the case-insensitive substring "sqz_cmd=" (legacy pre-issue-#10
  //     env-var form, still valid in POSIX shell hooks)
  //   * a leading `VAR=` assignment that starts with SQZ_
  //     (defensive catch-all for exotic wrap variants)
  //   * the base command itself is sqz or sqz-mcp (running sqz directly
  //     — compressing sqz's own output is pointless and causes loops)
  function isAlreadyWrapped(cmd: string): boolean {
    const lowered = cmd.toLowerCase();
    // Primary guard: matches `sqz compress` or `sqz.exe compress`
    // anywhere in the pipeline, regardless of path prefix.
    // Handles POSIX:     `| sqz compress --cmd …`
    // Handles Windows:   `| C:\path\to\sqz.exe compress --cmd …`
    if (/sqz(?:\.exe)?\s+compress/.test(lowered)) return true;
    if (lowered.includes("sqz_cmd=")) return true;
    if (/^\s*SQZ_[A-Z0-9_]+=/.test(cmd)) return true;
    const base = extractBaseCmd(cmd);
    if (base === "sqz" || base === "sqz-mcp" || base === "sqz.exe") return true;
    return false;
  }

  // Extract the base command name defensively. If the command has
  // leading env-var assignments (VAR=val VAR2=val2 actual_cmd arg1),
  // skip past them so the base is `actual_cmd` ÔÇö not `VAR=val`.
  function extractBaseCmd(cmd: string): string {
    const tokens = cmd.split(/\s+/).filter(t => t.length > 0);
    for (const tok of tokens) {
      // A token is an env assignment if it matches NAME=VALUE where NAME
      // is a valid env var identifier. Skip it and keep looking.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
      return tok.split("/").pop() ?? "unknown";
    }
    return "unknown";
  }

  // Shell-escape a command-name label so it's safe to inline into the
  // rewritten shell command. Agents occasionally invoke commands via
  // paths with spaces (`"/my tools/foo" --arg`) and in the LLM
  // roundtrip that can survive to `extractBaseCmd`'s output. Quote the
  // label unless it's pure ASCII alphanumeric.
  function shellEscapeLabel(s: string): string {
    if (/^[A-Za-z0-9_.-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const tool = input.tool ?? "";
      if (!shouldIntercept(tool)) return;

      const cmd = output.args?.command ?? "";
      if (!cmd || isAlreadyWrapped(cmd) || isInteractive(cmd)) return;

      // Multiline commands (containing \n) are common in Windows PowerShell
      // for chaining (`cmd1; if ($?) { cmd2 }` written across lines).
      // Appending ` 2>&1 | sqz compress …` to a multiline command
      // corrupts the structure — the redirect only applies to the last
      // line and may be parsed as a command name, producing errors like
      // "The term '2>&1' is not recognized as the name of a cmdlet".
      // Bypass SQZ rewriting entirely for multiline commands.
      if (cmd.includes("\n")) return;

      // Rewrite: pipe through `sqz compress --cmd <base>`.
      //
      // Issue #10: the previous form was `SQZ_CMD=<base> <cmd> 2>&1 |
      // <sqz> compress`, which uses sh-specific inline env-var syntax.
      // On Windows, OpenCode Desktop routes bash-tool commands through
      // PowerShell (or cmd.exe when $SHELL is unset), and both parse
      // `SQZ_CMD=cmd` as a command name ÔÇö raising CommandNotFoundException
      // and producing zero compression. `--cmd NAME` is a normal CLI
      // argument, shell-neutral, works in POSIX sh, zsh, fish, PowerShell,
      // and cmd.exe.
      const base = extractBaseCmd(cmd);
      const label = shellEscapeLabel(base);
      // Append `2>&1` only when absent. Preserve any existing redirect —
      // on Windows (isWindows) `cmd … 2>&1 2>&1` is a PowerShell parse
      // error, and on POSIX a second redirect silently overrides the first.
      const stderrRedirect = hasStderrRedirect(cmd) ? "" : " 2>&1";
      output.args.command = `${cmd}${stderrRedirect} | ${SQZ_PATH} compress --cmd ${label}`;
    },
  };
};

// V1 default export ÔÇö modern OpenCode (post-V1 loader) reads `id` here
// and displays "sqz" in the plugin list. Without this, OpenCode falls
// back to the raw `file:///...` spec as the plugin name (@itguy327 on
// issue #10). `readV1Plugin` in OpenCode's plugin/shared.ts requires
// file-source plugins to declare an id ÔÇö otherwise `resolvePluginId`
// throws.
export default {
  id: "sqz",
  server: SqzPluginFactory,
};

// Legacy named export ÔÇö pre-V1 OpenCode versions walk Object.values(mod)
// looking for factory functions. Assigning the same reference as the
// default export's `.server` means the legacy `seen` Set dedups via
// identity, so the factory fires exactly once either way. Kept for
// backward compatibility with OpenCode versions that predate the V1
// loader (roughly anything before mid-2025).
export const SqzPlugin = SqzPluginFactory;
