/**
 * Read tool — read file contents with output truncation.
 *
 * Delegates file reading to `ctx.runtime.readFile()`.
 * Output is truncated to 100KB with a notice if exceeded.
 */

import { resolve } from "node:path";
import { z } from "zod/v4";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { truncateStringToBytesFromStart } from "./truncate";

const MAX_BYTES = 100 * 1024; // 100KB

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
});

export function createReadTool(cwd?: string): Tool {
  return defineTool({
    name: "read",
    label: "Read File",
    description:
      "Read the contents of a file. Output is truncated to 100KB. Provide an absolute path or a path relative to the working directory.",
    schema,
    execute: async (input, ctx) => {
      const filePath = resolve(cwd ?? ctx.runtime.cwd, input.path);
      const content = await ctx.runtime.readFile(filePath);
      const bytes = Buffer.byteLength(content, "utf-8");

      if (bytes > MAX_BYTES) {
        const truncated = truncateStringToBytesFromStart(content, MAX_BYTES);
        return `${truncated}\n\n[Output truncated: file is ${bytes} bytes, showing first 100KB]`;
      }

      return content;
    },
  });
}

/** Default read tool. Uses ctx.runtime.cwd at execution time. */
export const ReadTool = createReadTool();
