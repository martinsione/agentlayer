/**
 * Glob tool — find files matching a glob pattern.
 *
 * Delegates to the shell via `ctx.runtime.exec()` so it works on any runtime
 * (Node, Vercel Sandbox, etc.).  Returns one file path per line, limited to
 * 500 results.
 */

import { resolve } from "node:path";
import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { sq } from "./shell-utils";

const MAX_RESULTS = 500;

const schema = z.object({
  pattern: z.string().describe("Glob pattern (e.g. **/*.ts)"),
  cwd: z.string().optional().describe("Directory to search in (defaults to working directory)"),
});

export function createGlobTool(cwd?: string): Tool {
  return defineTool({
    name: "glob",
    label: "Find Files",
    description: `Find files matching a glob pattern. Returns one file path per line, limited to ${MAX_RESULTS} results. Paths are relative to the search directory.`,
    schema,
    execute: async (input, ctx) => {
      const baseCwd = cwd ?? ctx.runtime.cwd;
      const searchDir = input.cwd ? resolve(baseCwd, input.cwd) : baseCwd;

      // Use find via the runtime so this works on any runtime (Node, sandbox, etc.).
      // Convert the glob pattern into a find -path expression:
      //   **/*.ts  → -name '*.ts'   (recursive by default)
      //   *.json   → -maxdepth 1 -name '*.json'   (no ** → single directory)
      const pattern = input.pattern;
      const hasRecursive = pattern.includes("**");

      // Extract the filename portion (last segment after the last /)
      const lastSlash = pattern.lastIndexOf("/");
      const namePattern = lastSlash >= 0 ? pattern.slice(lastSlash + 1) : pattern;

      // Extract the subdirectory prefix (everything before **)
      let subDir = ".";
      if (lastSlash >= 0) {
        const dirPart = pattern.slice(0, lastSlash);
        // Strip leading **/ or trailing /** from the directory part
        const cleaned = dirPart.replace(/^\*\*\/?/, "").replace(/\/?\*\*$/, "");
        if (cleaned && !cleaned.includes("*")) subDir = cleaned;
      }

      const args: string[] = ["find", `'${sq(subDir)}'`];
      if (!hasRecursive) args.push("-maxdepth", "1");
      args.push("-type", "f");
      // When namePattern is '**', it means "match everything" — omit -name
      // so find returns all files instead of looking for a literal '**' filename.
      if (namePattern !== "**") args.push("-name", `'${sq(namePattern)}'`);
      args.push("|", "head", "-n", String(MAX_RESULTS + 1));

      const result = await ctx.runtime.exec(args.join(" "), {
        cwd: searchDir,
        signal: ctx.signal,
      });

      const lines = result.stdout.split("\n").filter(Boolean);

      // Strip the leading ./ that find prepends
      const cleaned = lines.map((l) => (l.startsWith("./") ? l.slice(2) : l));

      if (cleaned.length === 0) {
        return "No files matched the pattern.";
      }

      const limited = cleaned.length > MAX_RESULTS;
      const output = cleaned.slice(0, MAX_RESULTS).join("\n");
      return limited ? output + `\n\n[Results limited to ${MAX_RESULTS} entries]` : output;
    },
  });
}

/** Default glob tool. Uses ctx.runtime.cwd at execution time. */
export const GlobTool = createGlobTool();
