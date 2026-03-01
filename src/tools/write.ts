/**
 * Write tool — write content to a file.
 *
 * Delegates file writing to `ctx.runtime.writeFile()`.
 * Returns a confirmation message with the number of bytes written.
 */

import { resolve } from "node:path";
import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  content: z.string().describe("Content to write to the file"),
});

export function createWriteTool(cwd: string): Tool {
  return defineTool({
    name: "write",
    description:
      "Write content to a file. Creates the file if it does not exist, and creates parent directories as needed. Provide an absolute path or a path relative to the working directory.",
    schema,
    execute: async (input, ctx) => {
      const filePath = resolve(cwd, input.path);
      await ctx.runtime.writeFile(filePath, input.content);
      const bytes = Buffer.byteLength(input.content, "utf-8");
      return `Wrote ${bytes} bytes to ${filePath}`;
    },
  });
}

/** Default write tool using process.cwd(). */
export const WriteTool = createWriteTool(process.cwd());
