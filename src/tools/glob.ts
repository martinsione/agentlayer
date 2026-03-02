/**
 * Glob tool — find files matching a glob pattern.
 *
 * Uses Node's `node:fs/promises` glob (available in Node 22+).
 * Returns one file path per line, limited to 500 results.
 */

import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";

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
      const results: string[] = [];

      for await (const entry of glob(input.pattern, { cwd: searchDir })) {
        results.push(entry);
        if (results.length >= MAX_RESULTS) break;
      }

      if (results.length === 0) {
        return "No files matched the pattern.";
      }

      let output = results.join("\n");
      if (results.length >= MAX_RESULTS) {
        output += `\n\n[Results limited to ${MAX_RESULTS} entries]`;
      }
      return output;
    },
  });
}

/** Default glob tool. Uses ctx.runtime.cwd at execution time. */
export const GlobTool = createGlobTool();
