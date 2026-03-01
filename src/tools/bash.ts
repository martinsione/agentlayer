import { z } from "zod";
import { defineTool } from "../define-tool";

export const BashTool = defineTool({
  name: "bash",
  description: "Execute a shell command and return the output.",
  schema: z.object({
    command: z.string().describe("The shell command to execute"),
  }),
  execute: async (input, ctx) => {
    const result = await ctx.runtime.exec(input.command, { signal: ctx.signal });
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
    if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
    return parts.join("\n") || "(no output)";
  },
});
