/**
 * Grep tool — search file contents using grep -rn.
 *
 * Delegates execution to `ctx.runtime.exec()` to run `grep`.
 * Returns matched lines with file:line prefix, truncated to 50KB.
 */

import { resolve } from "node:path";
import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { DEFAULT_MAX_BYTES } from "./truncate";

/** Escape single quotes for safe shell interpolation inside single-quoted strings. */
const sq = (s: string) => s.replaceAll("'", "'\\''");

const schema = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z
    .string()
    .optional()
    .describe("File or directory to search in (defaults to working directory)"),
  glob: z.string().optional().describe("File pattern filter (e.g. *.ts)"),
});

export function createGrepTool(cwd?: string): Tool {
  return defineTool({
    name: "grep",
    label: "Search Files",
    description:
      "Search file contents for a regex pattern using grep -rn. Returns matched lines with file:line prefix, truncated to 50KB.",
    schema,
    execute: async (input, ctx) => {
      const baseCwd = cwd ?? ctx.runtime.cwd;
      const searchPath = input.path ? resolve(baseCwd, input.path) : baseCwd;

      // Build the grep command
      const args: string[] = ["-rn"];
      if (input.glob) {
        args.push("--include", `'${sq(input.glob)}'`);
      }
      // Use -- to separate pattern from path to avoid issues with patterns starting with -
      args.push("--", `'${sq(input.pattern)}'`, `'${sq(searchPath)}'`);

      const command = `grep ${args.join(" ")}`;

      const result = await ctx.runtime.exec(command, { cwd: baseCwd });
      const output = result.stdout;

      if (!output.trim()) {
        return "No matches found.";
      }

      const bytes = Buffer.byteLength(output, "utf-8");
      if (bytes > DEFAULT_MAX_BYTES) {
        const truncated = Buffer.from(output, "utf-8")
          .subarray(0, DEFAULT_MAX_BYTES)
          .toString("utf-8");
        // Trim to last complete line
        const lastNewline = truncated.lastIndexOf("\n");
        const clean = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
        return `${clean}\n\n[Output truncated: ${bytes} bytes total, showing first 50KB]`;
      }

      return output.trimEnd();
    },
  });
}

/** Default grep tool. Uses ctx.runtime.cwd at execution time. */
export const GrepTool = createGrepTool();
